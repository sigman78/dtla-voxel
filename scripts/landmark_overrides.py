"""Bounded, identity-based facade overrides, applied after ordinary palette allocation.

Footprints and LiDAR roof heights remain authoritative. A registry entry may opt into
a local height refiner, but it must preserve the mask and return finite positive heights.
All coordinates use the export frame: x=column, z=row, height above the scene base.
"""
from dataclasses import dataclass
import math
from typing import Callable

import numpy as np
from affine import Affine
from rasterio.features import rasterize
from shapely.geometry import Point

from palette import C, M_CITY_HALL, pal


@dataclass(frozen=True)
class LandmarkSpec:
    key: str
    identities: tuple[tuple[str, int], ...]
    material: int
    colour: str
    anchor: tuple[float, float]
    max_distance: float
    min_area: float
    max_area: float
    fallback_names: tuple[str, ...] = ()
    # Receives copies of LOCAL topi and mask; returns local topi. No footprint edits.
    geometry_refiner: Callable | None = None
    crown_base: float | None = None
    roof_colour: str | None = None
    roof_material: int | None = None
    preserve_roof_profile: bool = False


def refine_city_hall(top, mask):
    """Remove 1 m plateau noise only; retain setbacks, pyramid slopes and apex.

    The LiDAR already resolves the tower and pyramid. Six same-level neighbours
    support correcting a one-cell sample; steep transitions never qualify.
    """
    from scipy import ndimage

    median = ndimage.median_filter(top, size=3)
    lo = ndimage.minimum_filter(top, size=3)
    hi = ndimage.maximum_filter(top, size=3)
    supported = ndimage.binary_erosion(mask, iterations=1)
    supported &= (top > 40) & (hi - lo <= 2) & (np.abs(top - median) == 1)
    supported &= top < top[mask].max() - 2  # never blunt the observed pinnacle
    # Require at least six surrounding samples to agree on the plateau elevation.
    agreeing = np.zeros(top.shape, np.uint8)
    padded = np.pad(top, 1, mode="edge")
    for dr in (-1, 0, 1):
        for dc in (-1, 0, 1):
            if dr or dc:
                agreeing += padded[1+dr:1+dr+top.shape[0], 1+dc:1+dc+top.shape[1]] == median
    supported &= agreeing >= 6
    top[supported] = median[supported]
    return top


CITY_HALL_REGISTRY = (
    LandmarkSpec("city_hall", (("relation", 6333145),), M_CITY_HALL, "#e0d6ca",
                 (2869.8, 1400.4), 100, 5000, 15000,
                 # DSM high-tower plateau retains ~530 cells through 100..110 m,
                 # then tapers (506 at 115 m, 280 at 120 m): crown begins here.
                 ("Los Angeles City Hall",), refine_city_hall, 115.0,
                 roof_colour="#e0d6ca", roof_material=M_CITY_HALL),
)


def select_features(areas, spec):
    """Exact type/ID first; named replacement only when the identities are absent.

    Both routes require a building, plausible footprint area, and the local search
    bound. A suspicious exact match fails closed rather than selecting a neighbour.
    """
    exact = [a for a in areas if (a[1], a[0]) in spec.identities]
    candidates = exact or [a for a in areas
                           if a[2].get("name", "").casefold()
                           in {n.casefold() for n in spec.fallback_names}]
    anchor = Point(spec.anchor)
    valid = [a for a in candidates
             if a[2].get("building") not in (None, "no", "roof", "construction")
             and not a[3].is_empty and a[3].is_valid
             and spec.min_area <= a[3].area <= spec.max_area
             and a[3].centroid.distance(anchor) <= spec.max_distance]
    # Fallback must be unambiguous. Exact entries can explicitly list multiple parts.
    return valid if exact or len(valid) == 1 else []


def footprint_frame(geom):
    """Stable long-axis frame from the actual oriented footprint rectangle."""
    corners = list(geom.minimum_rotated_rectangle.exterior.coords)
    edges = [(math.hypot(b[0] - a[0], b[1] - a[1]),
              math.atan2(b[1] - a[1], b[0] - a[0]) % math.pi)
             for a, b in zip(corners, corners[1:])]
    # Rounding prevents tiny opposite-edge differences from flipping a square.
    angle = max(edges, key=lambda e: (round(e[0], 6), -e[1]))[1]
    centre = geom.centroid
    return centre.x, centre.y, angle


def apply_landmark_overrides(areas, bmask, g, topi, basewall, roofc, registry=None, measured_top=None):
    """Mutate only supported building cells; return JSON-ready styles and diagnostics.

    Called once at the end of layers.build so new palette entries append after all
    generic building/vegetation entries. Material IDs are independent of palette IDs.
    """
    from shapely.ops import unary_union

    if registry is None:
        from landmark_catalog import additional_specs
        registry = CITY_HALL_REGISTRY + additional_specs(LandmarkSpec)
    styles, diagnostics = [], []
    rows, cols = bmask.shape
    for spec in registry:
        selected = select_features(areas, spec)
        if not selected:
            diagnostics.append(dict(key=spec.key, status="unmatched"))
            continue
        geom = unary_union([a[3] for a in selected])
        x0, y0, x1, y1 = geom.bounds
        c0, r0 = max(0, math.floor(x0)), max(0, math.floor(y0))
        c1, r1 = min(cols, math.ceil(x1)), min(rows, math.ceil(y1))
        if c1 <= c0 or r1 <= r0:
            diagnostics.append(dict(key=spec.key, status="outside_grid"))
            continue
        window = np.s_[r0:r1, c0:c1]
        mask = rasterize([(geom, 1)], out_shape=(r1-r0, c1-c0),
                         transform=Affine.translation(c0, r0), dtype="uint8").astype(bool)
        mask &= bmask[window]
        if not mask.any():
            diagnostics.append(dict(key=spec.key, status="no_building_cells"))
            continue
        changed = 0
        if spec.preserve_roof_profile and measured_top is not None:
            from scipy import ndimage
            raw = measured_top[window]
            # Restore curved DSM gradients only after vegetation classification:
            # a local roof edit must not renumber tree groups across the city.
            # Keep cleaned boundary returns and planted terraces authoritative.
            interior = ndimage.binary_erosion(mask, iterations=2)
            interior &= (roofc[window] != C["garden_roof"]) & np.isfinite(raw) & (raw >= 2)
            refined = np.rint(raw[interior]).astype(topi.dtype)
            changed += int(np.count_nonzero(topi[window][interior] != refined))
            topi[window][interior] = refined
        if spec.geometry_refiner is not None:
            before = topi[window].copy()
            refined = np.asarray(spec.geometry_refiner(before.copy(), mask.copy()))
            if refined.shape != before.shape or not np.isfinite(refined[mask]).all() \
                    or (refined[mask] < 2).any():
                raise ValueError(f"Invalid local roof refinement: {spec.key}")
            rounded = np.rint(refined[mask]).astype(topi.dtype)
            changed += int(np.count_nonzero(before[mask] != rounded))
            topi[window][mask] = rounded
        colour = pal(spec.colour, spec.material)
        basewall[window][mask] = colour
        if spec.roof_colour is not None:
            roof_material = spec.material if spec.roof_material is None else spec.roof_material
            # Planted terraces (notably Disney Hall's garden) are not cladding.
            roof_mask = mask & (roofc[window] != C["garden_roof"])
            roofc[window][roof_mask] = pal(spec.roof_colour, roof_material)
        x, z, angle = footprint_frame(geom)
        # One robust terrain datum for the entire facade, never per-fragment terrain.
        height = float(np.median(g[window][mask]))
        styles.append(dict(key=spec.key, material=spec.material,
                           origin=[round(x, 4), height, round(z, 4)], angle=angle))
        if spec.crown_base is not None:
            styles[-1]["crownBase"] = float(spec.crown_base)
        diagnostics.append(dict(key=spec.key, status="applied", cells=int(mask.sum()),
                                identities=[[a[1], a[0]] for a in selected],
                                roofCellsChanged=changed,
                                maxHeight=int(topi[window][mask].max())))
    return dict(styles=styles, diagnostics=diagnostics)
