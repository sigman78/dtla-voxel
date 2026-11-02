"""Illustrative night obstruction markers attached to exported building surfaces.

Reads the 1 m tile runs, never label anchors or architectural height tags. These
model-derived placements are visual details, not surveyed aviation installations.
Run directly to refresh metadata without rebuilding any voxel tiles.
"""
import gzip
import json
import math
from pathlib import Path

import numpy as np
from affine import Affine
from rasterio.features import rasterize
from scipy import ndimage

from aoi import WEB_DATA
from osm import OSM
from palette import stable_hash

BUILDING_MATERIALS = {1, 2, 12, 13, 15, 20, 21, 22, 23, 24, 25, 26, 27, 28}
MIN_HEIGHT = 180
TOWER_NAMES = {
    ("way", 496246723): "Wilshire Grand Center",
    ("way", 23973401): "U.S. Bank Tower",
    ("way", 428021714): "Aon Center",
    ("way", 48847807): "Two California Plaza",
    ("way", 427532192): "Gas Company Tower",
    ("way", 449567378): "Bank of America Plaza",
    ("way", 428021711): "777 Tower",
    ("way", 427532202): "Wells Fargo Center North Tower",
}


def read_surfaces(meta, data_dir=WEB_DATA):
    """Top exposed face, its material, and terrain from the actual 1 m tiles.

    A marker may use only the exposed top run; searching through a tree or another
    object to a buried roof would produce an invisible, incorrectly placed light.
    """
    rows, cols = meta["D"], meta["W"]
    top = np.zeros((rows, cols), np.uint16)
    material = np.zeros((rows, cols), np.uint8)
    ground = np.zeros((rows, cols), np.uint8)
    n = meta["tiles"]["N"]
    size, palette = n + 2, np.asarray(meta["palette"], np.int32)
    count = size * size
    for ty in range(math.ceil(rows/n)):
        for tx in range(math.ceil(cols/n)):
            path = Path(data_dir) / "tiles" / "1" / f"{tx}_{ty}.bin"
            raw = gzip.decompress(path.read_bytes())
            counts = np.frombuffer(raw, dtype="<u2", count=count)
            terrain = np.frombuffer(raw, dtype="u1", count=count, offset=count*2)
            nruns = int(counts.sum())
            runs = np.frombuffer(raw, dtype="<u2", count=nruns*3, offset=count*3).reshape(-1, 3)
            ends = np.cumsum(counts, dtype=np.int64)
            occupied = np.flatnonzero(counts)
            last = runs[ends[occupied]-1]
            heights = np.zeros(count, np.uint16)
            mats = np.zeros(count, np.uint8)
            heights[occupied] = last[:, 0] + last[:, 1]
            mats[occupied] = palette[last[:, 2], 3]
            r0, c0 = ty*n, tx*n
            h, w = min(n, rows-r0), min(n, cols-c0)
            window = np.s_[r0:r0+h, c0:c0+w]
            core = np.s_[1:1+h, 1:1+w]
            top[window] = heights.reshape(size, size)[core]
            material[window] = mats.reshape(size, size)[core]
            ground[window] = terrain.reshape(size, size)[core]
    return top, material, ground


def building_features(areas):
    """Match the main export's overlap ordering, including exact OSM namespaces."""
    def eligible(a):
        t = a[2]
        try:
            layer = float(str(t.get("layer", 0)).split(";")[0])
        except ValueError:
            return False
        return t.get("building") not in (None, "no", "roof", "construction") \
            and t.get("location") != "underground" and layer >= 0
    return sorted((a for a in areas if eligible(a)), key=lambda a: -a[3].area)


def spire_start(top, mask):
    """Detect a tall isolated <=9 m² tip above the broad roof/sail.

    The threshold is the top face of the highest non-tip column, so the shader
    starts exactly where the remaining model cross-section becomes slender.
    """
    values = top[mask]
    if len(values) < 30:
        return None
    peak = int(values.max())
    levels = np.unique(values)
    for z in levels[::-1]:
        slender = mask & (top > z)
        count = int(slender.sum())
        if not 1 <= count <= 9 or peak - int(z) < 12:
            continue
        _, components = ndimage.label(slender, structure=np.ones((3, 3)))
        rr, cc = np.nonzero(slender)
        if components == 1 and np.ptp(rr) <= 3 and np.ptp(cc) <= 3:
            return int(z)
    return None


def roof_markers(top, mask, c0=0, r0=0):
    """Up to four separated high-roof perimeter positions plus an optional tip.

    Each Y is the exact top face of its supporting voxel column. A broad upper
    terrace is selected using 3 m elevation bands, rejecting isolated equipment.
    """
    if not mask.any():
        return [], None
    start = spire_start(top, mask)
    roof = mask.copy()
    if start is not None:
        roof &= top <= start
    peak = int(top[roof].max())
    high = roof & (top >= peak-35)
    values = top[high].astype(np.int32)
    bins = np.bincount(values)
    support = np.convolve(bins, np.ones(3, np.int32), mode="same")
    minimum = max(20, int(high.sum()*0.04))
    levels = np.flatnonzero(support >= minimum)
    level = int(levels[-1]-1) if len(levels) else peak-2
    candidates = roof & (top >= level)
    perimeter = candidates & ~ndimage.binary_erosion(candidates)
    rr, cc = np.nonzero(perimeter)
    positions = []
    if len(rr):
        # Diagonal extrema spread lights around the actual upper-roof perimeter.
        for score in (cc+rr, cc-rr, -cc-rr, -cc+rr):
            for index in np.argsort(-score, kind="stable"):
                x, z = float(cc[index]+c0+0.5), float(rr[index]+r0+0.5)
                if all(math.hypot(x-p[0], z-p[2]) >= 8 for p, _ in positions):
                    positions.append(([x, float(top[rr[index], cc[index]]), z], "steady"))
                    break
    if start is not None:
        tip = mask & (top > start)
        rr, cc = np.nonzero(tip & (top == top[tip].max()))
        # Central existing tip cell, not a centroid that could fall over empty air.
        index = np.argmin((rr-rr.mean())**2+(cc-cc.mean())**2)
        positions.append(([float(cc[index]+c0+0.5), float(top[rr[index], cc[index]]),
                           float(rr[index]+r0+0.5)], "beacon"))
    return positions, start


def generate_lights(meta, areas, surface):
    """Return marker records, roof diagnostics, and model-relative spire thresholds."""
    top, material, ground = surface
    features = building_features(areas)
    owners = rasterize([(a[3], i) for i, a in enumerate(features, 1)],
                       out_shape=top.shape, transform=Affine.identity(), dtype="uint32")
    lights, diagnostics, spires = [], [], {}
    for index, (oid, typ, tags, geom) in enumerate(features, 1):
        # Explicit low-rise podiums can inherit a tall neighbour's LiDAR wall
        # samples. They are not separate aviation obstacles. Keep them in the
        # ownership raster to prevent assigning their cells to a nearby tower.
        try:
            tagged_height = float(str(tags.get("height", "nan")).split(";")[0].split()[0])
            levels = float(str(tags.get("building:levels", "nan")).split(";")[0])
        except ValueError:
            tagged_height, levels = float("nan"), float("nan")
        if tagged_height < 80 or levels < 20:
            continue
        x0, y0, x1, y1 = geom.bounds
        c0, r0 = max(0, math.floor(x0)), max(0, math.floor(y0))
        c1, r1 = min(meta["W"], math.ceil(x1)), min(meta["D"], math.ceil(y1))
        if c1 <= c0 or r1 <= r0:
            continue
        window = np.s_[r0:r1, c0:c1]
        heights = top[window]
        mask = owners[window] == index
        mask &= np.isin(material[window], list(BUILDING_MATERIALS))
        mask &= heights.astype(np.int32) - ground[window] >= MIN_HEIGHT
        if not mask.any():
            continue
        positions, start = roof_markers(heights, mask, c0, r0)
        name = TOWER_NAMES.get((typ, oid)) or tags.get("name") or tags.get("addr:housename") \
            or f"Building {typ}/{oid}"
        phase = (stable_hash(typ, oid, "obstruction") % 10000) / 10000
        for position, kind in positions:
            lights.append(dict(building=name, osmType=typ, osmId=oid,
                               position=position, kind=kind, phase=phase))
        diagnostics.append(dict(building=name, osmType=typ, osmId=oid,
                                maxHeight=int((heights.astype(np.int32)-ground[window])[mask].max()),
                                lights=len(positions), spireStart=start))
        if start is not None:
            spires[(typ, oid)] = start
    return lights, diagnostics, spires


def enrich_metadata(meta, data_dir=WEB_DATA, osm=None):
    """Update metadata in memory; call after 1 m tiles and the palette are final."""
    osm = OSM() if osm is None else osm
    lights, diagnostics, spires = generate_lights(meta, osm.areas, read_surfaces(meta, data_dir))
    meta["obstructionLights"] = lights
    meta["obstructionLightDiagnostics"] = diagnostics
    # Only the requested Wilshire facade uses the automatically measured threshold.
    absolute = spires.get(("way", 496246723))
    if absolute is not None:
        for style in meta.get("landmarkStyles", []):
            if style["key"] == "wilshire":
                style["spireBase"] = float(absolute-style["origin"][1])
    return meta


def main():
    path = WEB_DATA / "meta.json"
    meta = json.loads(path.read_text(encoding="utf-8"))
    enrich_metadata(meta)
    path.write_text(json.dumps(meta, ensure_ascii=False), encoding="utf-8")
    for diagnostic in meta["obstructionLightDiagnostics"]:
        print(diagnostic, flush=True)
    print(f"Wrote {len(meta['obstructionLights'])} model-aligned obstruction lights")


if __name__ == "__main__":
    main()
