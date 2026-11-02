"""Fill the 1 m voxel volume band by band and write the streaming tiles, terrain.bin and meta.json.

Warsaw's pipeline held the whole volume in memory (~26 GB); here each band of 128 rows (+1 apron row each side)
is filled from the 2D layers (layers.py), written out as level-1 tiles, and downsampled into the coarse levels
(2, 4, 8 m) kept in memory, so the peak stays around 3-4 GB.

Volume axes: vol[z, row, col]. Tile format: see tiles.py (unchanged from warsaw-vibe-voxel).
"""
import gzip
import json
import math
import time

import numpy as np
from PIL import Image
from scipy import ndimage

from aoi import CACHE, CENTER_LATLON, GRID_DEG, ROOT, WEB_DATA, lonlat_to_uv, U_MIN, V_MAX
from layers import D, W, build, log
from landmarks import LANDMARKS
from palette import C, LEAVES, PALM_FRONDS, PALM_SKIRT, JACARANDA, pal
from tiles import N, column_runs, downsample, thin_voxels

DBG = CACHE / "debug"


# ---------------------------------------------------------------- sprites: voxels that aren't simple columns
def palm_voxels(r, c, h, variant, g):
    """A fan palm: a 1-voxel trunk, a skirt of dry fronds (Washingtonia) and a star of drooping fronds."""
    out = []
    z0 = g[r, c] + max(h - 2, 3)
    for z in range(g[r, c], z0):
        out.append((r, c, z, C["palm_trunk"]))
    frond = PALM_FRONDS[variant % len(PALM_FRONDS)]
    if variant < 2:  # Washingtonia: shaggy skirt of dead fronds under the crown
        for z in range(z0 - 3, z0):
            for dr, dc in ((0, 1), (1, 0), (0, -1), (-1, 0)):
                out.append((r + dr, c + dc, z, PALM_SKIRT))
    out.append((r, c, z0, frond))
    out.append((r, c, z0 + 1, frond))
    for dr, dc in ((0, 1), (1, 0), (0, -1), (-1, 0), (1, 1), (1, -1), (-1, 1), (-1, -1)):
        reach = 3 if dr == 0 or dc == 0 else 2
        for k in range(1, reach + 1):
            out.append((r + dr * k, c + dc * k, z0 - (1 if k == reach else 0), frond))
    return out


def pier_voxels(deck, deck_top, g, bridge_lines):
    """Bents under the decks: pairs of 2x2 columns every 28 m along each bridge way."""
    out = []
    for line, hw, kind in bridge_lines:
        if line.length < 30:
            continue
        for k in np.arange(14, line.length - 10, 28.0):
            p = line.interpolate(k)
            q = line.interpolate(min(k + 1, line.length))
            dx, dy = q.x - p.x, q.y - p.y
            n = math.hypot(dx, dy) or 1
            nx, ny = -dy / n, dx / n
            offs = (0.0,) if hw < 5 else (-hw * 0.55, hw * 0.55)
            for o in offs:
                cx, cy = int(p.x + nx * o), int(p.y + ny * o)
                for rr in (cy, cy + 1):
                    for cc in (cx, cx + 1):
                        if 0 <= rr < D and 0 <= cc < W and deck[rr, cc]:
                            for z in range(g[rr, cc], deck_top[rr, cc] - 2):
                                out.append((rr, cc, z, C["pier"]))
    return out


def lamp_voxels(Lr, g):
    """Street lights every 36 m on both kerbs of every street (OSM maps almost none in DTLA): a 1-voxel pole and
    an emissive head reaching over the road. -> (voxels, lamp positions for meta.json)."""
    out, lamps = [], []
    blocked = Lr["bmask"] | Lr["deck"] | (Lr["crown_top"] > 0)
    taken = set()
    for line, hw in Lr["lamp_lines"]:
        for side in (-1, 1):
            for k in np.arange(12, line.length - 6, 36.0):
                p = line.interpolate(k)
                q = line.interpolate(min(k + 1, line.length))
                dx, dy = q.x - p.x, q.y - p.y
                n = math.hypot(dx, dy) or 1
                nx, ny = -dy / n * side, dx / n * side
                c, r = int(p.x + nx * (hw + 1.0)), int(p.y + ny * (hw + 1.0))
                if not (0 <= r < D and 0 <= c < W) or blocked[r, c] or (r // 12, c // 12) in taken:
                    continue
                taken.add((r // 12, c // 12))
                z0 = int(g[r, c])
                for z in range(z0, z0 + 7):
                    out.append((r, c, z, C["pole"]))
                hr, hc = int(round(r - ny)), int(round(c - nx))  # the head leans over the road
                if 0 <= hr < D and 0 <= hc < W:
                    out.append((hr, hc, z0 + 7, C["lamp"]))
                    lamps.append([hc, hr, z0 + 7])
    return out, lamps


# ---------------------------------------------------------------- band fill
def fill_band(Lr, r0, r1, H, sprites):
    """Volume rows [r0, r1) (may run past the map: those rows stay empty). -> (H, r1 - r0, W) uint16."""
    R = r1 - r0
    vol = np.zeros((H, R, W), np.uint16)
    a, b = max(r0, 0), min(r1, D)
    if a >= b:
        return vol
    o = a - r0
    sl = lambda k: Lr[k][a:b]
    g, gcol = sl("g"), sl("gcol")
    bm, topi, boti, wall, roof = sl("bmask"), sl("topi"), sl("boti"), sl("basewall"), sl("roofc")
    dk, dtop = sl("deck"), sl("deck_top")
    ct, cb, leaf = sl("crown_top"), sl("crown_bot"), sl("leafc")
    can, cant = sl("canopy"), sl("canopy_top")
    nd_b = sl("nd_b")
    rib, ribt = sl("rib"), sl("rib_top")
    view = vol[:, o:o + (b - a)]
    zb, zt = g + boti, g + topi
    dbot = dtop - 2
    # what stands on the decks (6th St Viaduct arches, sign gantries): white concrete above the roadway
    above = dk & (nd_b + g - dtop >= 3)
    above = ndimage.binary_opening(above, iterations=1)
    above_top = np.where(above, np.round(g + nd_b).astype(np.int32), 0)
    edge = dk & ~ndimage.binary_erosion(dk, iterations=1, border_value=1)
    for z in range(H):
        sl_ = view[z]
        m = z < g - 1
        if not m.any() and z > g.max():
            pass
        sl_[m] = C["soil"]
        sl_[z == g - 1] = gcol[z == g - 1]
        m = bm & (z >= zb) & (z < zt)
        sl_[m] = wall[m]
        m = bm & (z == zt - 1)
        sl_[m] = roof[m]
        m = can & (z == g + cant - 1)
        sl_[m] = C["roof_default"]
        m = dk & (z >= dbot) & (z < dtop)
        sl_[m] = C["deck_side"]
        m = dk & (z == dtop - 1) & ~edge
        sl_[m] = C["deck"]
        m = edge & (z == dtop)
        sl_[m] = C["barrier"]
        m = above & (z >= np.maximum(dtop, above_top - 2)) & (z < above_top)  # arch ribs: their top 2 m only
        sl_[m] = C["viaduct"]
        m = rib & (z >= g + ribt - 3) & (z < g + ribt)
        sl_[m] = C["viaduct"]
        m = (ct > 0) & (z >= g + cb) & (z < g + ct)
        sl_[m] = leaf[m]
    # sprites (trunks, palms, piers) inside these rows
    rows = sprites[:, 0]
    k = (rows >= a) & (rows < b)
    s = sprites[k]
    ok = (s[:, 2] >= 0) & (s[:, 2] < H)
    s = s[ok]
    vol[s[:, 2], s[:, 0] - r0, s[:, 1]] = s[:, 3]
    return vol


def write_tile(path, win, gw, extra=b""):
    counts, runs = column_runs(win)
    with gzip.GzipFile(path, "wb", compresslevel=9, mtime=0) as fh:
        fh.write(counts.tobytes() + gw.tobytes() + runs.tobytes() + extra)
    return len(runs)


def tile_window(vs, gs, r0, c0, Hs):
    """(Hs, N+2, N+2) window of a (Hs, rows, cols) array whose row 0 is global row r0, at column c0 (may be -1)."""
    Ds, Ws = vs.shape[1], vs.shape[2]
    win = np.zeros((Hs, N + 2, N + 2), np.uint16)
    gw = np.zeros((N + 2, N + 2), np.uint8)
    rr0, rr1, cc0, cc1 = max(r0, 0), min(r0 + N + 2, Ds), max(c0, 0), min(c0 + N + 2, Ws)
    if rr0 < rr1 and cc0 < cc1:
        win[:, rr0 - r0:rr1 - r0, cc0 - c0:cc1 - c0] = vs[:, rr0:rr1, cc0:cc1]
        gw[rr0 - r0:rr1 - r0, cc0 - c0:cc1 - c0] = np.clip(gs[rr0:rr1, cc0:cc1], 0, 255)
    top = int(np.nonzero(win.reshape(Hs, -1).any(1))[0].max()) + 1 if win.any() else 1
    return win[:top], gw


def main():
    t0 = time.time()
    Lr = build()
    log(f"layers built in {time.time() - t0:.0f}s")
    g = Lr["g"]
    base = Lr["base"]

    trunk_v = []
    for r, c, zb in Lr["trunks"]:
        for z in range(g[r, c], g[r, c] + zb):
            trunk_v.append((r, c, z, C["trunk"]))
    palm_v = []
    for r, c, h, var in Lr["palms"]:
        palm_v += palm_voxels(r, c, h, var, g)
    pier_v = pier_voxels(Lr["deck"], Lr["deck_top"], g, Lr["bridge_lines"])
    lamp_v, lamps = lamp_voxels(Lr, g)
    sprites = np.array(trunk_v + palm_v + pier_v + lamp_v, np.int64).reshape(-1, 4)
    sprites = sprites[(sprites[:, 0] >= 0) & (sprites[:, 0] < D) & (sprites[:, 1] >= 0) & (sprites[:, 1] < W)]
    log(f"sprites: {len(trunk_v)} trunk, {len(palm_v)} palm, {len(pier_v)} pier voxels, {len(lamps)} street lamps")

    H = int(max((g + Lr["topi"]).max(), Lr["deck_top"].max() + 1, (g + Lr["crown_top"]).max(),
                (g + np.round(Lr["nd_b"])).max() if Lr["deck"].any() else 0, sprites[:, 2].max() + 1)) + 4
    H = min(H, 450)
    log(f"volume height H={H}")

    fol_ids = sorted(set(LEAVES) | set(PALM_FRONDS) | {PALM_SKIRT, JACARANDA, C["trunk"], C["palm_trunk"], C["reeds"]})
    grass_ids = sorted({C[k] for k in ("lawn", "lawn2", "dry", "dry2", "olive", "turf", "garden_roof")})
    is_fol = np.zeros(65536, bool); is_fol[fol_ids] = True; is_fol[grass_ids] = True
    is_grass = np.zeros(65536, bool); is_grass[grass_ids] = True

    out = WEB_DATA / "tiles"
    for s in ("1", "1f", "2", "4", "8"):
        (out / s).mkdir(parents=True, exist_ok=True)
        for f in (out / s).glob("*.bin"):
            f.unlink()
    nx1, ny1 = -(-W // N), -(-D // N)
    coarse = {s: np.zeros((-(-H // s), -(-D // s), -(-W // s)), np.uint16) for s in (2, 4, 8)}
    thin = [[], [], [], []]
    top_rgb = np.zeros((D, W), np.uint16)  # topmost palette id per column, for the debug image
    stats = dict(runs=0, bytes=0, fbytes=0)
    for ty in range(ny1):
        r0 = ty * N - 1
        band = fill_band(Lr, r0, r0 + N + 2, H, sprites)
        gband = np.zeros((N + 2, W), np.int32)  # ground rows aligned with the band (zero past the map)
        a, b = max(r0, 0), min(r0 + N + 2, D)
        gband[a - r0:b - r0] = g[a:b]
        core = band[:, 1:N + 1]
        nrows = min(N, D - ty * N)
        core = core[:, :nrows]
        # thin structures (palm trunks, piers' edges, spires) for the coarse levels' detail voxels
        # palm trunks stay as thin detail at coarse levels: they are the skyline's palms
        tz, tr, tc, tv = thin_voxels(band, [i for i in fol_ids if i != C["palm_trunk"]], (C["lamp"],), lambda *_: None)
        k = (tr >= 1) & (tr < 1 + nrows)
        for lst, arr in zip(thin, (tz[k], tr[k] - 1 + ty * N, tc[k], tv[k])):
            lst.append(arr)
        for s in (2, 4, 8):
            coarse[s][:, ty * N // s: ty * N // s + -(-nrows // s)] = downsample(core, s)
        nz = core != 0
        zi = H - 1 - np.argmax(nz[::-1], axis=0)
        top_rgb[ty * N: ty * N + nrows] = np.take_along_axis(core, zi[None], 0)[0]
        # level 1: buildings/ground in tiles/1, foliage + grass in tiles/1f
        for tx in range(nx1):
            c0 = tx * N - 1
            win, gw = tile_window(band, gband, 0, c0, H)
            f = is_fol[win]
            fol = np.where(f, win, 0).astype(np.uint16)
            win = np.where(f, np.where(is_grass[win], C["bare"], 0), win).astype(np.uint16)
            write_tile(out / "1f" / f"{tx}_{ty}.bin", fol, gw)
            stats["runs"] += write_tile(out / "1" / f"{tx}_{ty}.bin", win, gw)
            stats["fbytes"] += (out / "1f" / f"{tx}_{ty}.bin").stat().st_size
            stats["bytes"] += (out / "1" / f"{tx}_{ty}.bin").stat().st_size
        log(f"band {ty + 1}/{ny1} done, {time.time() - t0:.0f}s")
        del band, core
    log(f"tiles level 1: {nx1}x{ny1}, {stats['runs']} runs, {stats['bytes'] / 2**20:.1f} MB + foliage {stats['fbytes'] / 2**20:.1f} MB")

    tz, tr, tc, tv = (np.concatenate(x) for x in thin)
    levels = [dict(s=1, nx=nx1, ny=ny1)]
    total = stats["bytes"]
    for s in (2, 4, 8):
        vs = coarse[s]
        gs = g[::s, ::s]
        Hs, Ds, Ws = vs.shape
        nx, ny = -(-Ws // N), -(-Ds // N)
        if s < 8:
            lost = vs[tz // s, tr // s, tc // s] == 0
            dz, dr, dc, dv = tz[lost], tr[lost], tc[lost], tv[lost]
            dnode = (dr // s // N) * nx + dc // s // N
        tot = 0
        for ty in range(ny):
            for tx in range(nx):
                win, gw = tile_window(vs, gs, ty * N - 1, tx * N - 1, Hs)
                extra = b""
                if s < 8:
                    k = dnode == ty * nx + tx
                    extra = np.stack([dc[k] - tx * N * s, dr[k] - ty * N * s, dz[k], dv[k]], 1).astype(np.uint16).tobytes()
                write_tile(out / str(s) / f"{tx}_{ty}.bin", win, gw, extra)
                tot += (out / str(s) / f"{tx}_{ty}.bin").stat().st_size
        levels.append(dict(s=s, nx=nx, ny=ny))
        total += tot
        log(f"tiles level {s}: {nx}x{ny}, {tot / 2**20:.1f} MB")
    del coarse

    # terrain.bin: ground every 4 m (decimetres above base) + its top colour every 2 m, grass as bare earth
    gg = g.astype(np.float32)
    h = np.round(ndimage.uniform_filter(gg, 4)[::4, ::4] * 10).astype(np.uint16)
    pal_rgb = np.array([e[:3] for e in pal.entries], np.uint8)
    gc = Lr["gcol"].copy()
    gc[is_grass[gc]] = C["bare"]
    tc_ = np.ascontiguousarray(pal_rgb[gc[1::2, 1::2]])
    with gzip.GzipFile(WEB_DATA / "terrain.bin", "wb", compresslevel=9, mtime=0) as fh:
        fh.write(h.tobytes())
        fh.write(tc_.tobytes())

    # labels and views
    labels = make_labels(Lr, g)
    views = make_views(g)
    meta = dict(W=W, D=D, H=H, base=base, theta_deg=GRID_DEG, crs="EPSG:32611", center=list(CENTER_LATLON),
                tiles=dict(N=N, levels=levels, bytes=total), palette=[list(e) for e in pal.entries], lamps=lamps,
                labels=labels, views=views, landmarkStyles=Lr["landmarkStyles"],
                landmarkDiagnostics=Lr["landmarkDiagnostics"],
                sources=dict(osm="OpenStreetMap contributors (ODbL), fetched via Overpass",
                             lidar="USGS 3DEP CA_LosAngeles_1_B23 (2023) point cloud and 1 m DEM",
                             ortho="USDA NAIP 2022, 0.6 m"))
    from obstruction_lights import enrich_metadata
    enrich_metadata(meta, osm=Lr["osm"])
    (WEB_DATA / "meta.json").write_text(json.dumps(meta, ensure_ascii=False), encoding="utf-8")
    log(f"palette entries: {len(pal.entries)}; meta.json written; total tiles {total / 2**20:.1f} MB")

    DBG.mkdir(parents=True, exist_ok=True)
    Image.fromarray(pal_rgb[top_rgb][::2, ::2]).save(DBG / "topdown.png")
    log(f"VOXELIZE DONE in {time.time() - t0:.0f}s")


def make_labels(Lr, g):
    """Landmarks from landmarks.py, positioned on their OSM feature when one carries the name."""
    from shapely.geometry import Point
    from shapely.ops import unary_union
    from rasterio.features import rasterize
    from affine import Affine
    osm = Lr["osm"]
    area_by_identity = {(typ, oid): geom for oid, typ, _, geom in osm.areas}
    landmark_geometries = {}
    for diagnostic in Lr.get("landmarkDiagnostics", []):
        if diagnostic.get("status") != "applied":
            continue
        geometries = [area_by_identity[tuple(identity)] for identity in diagnostic.get("identities", [])
                      if tuple(identity) in area_by_identity]
        if geometries:
            landmark_geometries[diagnostic["key"]] = unary_union(geometries)
    named = {}  # name -> every OSM feature carrying it
    for oid, typ, t, geom in osm.areas:
        for key in ("name", "name:en", "alt_name", "official_name"):
            if key in t:
                named.setdefault(t[key].lower(), []).append(geom)
    for oid, t, pt in osm.nodes:
        if "name" in t:
            named.setdefault(t["name"].lower(), []).append(pt)
    out = []
    topi, bm = Lr["topi"], Lr["bmask"]
    for lm in LANDMARKS:
        u, v = lonlat_to_uv(lm["lon"], lm["lat"])
        fx, fy = u - U_MIN, V_MAX - v
        ref = Point(fx, fy)
        # the feature with the name nearest the reference point, if within 250 m (names repeat: a bank branch,
        # a bus stop, a bridge whose centre lies off the map)
        cands = [g_ for n in [lm["name"]] + lm.get("osm", []) for g_ in named.get(n.lower(), []) if not g_.is_empty]
        geom = landmark_geometries.get(lm.get("landmark_key"))
        if geom is None:
            geom = min(cands, key=lambda g_: g_.distance(ref), default=None)
        if geom is not None and geom.distance(ref) < 250:
            p = geom if geom.geom_type == "Point" else geom.intersection(ref.buffer(250)).representative_point()
            x, y = p.x, p.y
            R = math.sqrt(geom.area / math.pi) if geom.area else 3
        else:
            geom, x, y, R = None, fx, fy, 10
        c, r = int(x), int(y)
        if not (0 <= r < D and 0 <= c < W):
            continue
        # anchor above the highest point of the footprint (a tower's roof, not its podium edge)
        if geom is not None and geom.area > 0 and geom.area < 40000:
            b0 = geom.bounds
            r0, r1 = max(int(b0[1]), 0), min(int(b0[3]) + 1, D)
            c0, c1 = max(int(b0[0]), 0), min(int(b0[2]) + 1, W)
        else:
            r0, r1, c0, c1 = max(r - 15, 0), min(r + 16, D), max(c - 15, 0), min(c + 16, W)
        heights = g[r0:r1, c0:c1] + np.where(bm[r0:r1, c0:c1], topi[r0:r1, c0:c1], 0)
        if lm.get("landmark_key") in landmark_geometries and geom is not None and 0 < geom.area < 40000:
            footprint = rasterize([(geom, 1)], out_shape=heights.shape,
                                  transform=Affine.translation(c0, r0), dtype="uint8").astype(bool)
            z = int(heights[footprint].max() if footprint.any() else g[r, c]) + 6
        else:
            z = int(heights.max()) + 6
        e = {k: v for k, v in lm.items() if k not in ("lat", "lon", "osm", "landmark_key")}
        e.update(x=c, y=r, z=z, g=int(g[r, c]), R=round(R, 1))
        out.append(e)
    log(f"labels: {len(out)} of {len(LANDMARKS)}")
    return out


def make_views(g):
    def at(lat, lon):
        u, v = lonlat_to_uv(lon, lat)
        c, r = u - U_MIN, V_MAX - v
        return c, r, int(g[min(max(int(r), 0), D - 1), min(max(int(c), 0), W - 1)])

    def view(label, tgt, dist, elev_deg, bearing_deg, lift=0):
        """Camera `dist` metres from the target, toward compass bearing `bearing_deg`, `elev_deg` above it."""
        c, r, gz = tgt
        b, e = math.radians(bearing_deg), math.radians(elev_deg)
        east, north = math.sin(b), math.cos(b)
        th = math.radians(GRID_DEG)
        du = east * math.cos(th) + north * math.sin(th)
        dv = -east * math.sin(th) + north * math.cos(th)
        h = dist * math.cos(e)
        return dict(label=label, target=[round(c, 1), gz + lift, round(r, 1)],
                    pos=[round(c + h * du, 1), round(gz + lift + dist * math.sin(e)), round(r - h * dv, 1)])

    centre = (W / 2, D / 2, int(g[D // 2, W // 2]))
    return {
        "default": view("Overview", centre, 6600, 36, 200, 30),
        "overview": view("Overview", centre, 6600, 36, 200, 30),
        "bunkerhill": view("Bunker Hill", at(34.0511, -118.2541), 1100, 22, 215, 120),
        "civic": view("Civic Center", at(34.0545, -118.2440), 900, 30, 160, 40),
        "littletokyo": view("Little Tokyo", at(34.0494, -118.2398), 600, 32, 135, 10),
        "viaduct": view("Sixth Street Viaduct", at(34.0385, -118.2295), 700, 20, 330, 10),
        "lalive": view("LA Live", at(34.0446, -118.2660), 800, 28, 180, 20),
        "historic": view("Broadway", at(34.0475, -118.2520), 500, 30, 200, 20),
    }


def refresh_labels():
    """Recompute labels and views only (layers, no voxels), patching meta.json in place."""
    Lr = build()
    path = WEB_DATA / "meta.json"
    meta = json.loads(path.read_text(encoding="utf-8"))
    meta["labels"] = make_labels(Lr, Lr["g"])
    meta["views"] = make_views(Lr["g"])
    path.write_text(json.dumps(meta, ensure_ascii=False), encoding="utf-8")


if __name__ == "__main__":
    import sys
    refresh_labels() if "--labels" in sys.argv else main()
