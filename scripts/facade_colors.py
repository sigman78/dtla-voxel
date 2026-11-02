"""Verified facade colours, bounded by typed OSM identity and measured geometry.

The review roster is also the runtime input. Pending entries are inert; no names,
photograph sampling, global colour grading, or geometry edits participate here.
"""
from dataclasses import dataclass
import json
import math
from pathlib import Path
import re

import numpy as np
from affine import Affine
from rasterio.features import rasterize
from shapely.geometry import Point

from palette import (M_WALL, M_GLASS, M_STUCCO, M_CLASSIC, M_CONCRETE,
                     M_BRONZE, M_METAL, M_RIBBON, M_CITY_HALL, M_WILSHIRE, pal)


ROSTER = Path(__file__).resolve().parent.parent / "docs" / "facade-color-roster.json"
MATERIALS = dict(wall=M_WALL, glass=M_GLASS, stucco=M_STUCCO,
                 classic=M_CLASSIC, concrete=M_CONCRETE, bronze=M_BRONZE,
                 metal=M_METAL, ribbon=M_RIBBON, preserve=None)


@dataclass(frozen=True)
class FacadeColor:
    key: str
    identity: tuple[str, int]
    anchor: tuple[float, float]
    max_distance: float
    min_area: float
    max_area: float
    color: str
    material: int | None
    roof_color: str | None = None


def load_roster(path=ROSTER):
    """Load version 1 entries; incomplete/unverified proposals never alter exports.

    Verified records require identity {type,id}, anchor [x,row], maxDistance,
    minArea, maxArea, color, material, and nonempty sources [URL,...]. An optional
    roofColor recolours only matching special landmark cladding, never plain roofs.
    """
    path = Path(path)
    if not path.exists():
        return []
    raw = json.loads(path.read_text(encoding="utf-8"))
    if raw.get("version") != 1 or not isinstance(raw.get("entries"), list):
        raise ValueError(f"Invalid facade roster schema: {path}")
    result, seen = [], set()
    for entry in raw["entries"]:
        if entry.get("status") != "verified":
            continue
        try:
            identity = entry["identity"]
            typ, oid = identity["type"], identity["id"]
            anchor = tuple(entry["anchor"])
            distance, lo, hi = (entry[k] for k in ("maxDistance", "minArea", "maxArea"))
            color, material = entry["color"], entry["material"]
            roof = entry.get("roofColor")
            sources = entry["sources"]
            assert isinstance(entry["key"], str) and entry["key"]
            assert typ in ("way", "relation") and type(oid) is int and oid > 0
            assert len(anchor) == 2 and all(math.isfinite(v) for v in anchor)
            assert all(math.isfinite(v) for v in (distance, lo, hi))
            assert distance > 0 and 0 < lo <= hi
            assert re.fullmatch(r"#[0-9a-fA-F]{6}", color)
            assert roof is None or re.fullmatch(r"#[0-9a-fA-F]{6}", roof)
            assert material in MATERIALS
            assert isinstance(sources, list) and sources
            assert all(isinstance(s, str) and s.startswith(("https://", "http://")) for s in sources)
            assert (typ, oid) not in seen
        except (KeyError, TypeError, ValueError, AssertionError) as exc:
            raise ValueError(f"Invalid verified facade entry: {entry.get('key', '<unnamed>')}") from exc
        seen.add((typ, oid))
        result.append(FacadeColor(entry["key"], (typ, oid), anchor, distance,
                                  lo, hi, color, MATERIALS[material], roof))
    return result


def apply_facade_colors(areas, bmask, basewall, roofc, entries=None):
    """Append palette colours and replace selected wall slots after landmark styles.

    Special landmark materials always survive, even if a roster proposes another
    material. Roofs change only through explicit roofColor on their shared skin.
    """
    entries = load_roster() if entries is None else entries
    lookup = {}
    for area in areas:
        lookup.setdefault((area[1], area[0]), []).append(area)
    diagnostics = []
    rows, cols = bmask.shape
    for spec in entries:
        matches = lookup.get(spec.identity, [])
        diagnostic = dict(key=spec.key, identity=list(spec.identity), status="unmatched", cells=0)
        diagnostics.append(diagnostic)
        if len(matches) != 1:
            continue
        _, _, tags, geom = matches[0]
        if (tags.get("building") not in (None, "no", "roof", "construction")
                or tags.get("building:part") not in (None, "no")):
            eligible = True
        else:
            eligible = False
        if (not eligible or geom.is_empty or not geom.is_valid
                or not spec.min_area <= geom.area <= spec.max_area
                or geom.centroid.distance(Point(spec.anchor)) > spec.max_distance):
            diagnostic["status"] = "geometry_guard_rejected"
            continue
        x0, z0, x1, z1 = geom.bounds
        c0, r0 = max(0, math.floor(x0)), max(0, math.floor(z0))
        c1, r1 = min(cols, math.ceil(x1)), min(rows, math.ceil(z1))
        if c1 <= c0 or r1 <= r0:
            diagnostic["status"] = "outside_grid"
            continue
        window = np.s_[r0:r1, c0:c1]
        mask = rasterize([(geom, 1)], out_shape=(r1-r0, c1-c0),
                         transform=Affine.translation(c0, r0), dtype="uint8").astype(bool)
        mask &= bmask[window]
        if not mask.any():
            diagnostic["status"] = "no_building_cells"
            continue
        walls, roofs = basewall[window], roofc[window]
        for old in np.unique(walls[mask]):
            material = pal.entries[int(old)][3]
            special = M_CITY_HALL <= material <= M_WILSHIRE
            target = material if special or spec.material is None else spec.material
            selected = mask & (walls == old)
            walls[selected] = pal(spec.color, target)
            if spec.roof_color is not None and special:
                # Only the shared landmark skin; planted and ordinary roofs stay intact.
                roof_mask = selected & np.isin(roofs, [i for i, p in enumerate(pal.entries)
                                                       if p[3] == material])
                roofs[roof_mask] = pal(spec.roof_color, material)
        diagnostic.update(status="applied", cells=int(mask.sum()))
    return diagnostics
