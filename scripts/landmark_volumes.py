"""Bounded sparse landmark shells; preserve their air gaps and original terrain.

Derived assets contain voxels[N,4] uint16 [local x,height,row,class] and origin[3]
int32 [world x,height,row]. Coordinates denote 1 m cell lower corners. Companion
JSON records source/license/registration. Raw authored models stay in the cache.
"""
from dataclasses import dataclass
import json
import math
from pathlib import Path

import numpy as np
from affine import Affine
from rasterio.features import rasterize
from shapely.geometry import MultiPoint, Point

from palette import C, M_CLASSIC, M_DISNEY, M_DISNEY_GLASS, pal


ASSETS = Path(__file__).resolve().parent / "assets"


@dataclass(frozen=True)
class VolumeSpec:
    key: str
    identity: tuple[str, int]
    asset: Path
    anchor: tuple[float, float]
    max_distance: float
    min_area: float
    max_area: float
    padding: float = 2.0


DISNEY = VolumeSpec("disney", ("relation", 6333150), ASSETS / "disney-shell.npz",
                    (2618.48, 759.75), 45, 9000, 13500)


@dataclass
class LandmarkVolumes:
    replacement_mask: np.ndarray
    # World [row,column,height,palette], matching the sprite convention.
    voxels: np.ndarray
    diagnostics: list

    @property
    def max_height(self):
        return int(self.voxels[:, 2].max()) + 1 if len(self.voxels) else 0

    def stamp(self, volume, row_start):
        """Write occupied shell cells only, after ordinary fill and sprites."""
        v = self.voxels
        inside = (v[:, 0] >= row_start) & (v[:, 0] < row_start + volume.shape[1])
        inside &= (v[:, 2] >= 0) & (v[:, 2] < volume.shape[0])
        v = v[inside]
        volume[v[:, 2], v[:, 0] - row_start, v[:, 1]] = v[:, 3]

    def preserve_coarse_silhouette(self, volume, scale=8):
        """Retain only coarse cells actually touched by this authored shell.

        A 1 m plane occupies too little of an 8 m block for ordinary downsampling.
        Fill empty touched cells with their topmost source palette, breaking ties
        lexically by row, column and palette so input order cannot change output.
        Existing coarse city cells remain authoritative; shell gaps stay empty.
        """
        v = self.voxels
        indices = v[:, (2, 0, 1)] // scale  # height, row, column
        valid = ((indices >= 0) & (indices < np.asarray(volume.shape))).all(axis=1)
        v, indices = v[valid], indices[valid]
        if not len(v):
            return 0
        flat = np.ravel_multi_index(indices.T, volume.shape)
        order = np.lexsort((v[:, 3], v[:, 1], v[:, 0], v[:, 2], flat))
        sorted_cells = flat[order]
        last = np.r_[sorted_cells[1:] != sorted_cells[:-1], True]
        selected = order[last]
        z, r, c = indices[selected].T
        empty = volume[z, r, c] == 0
        volume[z[empty], r[empty], c[empty]] = v[selected[empty], 3]
        return int(empty.sum())


def _building(tags):
    return (tags.get("building") not in (None, "no", "roof", "construction")
            and tags.get("location") != "underground")


def prepare_landmark_volumes(layers, registry=(DISNEY,)):
    """Validate and prepare once before band export; never mutate layer geometry.

    Missing assets leave the measured building intact. An asset can replace only
    its exact identity's columns inside the model's plan envelope, excluding
    planted roofs and neighbours. Unmodeled peripheral buildings remain intact.
    New shell cells are constrained to a 2 m footprint buffer and physical ground.
    """
    shape = layers["bmask"].shape
    replacement = np.zeros(shape, bool)
    collected, diagnostics = [], []
    areas = layers["osm"].areas
    lookup = {}
    for area in areas:
        lookup.setdefault((area[1], area[0]), []).append(area)
    for spec in registry:
        diagnostic = dict(key=spec.key, identity=list(spec.identity), status="unmatched")
        diagnostics.append(diagnostic)
        matches = lookup.get(spec.identity, [])
        if len(matches) != 1:
            continue
        _, _, tags, footprint = matches[0]
        if (not _building(tags) or footprint.is_empty or not footprint.is_valid
                or not spec.min_area <= footprint.area <= spec.max_area
                or footprint.centroid.distance(Point(spec.anchor)) > spec.max_distance
                or not 0 <= spec.padding <= 2):
            diagnostic["status"] = "geometry_guard_rejected"
            continue
        if not spec.asset.exists():
            diagnostic["status"] = "asset_missing"
            continue
        with np.load(spec.asset, allow_pickle=False) as asset:
            local, origin = asset["voxels"], asset["origin"]
        if (local.ndim != 2 or local.shape[1] != 4 or origin.shape != (3,)
                or not np.issubdtype(local.dtype, np.integer)
                or not np.issubdtype(origin.dtype, np.integer)
                or not np.isin(local[:, 3], (1, 2, 3)).all()):
            raise ValueError(f"Invalid sparse shell asset: {spec.asset}")
        world = local.astype(np.int64)
        world[:, :3] += origin
        rows, cols = shape
        in_grid = ((world[:, 0] >= 0) & (world[:, 0] < cols)
                   & (world[:, 2] >= 0) & (world[:, 2] < rows))
        diagnostic.update(asset=str(spec.asset.relative_to(ASSETS)) if spec.asset.is_relative_to(ASSETS) else spec.asset.name,
                          sourceVoxels=len(world), outsideGrid=int((~in_grid).sum()))
        world = world[in_grid]
        allowed_geom = footprint.buffer(spec.padding)
        x0, r0, x1, r1 = allowed_geom.bounds
        c0, r0 = max(0, math.floor(x0)), max(0, math.floor(r0))
        c1, r1 = min(cols, math.ceil(x1)), min(rows, math.ceil(r1))
        if c1 <= c0 or r1 <= r0:
            diagnostic["status"] = "outside_grid"
            continue
        window = np.s_[r0:r1, c0:c1]
        def burn(geoms):
            return rasterize([(geom, 1) for geom in geoms], out_shape=(r1-r0, c1-c0),
                             transform=Affine.translation(c0, r0), dtype="uint8").astype(bool) if geoms else np.zeros((r1-r0, c1-c0), bool)
        target = burn([footprint])
        buffer = burn([allowed_geom])
        neighbours = burn([a[3] for a in areas if (a[1], a[0]) != spec.identity
                           and _building(a[2]) and a[3].intersects(allowed_geom)])
        garden = layers["roofc"][window] == C["garden_roof"]
        allowed = buffer & ~neighbours & ~garden
        within_window = ((world[:, 0] >= c0) & (world[:, 0] < c1)
                         & (world[:, 2] >= r0) & (world[:, 2] < r1))
        diagnostic["outsideFootprintBuffer"] = int((~within_window).sum())
        world = world[within_window]
        rr, cc = world[:, 2] - r0, world[:, 0] - c0
        on_allowed = allowed[rr, cc]
        diagnostic.update(gardenClipped=int(garden[rr, cc].sum()),
                          neighbourClipped=int(neighbours[rr, cc].sum()))
        diagnostic["outsideFootprintBuffer"] += int((~buffer[rr, cc]).sum())
        world = world[on_allowed]
        # Clear internal shell voids, but retain measured podiums/service wings
        # outside the authored model's envelope. Use occupied cell centres before
        # terrain clipping so sloping ground cannot change the plan registration.
        plan = np.unique(world[:, (0, 2)], axis=0).astype(float) + 0.5
        envelope = burn([MultiPoint(plan).convex_hull.buffer(2.0)]) if len(plan) else np.zeros_like(target)
        above_ground = world[:, 1] >= layers["g"][world[:, 2], world[:, 0]]
        diagnostic["belowGroundClipped"] = int((~above_ground).sum())
        world = world[above_ground]
        if not len(world):
            diagnostic["status"] = "no_valid_voxels"
            continue
        # Use the just-allocated verified facade colour for steel, not a second palette guess.
        old = layers["basewall"][window][target & layers["bmask"][window]]
        old_steel = [int(i) for i in np.unique(old) if pal.entries[int(i)][3] == M_DISNEY]
        steel = old_steel[0] if old_steel else pal("#c5cbcc", M_DISNEY)
        glass = pal("#819495", M_DISNEY_GLASS)
        opaque = pal("#c5bca8", M_CLASSIC)
        mapping = np.array([0, steel, glass, opaque], np.int64)
        voxels = np.column_stack((world[:, 2], world[:, 0], world[:, 1], mapping[world[:, 3]]))
        collected.append(voxels)
        clear = target & envelope & layers["bmask"][window] & ~garden & ~neighbours
        replacement[window] |= clear
        companion = spec.asset.with_suffix(".json")
        source = json.loads(companion.read_text(encoding="utf-8")) if companion.exists() else {}
        diagnostic.update(status="applied", voxels=len(voxels), replacedColumns=int(clear.sum()),
                          bounds=[world[:, :3].min(0).tolist(), (world[:, :3].max(0) + 1).tolist()],
                          materialCounts={str(int(k)): int((world[:, 3] == k).sum()) for k in (1, 2, 3)},
                          provenance=source)
    voxels = np.concatenate(collected) if collected else np.empty((0, 4), np.int64)
    return LandmarkVolumes(replacement, voxels, diagnostics)
