"""2D layers of the diorama, one value per 1 m cell (D rows x W columns, see aoi.py).

Fuses the LiDAR rasters (prep_lidar.py), the USGS bare-earth DEM (fetch_dem.py), NAIP colour + near-infrared
(fetch_naip.py) and OSM (fetch_osm.py). The 3D fill and the tile export happen band by band in voxelize.py.

The LA County 2023 survey classifies only ground and bridge decks, so:
  buildings  = OSM footprints, with heights and roof shapes from the LiDAR surface
  vegetation = above-ground LiDAR where NAIP NDVI is green or the beam passed through (multiple returns)
  structures = other above-ground LiDAR blobs (sheds, canopies, unmapped buildings)
  decks      = bridge-classified points (freeway overpasses, viaducts) with air underneath
"""
import math
import json
import os

import numpy as np
import rasterio
import rasterio.features
from affine import Affine
from rasterio.enums import Resampling
from rasterio.vrt import WarpedVRT
from scipy import ndimage

from aoi import CACHE, U_MAX, U_MIN, V_MAX, V_MIN
from fetch_dem import grid_transform
from osm import OSM
from palette import (BRICK, C, CLASSIC, GLASS, INDUSTRIAL, JACARANDA, LEAVES, M_BRONZE, M_CLASSIC, M_CONCRETE,
                     M_GLASS, M_ROOF, M_STUCCO, M_WALL, STUCCO, pal, parse_colour, soften, stable_hash)

W, D = int(U_MAX - U_MIN), int(V_MAX - V_MIN)
SLAB = 3


def log(*a):
    print(*a, flush=True)


# ---------------------------------------------------------------- helpers
def burn(target, shapes, all_touched=False):
    shapes = [(s, int(v)) for s, v in shapes if s is not None and not s.is_empty]
    if not shapes:
        return
    m = rasterio.features.rasterize(shapes, out_shape=(D, W), transform=Affine.identity(), fill=0,
                                    all_touched=all_touched, dtype=np.uint16 if max(v for _, v in shapes) < 65536 else np.uint32)
    target[m > 0] = m[m > 0]


def parse_len(s):
    if s is None:
        return None
    try:
        return float(str(s).split(";")[0].strip().split(" ")[0].replace(",", "."))
    except ValueError:
        return None


def tunnelish(t):
    lay = parse_len(t.get("layer")) or 0
    return t.get("tunnel") in ("yes", "building_passage", "culvert") or lay < 0 or t.get("covered") == "yes" \
        or t.get("location") == "underground" or t.get("indoor") == "yes"


def on_bridge(t):
    return t.get("bridge") not in (None, "no") or t.get("man_made") == "bridge"


def naip_on_grid():
    """NAIP (R, G, B, NIR) averaged onto the 1 m grid."""
    with rasterio.open(CACHE / "naip.tif") as src, WarpedVRT(src, crs="EPSG:32611", transform=grid_transform(),
                                                            width=W, height=D, resampling=Resampling.average) as vrt:
        return vrt.read().astype(np.float32)


def wall_clean(dsm):
    """From warsaw-vibe-voxel: DSM samples smeared across vertical walls snap to the roof or the street level,
    so towers don't grow 1 m skirts of partial height."""
    lo = ndimage.minimum_filter(dsm, 7)
    hi = ndimage.maximum_filter(dsm, 7)
    mixed = (hi - lo >= 10) & (dsm - lo >= 3) & (hi - dsm >= 3)
    pad = np.pad(dsm, 1, mode="edge")
    steep = np.zeros(dsm.shape, bool)
    for dr, dc in ((-1, 0), (1, 0), (0, -1), (0, 1)):
        steep |= np.abs(pad[1 + dr:1 + dr + dsm.shape[0], 1 + dc:1 + dc + dsm.shape[1]] - dsm) >= 3
    mixed &= steep
    mixed &= ndimage.maximum_filter(ndimage.grey_opening(dsm, size=(13, 13)), 7) >= hi - 3
    up = mixed & (dsm - lo >= hi - dsm)
    n_up = up.reshape(dsm.shape[0] // 2, 2, dsm.shape[1] // 2, 2).sum((1, 3))
    up &= np.repeat(np.repeat(n_up >= 2, 2, 0), 2, 1)
    log("DSM wall-edge samples snapped:", int(mixed.sum()))
    return np.where(mixed, np.where(up, hi, lo), dsm)


# ---------------------------------------------------------------- building styles
OFFICE = {"office", "commercial", "hotel", "government", "civic", "public", "bank"}
INDUSTRY = {"industrial", "warehouse", "manufacture", "storage_tank", "hangar", "factory"}
HOMES = {"house", "detached", "residential", "apartments", "semidetached_house", "terrace", "bungalow"}


def wall_style(oid, t, h):
    """-> palette id of the facade."""
    col = parse_colour(t.get("building:colour") or t.get("colour"))
    mat = (t.get("building:material") or t.get("material") or "").lower()
    kind = t.get("building") if t.get("building") not in (None, "yes") else t.get("building:part", "yes")
    pick = lambda lst: lst[stable_hash(oid) % len(lst)]
    if mat in ("glass", "mirror") or (col is None and h >= 45 and kind not in HOMES | {"parking"}):
        return pal(soften(col or tuple(int(pick(GLASS)[i:i + 2], 16) for i in (1, 3, 5)), 0.05), M_GLASS)
    if col is not None:
        m = M_STUCCO if (mat in ("plaster", "stucco") or h < 18) else M_WALL
        return pal(soften(col, 0.18), m)
    if mat == "brick":
        return pal(pick(BRICK), M_WALL)
    if mat in ("concrete", "reinforced_concrete") or kind == "parking":
        return pal(pick(INDUSTRIAL), M_CONCRETE if kind == "parking" else M_WALL)
    if mat in ("stone", "limestone", "sandstone", "granite", "marble", "terracotta"):
        return pal(pick(CLASSIC), M_CLASSIC)
    if kind in INDUSTRY:
        return pal(pick(BRICK if stable_hash(oid, "b") % 5 < 2 else INDUSTRIAL), M_WALL)
    if 18 <= h < 45 and kind in OFFICE | {"yes", "retail", "commercial"}:
        # Historic Core: Beaux-Arts terracotta and brick commercial blocks
        return pal(pick(CLASSIC + BRICK[:2]), M_CLASSIC)
    return pal(pick(STUCCO), M_STUCCO)


# ---------------------------------------------------------------- main
def build():
    L = np.load(CACHE / "lidar.npz")
    dtm = np.load(CACHE / "dtm.npy")
    base = math.floor(float(dtm.min())) - SLAB
    g = np.round(ndimage.uniform_filter(dtm, 3) - base).astype(np.int32)  # ground fills z in [0, g)
    log(f"ground: base {base} m, g {g.min()}..{g.max()}")

    dsm = L["dsm"]
    holes = np.isnan(dsm)
    if holes.any():  # 1% of samples saw no return (water, glass): nearest neighbour, else bare earth
        idx = ndimage.distance_transform_edt(holes, return_distances=False, return_indices=True)
        dsm = dsm[tuple(idx)]
    dsm_max = dsm.reshape(D, 2, W, 2).max((1, 3))
    dsm_mean = dsm.reshape(D, 2, W, 2).mean((1, 3))
    nd_b = wall_clean(dsm).reshape(D, 2, W, 2).max((1, 3)) - dtm
    del dsm
    nd_max, nd_mean = dsm_max - dtm, dsm_mean - dtm

    naip = naip_on_grid()
    rgb = np.moveaxis(naip[:3], 0, -1)
    ndvi = (naip[3] - naip[0]) / (naip[3] + naip[0] + 1)
    lum = rgb @ np.array([0.299, 0.587, 0.114], np.float32)
    del naip
    passthru = L["nl1"] / np.maximum(L["n1"], 1)
    log(f"NDVI p10/50/90: {np.percentile(ndvi, [10, 50, 90]).round(2)}")

    osm = OSM()
    log(f"OSM areas {len(osm.areas)}, lines {len(osm.lines)}, nodes {len(osm.nodes)}")

    # ------------------------------------------------ decks (freeway overpasses, viaducts, bridges)
    bmax = L["bmax"]
    deck = np.isfinite(bmax) & (bmax - dtm > 3.0)
    deck = ndimage.binary_closing(deck, iterations=2) & (nd_max > 2.5)
    deck = ndimage.binary_opening(deck, iterations=1)
    lab, n = ndimage.label(deck)
    sizes = ndimage.sum(deck, lab, np.arange(n + 1))
    deck &= sizes[lab] >= 40
    bfill = np.where(np.isfinite(bmax), bmax, np.nan)
    idx = ndimage.distance_transform_edt(~np.isfinite(bfill), return_distances=False, return_indices=True)
    bfill = bfill[tuple(idx)]
    deck_top = np.where(deck, np.round(ndimage.median_filter(bfill, 5) - base), 0).astype(np.int32)
    deck_top = np.maximum(deck_top, g + 3) * deck
    log(f"deck cells: {int(deck.sum())}")

    # ------------------------------------------------ ground surface colours
    gcol = np.full((D, W), C["paving"], np.uint16)
    LANDUSE = {"grass": "lawn", "meadow": "dry", "village_green": "lawn", "flowerbed": "mulch",
               "construction": "dirt", "railway": "ballast", "brownfield": "dirt2", "greenfield": "dry",
               "cemetery": "lawn2", "recreation_ground": "lawn"}
    LEISURE = {"park": "lawn", "garden": "lawn2", "pitch": "turf", "playground": "sand", "dog_park": "dirt",
               "golf_course": "lawn", "track": "track"}
    SURF = {"asphalt": "asphalt", "paving_stones": "paving2", "concrete": "concrete", "concrete:plates": "concrete",
            "gravel": "gravel", "fine_gravel": "gravel", "compacted": "gravel", "grass": "lawn", "ground": "dirt",
            "dirt": "dirt", "sand": "sand", "paved": "paving", "bricks": "brick_pave", "wood": "mulch",
            "artificial_turf": "turf", "tartan": "track", "rubber": "track", "unpaved": "dirt"}
    containers, soft, hard = [], [], []
    for oid, typ, t, geom in osm.areas:
        if tunnelish(t) or "building" in t or "building:part" in t:
            continue
        if t.get("place") == "square" or t.get("highway") == "pedestrian" or t.get("landuse") in ("commercial", "retail"):
            containers.append((geom, C[SURF.get(t.get("surface"), "paving")]))
        if t.get("landuse") in LANDUSE:
            soft.append((geom, C[LANDUSE[t["landuse"]]]))
        if t.get("leisure") in LEISURE:
            soft.append((geom, C[SURF.get(t.get("surface"), LEISURE[t["leisure"]])]))
        if t.get("natural") in ("scrub", "heath", "grassland", "wood", "sand", "bare_rock"):
            soft.append((geom, C[{"sand": "sand", "bare_rock": "gravel"}.get(t["natural"], "dry")]))
        if t.get("amenity") == "parking" and t.get("parking") not in ("underground", "multi-storey", "rooftop"):
            hard.append((geom, C[SURF.get(t.get("surface"), "parking")]))
    containers.sort(key=lambda s: -s[0].area)
    soft.sort(key=lambda s: -s[0].area)
    burn(gcol, containers)
    burn(gcol, soft)
    burn(gcol, hard)

    # OSM soft areas: irrigated lawn or dry gold by NDVI (the LA look: green parks, golden verges)
    soft_ids = np.array([C[k] for k in ("lawn", "lawn2", "dry", "turf")])
    is_soft = np.isin(gcol, soft_ids)
    # (this NAIP scene reads low: trees have median NDVI 0.10, roofs -0.06)
    gcol[is_soft & (ndvi < 0.0)] = C["dry"]
    gcol[is_soft & (ndvi >= 0.0) & (ndvi < 0.1)] = C["olive"]
    # NAIP says vegetation where OSM is silent: low and green
    silent = gcol == C["paving"]
    green = silent & (ndvi > 0.08) & (nd_mean < 0.8)
    green = ndimage.binary_opening(green, iterations=1)
    gcol[green] = np.where(ndvi[green] > 0.18, C["lawn"], C["olive"])
    dryish = silent & ~green & (nd_mean < 0.5) & (ndvi > -0.02) & (rgb[..., 0] > rgb[..., 2] + 18) & (lum > 95)
    dryish = ndimage.binary_opening(dryish, iterations=2)
    gcol[dryish] = C["dirt"]
    log(f"NAIP-detected grass {int(green.sum())}, dirt {int(dryish.sum())} cells")

    HW = {"motorway": 22, "trunk": 16, "primary": 14, "secondary": 12, "tertiary": 10, "unclassified": 8,
          "residential": 8, "living_street": 6, "service": 5, "pedestrian": 6, "footway": 2.5, "path": 2,
          "cycleway": 2.5, "steps": 3, "platform": 3, "track": 3}
    ROADS = {"motorway", "trunk", "primary", "secondary", "tertiary", "unclassified", "residential", "service",
             "living_street", "busway"}
    foot, roads, rails, bridge_lines, lamp_lines = [], [], [], [], []
    marks = []
    crossing_roads = []
    for oid, t, line in osm.lines:
        hw = t.get("highway")
        if t.get("railway") in ("rail", "light_rail", "tram", "subway", "narrow_gauge") and not tunnelish(t):
            if t.get("railway") == "subway":
                continue
            if on_bridge(t):
                bridge_lines.append((line, 2.5, "rail"))
            else:
                rails.append(line)
            continue
        if not hw or tunnelish(t) or hw in ("corridor", "elevator", "proposed", "construction", "bus_stop"):
            continue
        base_hw = hw.replace("_link", "")
        lanes = parse_len(t.get("lanes"))
        w = parse_len(t.get("width")) or (lanes * 3.4 + 1 if lanes and base_hw in ROADS else None) or HW.get(base_hw, 0)
        if base_hw == "service" and t.get("service") in ("parking_aisle", "driveway", "alley"):
            w = 4
        if w <= 0:
            continue
        if on_bridge(t):
            bridge_lines.append((line, w / 2, "road" if base_hw in ROADS or base_hw == "motorway" else "foot"))
            continue
        poly = line.buffer(w / 2, cap_style="flat" if base_hw in ROADS else "round")
        if base_hw in ROADS and base_hw not in ("service", "motorway", "busway") and line.length > 40:
            lamp_lines.append((line, w / 2))
        if base_hw in ROADS:
            roads.append((poly, C[SURF.get(t.get("surface"), "fwy" if base_hw in ("motorway", "trunk") else "asphalt")]))
            crossing_roads.append((oid, t, line, w))
            if base_hw in ("primary", "secondary", "tertiary", "motorway", "trunk") and (lanes or 0) >= 2:
                marks.append((line, t.get("oneway") == "yes"))
        elif hw == "cycleway":
            foot.append((poly, C["cycle"]))
        elif hw in ("footway", "path", "pedestrian", "platform", "track", "steps"):
            foot.append((poly, C[SURF.get(t.get("surface"), "paving")]))
    burn(gcol, foot)
    road_mask = np.zeros((D, W), np.uint16)
    burn(road_mask, [(s, 1) for s, _ in roads])
    burn(gcol, roads)
    # centre lines: LA's double yellow on two-way arterials, white dashes on one-ways and freeways
    from road_markings import build_crosswalk_mask, junction_interiors
    junctions = junction_interiors(crossing_roads)
    mk = []
    for line, oneway in marks:
        if oneway:
            for k in range(0, int(line.length), 12):
                seg = line.interpolate(k), line.interpolate(min(k + 4, line.length))
                mk.append((seg[0].buffer(0.45).union(seg[1].buffer(0.45)).convex_hull, C["mark"]))
        else:
            yellow = line.buffer(0.5, cap_style="flat").difference(junctions)
            if not yellow.is_empty:
                mk.append((yellow, C["mark_y"]))
    burn(gcol, mk)
    crossing_mask, crossing_diagnostics = build_crosswalk_mask(osm.lines, osm.nodes, crossing_roads, road_mask)
    crossing_diagnostics["junctionInteriorArea"] = round(junctions.area, 1)
    log(f"roads {len(roads)}, footways {len(foot)}, crossings {crossing_diagnostics}")

    # rail: ballast bed + dark rails
    rbed = np.zeros((D, W), np.uint16)
    burn(rbed, [(l.buffer(2.0, cap_style="flat"), 1) for l in rails])
    gcol[rbed > 0] = C["ballast"]
    rl = np.zeros((D, W), np.uint16)
    burn(rl, [(l.parallel_offset(0.75, "left").buffer(0.3), 1) for l in rails if l.length > 2] +
         [(l.parallel_offset(0.75, "right").buffer(0.3), 1) for l in rails if l.length > 2], all_touched=True)
    gcol[rl > 0] = C["rail"]

    # LA River: a concrete channel with a green-grey low-flow strip down the middle. Its OSM riverbank outline is
    # cut open by the map box, so the channel comes from the centreline and the terrain instead: low ground within
    # 60 m of the centreline is channel, its flat floor is concrete, ~14 m around the centreline is water
    water_pools = np.zeros((D, W), np.uint16)
    burn(water_pools, [(geom, 1) for oid, typ, t, geom in osm.areas
                       if t.get("natural") == "water" or t.get("water") in ("river", "canal", "basin", "reflecting_pool")])
    cl = np.zeros((D, W), np.uint16)
    burn(cl, [(line.buffer(0.7), 1) for oid, t, line in osm.lines if t.get("waterway") == "river" and not tunnelish(t)],
         all_touched=True)
    dist_cl = ndimage.distance_transform_edt(cl == 0)
    floor_z = ndimage.grey_erosion(dtm, size=61)  # the channel bed near the river
    above_bed = dtm - floor_z
    bed = (dist_cl <= 45) & (above_bed < 1.2) & ~deck
    bed = ndimage.binary_opening(bed, iterations=2)
    lab_, n_ = ndimage.label(bed)  # the bed is one long strip touching the centreline, not a stray low lot
    keep_ = np.unique(lab_[(cl > 0) & bed])
    bed = np.isin(lab_, keep_[keep_ > 0])
    walls = (ndimage.distance_transform_edt(~bed) <= 12) & (dist_cl <= 60) & (above_bed < 7.5) & ~deck
    river = bed | walls
    wet = (bed & (dist_cl <= 7)) | (bed & (dist_cl <= 25) & ((lum < 95) | (ndvi > 0.05)))
    wet = ndimage.binary_closing(wet, iterations=2) & bed
    gcol[river] = C["channel"]
    gcol[wet] = np.where(ndvi[wet] > 0.15, C["reeds"], C["water"])
    pools = (water_pools > 0) & ~river
    gcol[pools] = C["water"]
    log(f"river channel cells {int(river.sum())}, water {int(wet.sum())}, other water {int(pools.sum())}")

    # ------------------------------------------------ buildings (OSM footprints x LiDAR roofs)
    bld_id = np.zeros((D, W), np.uint32)
    blds = [(oid, t, geom) for oid, typ, t, geom in osm.areas
            if t.get("building") not in (None, "no", "roof", "construction") and t.get("location") != "underground"
            and parse_len(t.get("layer", 0)) is not None and (parse_len(t.get("layer", 0)) or 0) >= 0]
    canopies = [(oid, t, geom) for oid, typ, t, geom in osm.areas if t.get("building") == "roof"]
    parts = [(oid, t, geom) for oid, typ, t, geom in osm.areas if "building:part" in t and t["building:part"] != "no"]
    blds.sort(key=lambda b: -b[2].area)
    burn(bld_id, [(geom, k + 1) for k, (oid, t, geom) in enumerate(blds)])
    in_bld = (bld_id > 0) & ~deck
    lab_ids = bld_id[in_bld].astype(np.int64)
    # per-building LiDAR statistics
    nb = len(blds) + 1
    hb = np.where(in_bld, nd_b, 0)
    cnt = np.bincount(lab_ids, minlength=nb)
    hsorted_p90 = np.zeros(nb)
    med = np.zeros(nb)
    order = np.argsort(lab_ids, kind="stable")
    hs = nd_b[in_bld][order]
    ls = lab_ids[order]
    starts = np.searchsorted(ls, np.arange(nb))
    ends = np.searchsorted(ls, np.arange(nb), side="right")
    for k in range(1, nb):
        a, b = starts[k], ends[k]
        if b > a:
            seg = np.sort(hs[a:b])
            med[k] = seg[(b - a) // 2]
            hsorted_p90[k] = seg[int((b - a) * 0.9)]
    top = np.zeros((D, W), np.float32)
    top[in_bld] = hb[in_bld]
    # flat roofs: low roofs within 1.5 m of the building's median snap to it (no 1 m LiDAR noise on parapets)
    medc = med[bld_id.astype(np.int64)]
    snap = in_bld & (medc < 45) & (np.abs(top - medc) < 1.2)
    top[snap] = medc[snap]
    lowroof = in_bld & (medc < 45)
    top = np.where(lowroof, ndimage.median_filter(top, 3), top)
    # OSM height where the LiDAR can't see it: thin spires, buildings finished after the 2023 flight
    osm_h = np.zeros(nb)
    for k, (oid, t, geom) in enumerate(blds, 1):
        h = parse_len(t.get("height")) or ((parse_len(t.get("building:levels")) or 0) * 3.6)
        osm_h[k] = h or 0
        if h and h > hsorted_p90[k] + 8 and (hsorted_p90[k] < 0.35 * h) and cnt[k] > 20:
            m = bld_id == k
            top[m] = h  # built after the flight
    for oid, t, geom in parts:  # needle parts (Wilshire Grand's spire, masts) the LiDAR undersamples
        h = parse_len(t.get("height"))
        if not h or geom.area > 300:
            continue
        m = np.zeros((D, W), np.uint16)
        burn(m, [(geom, 1)], all_touched=True)
        m = (m > 0) & in_bld
        if m.any() and h > np.percentile(top[m], 90) + 8:
            top[m] = np.maximum(top[m], h)
    # footprints without anything standing on them (courtyards mapped as building, misregistered edges)
    bmask = in_bld & (top >= 2.0)
    bmask = ndimage.binary_opening(bmask, iterations=1) | (bmask & (top > 12))
    topi = np.where(bmask, np.round(top), 0).astype(np.int32)
    boti = np.zeros((D, W), np.int32)

    # unmapped structures: tall, not green, not deck, not near a mapped footprint
    near_bld = ndimage.binary_dilation(bld_id > 0, iterations=2)
    veg_vote = (ndvi > 0.05) | (passthru > 0.3)  # the beam passes through foliage, not roofs
    from vegetation import classify_edges
    protected = np.zeros((D, W), np.uint16)
    protected_shapes = [(geom, 1) for _, _, geom in canopies]
    for _, _, tags, geom in osm.areas:
        if tags.get('advertising') not in (None, 'no') or tags.get('man_made') in ('flagpole', 'billboard'):
            protected_shapes.append((geom.buffer(1), 1))
    for _, tags, geom in osm.lines + osm.nodes:
        if tags.get('advertising') not in (None, 'no') or tags.get('man_made') in ('flagpole', 'billboard'):
            protected_shapes.append((geom.buffer(1.5), 1))
    burn(protected, protected_shapes)
    cleanup_enabled = os.environ.get('DTLA_VEGETATION_CLEANUP', '1') != '0'
    if cleanup_enabled:
        supported_trees, attachments, vegetation_diagnostics = classify_edges(
            nd_max, nd_mean, ndvi, passthru, L['n1'], L['low1']-dtm, bld_id > 0,
            excluded=deck | river, protected=protected > 0)
    else:
        supported_trees = np.zeros((D, W), bool)
        attachments = np.zeros((D, W), bool)
        vegetation_diagnostics = dict(crowns=[], supportedCells=0, attachmentCells=0)
    vegetation_diagnostics['enabled'] = cleanup_enabled
    vegetation_diagnostics['rescuedVoteCells'] = int((supported_trees & ~veg_vote).sum())
    attachment_top = np.zeros((D, W), np.int32)
    attachment_bot = np.zeros((D, W), np.int32)
    if attachments.any():
        attachment_top[attachments] = np.floor(nd_max[attachments]).astype(np.int32)+1
        attachment_bot[attachments] = np.floor((L['low1']-dtm)[attachments]).astype(np.int32)
    veg_vote |= supported_trees
    struct = (~near_bld) & (~deck) & (nd_b > 3.0) & ~veg_vote & ~river & ~attachments
    struct = ndimage.binary_opening(struct, iterations=1)
    lab, n = ndimage.label(struct)
    sizes = ndimage.sum(struct, lab, np.arange(n + 1))
    struct &= sizes[lab] >= 40
    # beside a deck, an unmapped structure is the bridge's own superstructure (the 6th St Viaduct's arches),
    # standing over air: only its top is drawn
    bridge_area = np.zeros((D, W), np.uint16)
    burn(bridge_area, [(geom, 1) for oid, typ, t, geom in osm.areas if t.get("man_made") == "bridge"])
    rib = struct & ((ndimage.distance_transform_edt(~deck) <= 8) | (bridge_area > 0))
    struct &= ~rib
    log(f"buildings {len(blds)} OSM ({int(bmask.sum())} cells), unmapped structures {int(struct.sum())} cells")
    # OSM building=roof (canopies, carports, gas-station roofs): a roof slab with air under it
    canopy = np.zeros((D, W), np.uint16)
    burn(canopy, [(geom, 1) for oid, t, geom in canopies])
    canopy = (canopy > 0) & ~bmask & (nd_b > 2.5) & ~deck

    # facade and roof colours
    wallc = np.zeros(nb, np.uint16)
    for k, (oid, t, geom) in enumerate(blds, 1):
        wallc[k] = wall_style(oid, t, max(med[k], osm_h[k] if hsorted_p90[k] < 3 else 0))
    basewall = wallc[bld_id.astype(np.int64)]
    slab, _ = ndimage.label(struct)
    struct_cols = np.array([pal(INDUSTRIAL[i], M_WALL) for i in range(len(INDUSTRIAL))], np.uint16)
    basewall[struct] = struct_cols[slab[struct] % len(INDUSTRIAL)]
    # parts with their own colour or material
    for oid, t, geom in parts:
        if not (t.get("building:colour") or t.get("building:material") or t.get("colour")):
            continue
        m = np.zeros((D, W), np.uint16)
        burn(m, [(geom, 1)])
        m = (m > 0) & bmask
        if m.any():
            basewall[m] = wall_style(oid, t, float(np.median(top[m])))
    struct_top = np.where(struct, np.round(nd_b), 0).astype(np.int32)
    topi = np.where(struct, struct_top, topi)
    bmask |= struct

    # roofs: OSM roof:colour, else NAIP (LA's cool white roofs, terracotta tiles); towers lean in NAIP, so default
    roofc = np.zeros((D, W), np.uint16)
    bl = bld_id.astype(np.int64)
    rgb_b = rgb[bmask]
    lum_b = lum[bmask]
    ids_b = np.where(struct[bmask], 0, bl[bmask])
    acc = np.zeros((nb, 3))
    nacc = np.zeros(nb)
    bright = lum_b > 70  # skip tower shadows
    np.add.at(acc, ids_b[bright], rgb_b[bright])
    np.add.at(nacc, ids_b[bright], 1)
    rc = np.zeros(nb, np.uint16)
    for k in range(nb):
        t = blds[k - 1][1] if k else {}
        col = parse_colour(t.get("roof:colour"))
        if col:
            rc[k] = pal(soften(col), M_ROOF, q=8)
        elif k and nacc[k] >= 4 and med[k] < 40:
            r, gg, b = acc[k] / nacc[k]
            # lift and desaturate a little: NAIP is darker and greener than the roofs look from the street
            m_ = (r + gg + b) / 3
            r, gg, b = (m_ + (v - m_) * 0.75 for v in (r, gg, b))
            r, gg, b = (min(255, v * 1.12 + 12) for v in (r, gg, b))
            r, b = min(255, r + 8), b - 6  # sun-warmed: the sky light turns flat roofs blue from above
            rc[k] = pal(soften((r, gg, b), 0.22), M_ROOF, q=8)
        else:
            rc[k] = C["roof_tower"] if med[k] >= 40 else C["roof_default"]
    roofc = rc[np.where(struct, 0, bl)]
    green_roof = bmask & (ndvi > 0.15) & (topi < 40)
    green_roof = ndimage.binary_opening(green_roof, iterations=1)
    roofc[green_roof] = C["garden_roof"]

    # ------------------------------------------------ vegetation: canopy segments, palms
    veg = (~bmask) & (~deck) & (~canopy) & (nd_mean > 2.0) & veg_vote & ~river & ~attachments
    veg &= ~(ndimage.binary_dilation(bmask & (topi > 6), iterations=1) & (nd_mean > 6) & ~supported_trees)
    veg = ndimage.binary_opening(veg, iterations=1) | (veg & (nd_max > 8))
    chm = np.where(veg, np.minimum(nd_max, 35), 0).astype(np.float32)
    peaks = (chm == ndimage.maximum_filter(chm, 5)) & (chm > 3)
    mk_lab, npk = ndimage.label(peaks)
    inv = np.clip(255 - chm * 7, 0, 255).astype(np.uint8)
    seg = ndimage.watershed_ift(inv, np.where(veg, mk_lab, 0).astype(np.int32))
    seg = np.where(veg, seg, 0)
    ids = np.arange(npk + 1)
    area = ndimage.sum(veg, seg, ids)
    hmax = ndimage.maximum(chm, seg, ids)
    pk = ndimage.maximum_position(chm, seg, ids)
    ndv = ndimage.mean(ndvi, seg, ids)
    lm = ndimage.mean(lum, seg, ids)
    # palms: a small crown standing alone on a tall bare trunk. Big trees are over-segmented into small
    # crowns too, but those touch neighbouring crowns of similar height; a palm's crown is surrounded by low air
    touch = np.zeros(npk + 1)
    perim = np.zeros(npk + 1)
    for sh in ((0, 1), (1, 0), (0, -1), (-1, 0)):
        nb_seg = np.roll(seg, sh, (0, 1))
        nb_chm = np.roll(chm, sh, (0, 1))
        edge = (seg > 0) & (nb_seg != seg)
        a_ = seg[edge]
        np.add.at(perim, a_, 1)
        np.add.at(touch, a_, nb_chm[edge] > 0.5 * hmax[a_])
    # glass facades scatter the beam into multiple returns too: crowns that aren't green and hug a wall are facade
    # noise (median 2 m from a building, NDVI -0.06), not trees
    dist_b = ndimage.distance_transform_edt(~bmask)
    d_b = np.array([dist_b[p] if i else 0.0 for i, p in enumerate(pk)])
    junk = (ids > 0) & (((ndv < 0.0) & (d_b < 4)) | (area < 2) | ((ndv < -0.04) & (hmax > 25)))
    # catenary masts, light poles, sign posts: tiny crowns that are barely green
    junk |= (ids > 0) & (area <= 3) & (ndv < 0.15)
    # light-pole heads and bridge hardware over lawns: small and solid (foliage lets the beam through)
    ptm = ndimage.mean(passthru, seg, ids)
    junk |= (ids > 0) & (area <= 8) & (ptm < 0.3)
    # Whole-crown evidence can rescue spectrally dark interiors that the
    # old per-cell vote incorrectly filled as solid structures.
    supported_fraction = ndimage.mean(supported_trees, seg, ids)
    junk &= ~(supported_fraction >= .5)
    near_br = (ndimage.distance_transform_edt(~deck) <= 10) | (bridge_area > 0)
    junk |= (ids > 0) & ndimage.maximum(near_br, seg, ids).astype(bool) & (ndv < 0.15)
    seg = np.where(junk[seg], 0, seg)
    veg &= seg > 0
    on_rail = np.isin(gcol, [C["ballast"], C["rail"]])
    rail_seg = ndimage.maximum(on_rail, seg, ids).astype(bool)  # rail-yard light masts look like palms
    palm = (area >= 4) & (area <= 30) & (hmax >= 9) & (hmax <= 28) & (ndv > 0.04) & (d_b >= 3) & ~junk & ~rail_seg         & (touch <= 0.2 * np.maximum(perim, 1))
    log(f"facade-noise crowns dropped: {int(junk.sum())}")
    log(f"tree crowns {npk}, palms {int(palm.sum())}")

    # crowns: dome undersides; palms are handled as sprites in voxelize.py
    R = np.sqrt(np.maximum(area, 1) / math.pi)
    pr = np.array([p[0] for p in pk], np.float32)
    pc = np.array([p[1] for p in pk], np.float32)
    rr, cc = np.nonzero(seg > 0)
    sidx = seg[rr, cc]
    d = np.hypot(rr - pr[sidx], cc - pc[sidx]) / np.maximum(R[sidx], 1)
    hh = chm[rr, cc]
    # crowns about as tall as they are wide (a narrow crown on a tall pole is not a 10 m green column)
    depth = np.minimum(0.6 * hmax[sidx], 2.4 * R[sidx] + 1.0)
    thick = np.maximum(1.5, depth * np.sqrt(np.clip(1 - (d * 0.85) ** 2, 0, 1)))
    crown_top = np.zeros((D, W), np.int32)
    crown_bot = np.zeros((D, W), np.int32)
    nonpalm = ~palm[sidx]
    crown_top[rr[nonpalm], cc[nonpalm]] = np.round(hh[nonpalm]).astype(np.int32)
    crown_bot[rr[nonpalm], cc[nonpalm]] = np.maximum(1, np.round(hh[nonpalm] - thick[nonpalm])).astype(np.int32)
    lbin = np.clip(((lm - 45) / 90 * 5).astype(int), 0, 4)
    dusty = (ndv < 0.1).astype(int)  # sage/eucalyptus vs deep irrigated green
    leaf_of = np.array(LEAVES, np.uint16)[(4 - lbin) + 5 * (1 - dusty)]
    jac = (np.array([stable_hash("jac", i) % 23 for i in ids]) == 0) & ~palm & (hmax > 6) & (hmax < 14)
    leaf_of[jac] = JACARANDA
    leafc = np.zeros((D, W), np.uint16)
    leafc[rr[nonpalm], cc[nonpalm]] = leaf_of[sidx[nonpalm]]
    trunks = [(int(pk[i][0]), int(pk[i][1]), int(crown_bot[pk[i]])) for i in range(1, npk + 1)
              if not palm[i] and not junk[i] and area[i] >= 3 and crown_bot[pk[i]] > 1]
    palms = [(int(pk[i][0]), int(pk[i][1]), int(round(hmax[i])), int(stable_hash("palm", i) % 4))
             for i in range(1, npk + 1) if palm[i]]
    # OSM trees with palm genera where the LiDAR saw no crown (planted after the flight, or slim and missed)
    palm_genera = ("washingtonia", "phoenix", "syagrus", "archontophoenix", "trachycarpus")
    for oid, t, pt in osm.nodes:
        if t.get("natural") != "tree":
            continue
        name = " ".join(t.get(k, "") for k in ("genus", "species", "taxon", "species:en", "leaf_type")).lower()
        r_, c_ = int(pt.y), int(pt.x)
        if 0 <= r_ < D and 0 <= c_ < W and any(p in name for p in palm_genera) and chm[r_, c_] < 3 and not bmask[r_, c_]:
            palms.append((r_, c_, int(parse_len(t.get("height")) or 14), stable_hash(oid) % 4))

    # Allocate landmark colours last, preserving every existing generic palette index.
    from landmark_overrides import apply_landmark_overrides
    landmark_info = apply_landmark_overrides(osm.areas, bmask, g, topi, basewall, roofc, measured_top=nd_max)
    for diagnostic in landmark_info["diagnostics"]:
        log("landmark:", diagnostic)
    # Verified facade colours append after pattern assignment; geometry and ordinary roofs stay authoritative.
    from facade_colors import apply_facade_colors
    facade_diagnostics = apply_facade_colors(osm.areas, bmask, basewall, roofc)
    for diagnostic in facade_diagnostics:
        log("facade colour:", diagnostic)
    attachment_material = np.zeros((D, W), np.uint16)
    # A matte structural surface, without invented windows or a guessed feature identity.
    attachment_material[attachments] = C['roof_default']
    audit_dir = CACHE/'vegetation-review'
    audit_dir.mkdir(parents=True, exist_ok=True)
    (audit_dir/'classification.json').write_text(json.dumps(vegetation_diagnostics, indent=2), encoding='utf-8')
    log('vegetation edge cleanup:', {k:v for k,v in vegetation_diagnostics.items() if k != 'crowns'})
    # Paint allocation/application waits until authored model materials are prepared.
    crossing_underlay = gcol.copy()

    # ground under crowns keeps its class; under trees on paving, a darker tree-pit
    return dict(base=base, g=g, gcol=gcol, bmask=bmask, topi=topi, boti=boti, basewall=basewall, roofc=roofc,
                vegetationDiagnostics={k:v for k,v in vegetation_diagnostics.items() if k != 'crowns'},
                attachment_top=attachment_top, attachment_bot=attachment_bot, attachment_material=attachment_material,
                landmarkStyles=landmark_info["styles"], landmarkDiagnostics=landmark_info["diagnostics"],
                facadeDiagnostics=facade_diagnostics,
                roofMeasuredAbsolute=nd_b + dtm,
                roofBuildingId=bld_id,
                roadMarkingDiagnostics=crossing_diagnostics,
                crosswalkMask=crossing_mask, crosswalkUnderlay=crossing_underlay,
                roadPaletteIds=sorted({colour for _, colour in roads}),
                canopy=canopy, canopy_top=np.where(canopy, np.round(nd_b), 0).astype(np.int32),
                deck=deck, deck_top=deck_top, nd_b=nd_b, crown_top=crown_top, crown_bot=crown_bot, leafc=leafc,
                rib=rib, rib_top=np.where(rib, np.round(nd_b), 0).astype(np.int32), trunks=trunks, palms=palms, bridge_lines=bridge_lines, lamp_lines=lamp_lines, osm=osm, blds=blds, med=med, dtm=dtm)
