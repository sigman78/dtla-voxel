"""Ten bounded roof-cleanup pilots, using measured absolute elevation throughout.

Call after authored-model and crosswalk palette allocation. DTLA_ROOF_PILOT=0
disables edits; DTLA_ROOF_AUDIT=0 disables cache JSON/NPZ review artifacts.
Equipment labels mean compact elevated roof features, not identified HVAC units.
"""
from dataclasses import dataclass
import json
import math
import os

import numpy as np
from affine import Affine
from rasterio.features import rasterize
from scipy import ndimage
from shapely.geometry import Point

from aoi import CACHE
from palette import C, M_CITY_HALL, M_ROOF, M_WILSHIRE, pal


@dataclass(frozen=True)
class RoofPilot:
    key: str
    name: str
    identity: tuple[str, int]
    anchor: tuple[float, float]
    area: float
    max_distance: float = 35


# Cached OSM identities and bounded geometry audited 2026-11-02. These include
# stepped civic decks, warehouses, theatre roofs and deliberately difficult ramps.
# A roster entry permits classification; it never assumes the entire roof is flat.
PILOT_ROSTER = (
    RoofPilot("hahn", "Kenneth Hahn Hall of Administration", ("way", 425993519), (2963.83, 951.40), 11970.9),
    RoofPilot("stanley_mosk", "Stanley Mosk Courthouse", ("relation", 6333148), (2778.82, 951.10), 16351.3),
    RoofPilot("union_central_cold_storage", "Union Central Cold Storage", ("way", 202465671), (1775.25, 3000.27), 19333.0),
    RoofPilot("la_cold_storage", "Los Angeles Cold Storage", ("way", 427938805), (2106.66, 2423.67), 17976.4),
    RoofPilot("san_pedro_wholesale", "San Pedro Wholesale Mart", ("relation", 6367989), (660.49, 2023.60), 13314.5),
    RoofPilot("flower_market", "Southern California Flower Market", ("way", 428152658), (1376.91, 1711.14), 12614.7),
    RoofPilot("regal", "Regal L.A. Live", ("way", 428021737), (758.02, 79.26), 11297.1),
    RoofPilot("peacock", "Peacock Theater", ("way", 428021733), (691.14, 243.29), 9295.1),
    RoofPilot("west_garage", "West Garage", ("way", 428021790), (661.87, 95.64), 10459.9),
    RoofPilot("drt_lax10", "DRT LAX10", ("way", 428021796), (1483.31, 746.65), 6219.7),
)


def _jsonable(value):
    if isinstance(value, dict):
        return {str(k): _jsonable(v) for k, v in value.items()}
    if isinstance(value, (tuple, list)):
        return [_jsonable(v) for v in value]
    if isinstance(value, np.ndarray):
        return _jsonable(value.tolist())
    if isinstance(value, np.generic):
        return _jsonable(value.item())
    if isinstance(value, float) and not math.isfinite(value):
        return None
    return value


def apply_roof_pilot(layers, registry=PILOT_ROSTER):
    """Edit accepted flat cells only; return serializable per-building diagnostics.

    Equipment bottom is scene voxel height above base (0 means no override).
    Original terrain, masks, facade palettes and elevated feature heights survive.
    Audits topBefore/topAfter are absolute top-face elevations, matching the DSM
    datum; bounds are [column0,row0,column1,row1]. No photograph heights are used.
    """
    shape = layers["bmask"].shape
    layers["roofEquipmentBottom"] = np.zeros(shape, np.int32)
    layers["roofEquipmentMaterial"] = np.zeros(shape, np.uint16)
    diagnostics = []
    layers["roofDiagnostics"] = diagnostics
    enabled = os.environ.get("DTLA_ROOF_PILOT", "1").lower() not in ("0", "false", "no")
    audit = os.environ.get("DTLA_ROOF_AUDIT", "1").lower() not in ("0", "false", "no")
    output = CACHE / "roof-pilot-review"
    if not enabled:
        diagnostics.append(dict(status="disabled"))
        return diagnostics
    if "roofMeasuredAbsolute" not in layers:
        diagnostics.append(dict(status="measured_absolute_surface_missing"))
        return diagnostics
    from roof_cleanup import clean_roof
    lookup = {}
    for area in layers["osm"].areas:
        lookup.setdefault((area[1], area[0]), []).append(area)
    replacement = getattr(layers.get("landmarkVolumes"), "replacement_mask", None)
    palette_materials = np.array([entry[3] for entry in pal.entries])
    equipment_palette = None
    if audit:
        output.mkdir(parents=True, exist_ok=True)
    rows, cols = shape
    for spec in registry:
        entry = dict(key=spec.key, name=spec.name, identity=list(spec.identity), status="unmatched")
        diagnostics.append(entry)
        matches = lookup.get(spec.identity, [])
        if len(matches) != 1:
            continue
        _, _, tags, footprint = matches[0]
        if (tags.get("building") in (None, "no", "roof", "construction")
                or footprint.is_empty or not footprint.is_valid
                or not spec.area*0.8 <= footprint.area <= spec.area*1.2
                or footprint.centroid.distance(Point(spec.anchor)) > spec.max_distance):
            entry["status"] = "geometry_guard_rejected"
            continue
        x0, y0, x1, y1 = footprint.bounds
        c0, r0 = max(0, math.floor(x0)), max(0, math.floor(y0))
        c1, r1 = min(cols, math.ceil(x1)), min(rows, math.ceil(y1))
        if c1 <= c0 or r1 <= r0:
            entry["status"] = "outside_grid"
            continue
        window = np.s_[r0:r1, c0:c1]
        raw_mask = rasterize([(footprint, 1)], out_shape=(r1-r0, c1-c0),
                             transform=Affine.translation(c0, r0), dtype="uint8").astype(bool)
        mask = raw_mask & layers["bmask"][window]
        if "roofBuildingId" in layers:
            owners = [i for i, (oid, _, geom) in enumerate(layers["blds"], 1)
                      if oid == spec.identity[1] and geom.equals(footprint)]
            if len(owners) != 1:
                entry["status"] = "ownership_lookup_ambiguous"
                continue
            mask &= layers["roofBuildingId"][window] == owners[0]
        mask &= layers["roofc"][window] != C["garden_roof"]
        wall_material = palette_materials[layers["basewall"][window]]
        mask &= ~((wall_material >= M_CITY_HALL) & (wall_material <= M_WILSHIRE))
        if replacement is not None:
            mask &= ~replacement[window]
        if not mask.any():
            entry["status"] = "no_unprotected_roof_cells"
            continue
        measured = layers["roofMeasuredAbsolute"][window].copy()
        cleaned, classes, cleaner_diagnostics = clean_roof(measured, mask)
        ground = layers["g"][window]
        top = layers["topi"][window]
        before = top.copy()
        before_world = ground + before
        flat = np.asarray(classes["flat"], bool) & mask & np.isfinite(cleaned)
        proposed = before.copy()
        proposed[flat] = np.rint(cleaned[flat] - layers["base"]).astype(np.int32) - ground[flat]
        accepted = flat & (np.abs(proposed-before) <= 3) & (proposed >= 2)
        changed = accepted & (proposed != before)
        top[changed] = proposed[changed]
        elevated = np.asarray(classes["elevated"], bool) & mask
        deck = np.asarray(classes["deckElevation"])
        candidate = elevated & np.isfinite(deck)
        bottom = np.zeros(mask.shape, np.int32)
        bottom[candidate] = np.rint(deck[candidate]-layers["base"]).astype(np.int32)
        supported = candidate & (bottom > ground+1) & (bottom < ground+top)
        # Earlier voxel roof processing may have removed part of a measured object.
        # Keep material treatment coherent: never turn its surviving cells into
        # isolated gray speckles, and never add height to reconstruct the rest.
        objects, count = ndimage.label(elevated)
        equipment = np.zeros_like(elevated)
        for identifier in range(1, count+1):
            component = objects == identifier
            if component.sum() >= 4 and supported[component].all():
                equipment[component] = True
        if equipment.any():
            if equipment_palette is None:
                equipment_palette = pal("#989b98", M_ROOF)
            layers["roofEquipmentBottom"][window][equipment] = bottom[equipment]
            layers["roofEquipmentMaterial"][window][equipment] = equipment_palette
            layers["roofc"][window][equipment] = equipment_palette
        entry.update(status="classified", bounds=[c0, r0, c1, r1], eligibleCells=int(mask.sum()),
                     acceptedFlatCells=int(accepted.sum()), geometryChangedCells=int(changed.sum()),
                     maximumVoxelChange=int(np.abs(top-before).max()),
                     equipmentCells=int(equipment.sum()), uncertainCells=int((np.asarray(classes["uncertain"], bool) & mask).sum()),
                     rejectedEquipmentCells=int((elevated & ~equipment).sum()),
                     rejectedLargeChanges=int((flat & ~accepted).sum()),
                     confidence="supported flat planes only; compact elevated features remain unidentified",
                     cleaner=_jsonable(cleaner_diagnostics))
        if audit:
            np.savez_compressed(output / f"{spec.key}.npz", bounds=np.array([c0, r0, c1, r1]),
                                base=layers["base"], topBefore=before_world+layers["base"],
                                topAfter=ground+top+layers["base"], measuredAbsolute=measured,
                                footprintMask=raw_mask, effectiveMask=mask, changeMask=changed,
                                flat=classes["flat"], edited=classes["edited"], elevated=classes["elevated"],
                                uncertain=classes["uncertain"], planes=classes["planes"],
                                deckElevation=deck, equipmentMask=equipment,
                                equipmentBottom=np.where(equipment, bottom, 0),
                                voxelGround=ground, ground=layers["dtm"][window])
    if audit:
        (output / "audit.json").write_text(json.dumps(_jsonable(dict(entries=diagnostics)), indent=2), encoding="utf-8")
    return diagnostics
