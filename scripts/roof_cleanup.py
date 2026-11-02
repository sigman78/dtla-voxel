"""Conservative roof decks and neutral elevated-object candidates in absolute Z.

Input is a compact 1 m absolute DSM window plus one building footprint mask.
Planes are connected elevation modes, never elevations above a varying terrain.
No missing samples are invented; slopes, curves, boundaries and thin peaks remain.
"""
import math
from collections import Counter

import numpy as np
from scipy import ndimage

BIN = 0.25
MODE_RADIUS = 0.55
MAX_EDIT = 0.35
MIN_PLANE_AREA = 36
MAX_SLOPE = 0.012  # 1.2%; reject coherent shallow ramps as well as pitched roofs
STRUCTURE = ndimage.generate_binary_structure(2, 1)


def _modes(values):
    # Sparse histogram avoids allocating a gigantic array for one extreme outlier.
    with np.errstate(over="ignore", invalid="ignore"):
        quantized = np.floor(values / BIN + 0.5)
    counts = Counter(int(v) for v in quantized[np.isfinite(quantized)])
    score = lambda k: counts[k-1] + 2*counts[k] + counts[k+1]
    peaks = [k for k in sorted(counts) if score(k) >= score(k-1) and score(k) > score(k+1)]
    return [k*BIN for k in peaks]


def _plane_evidence(surface, region):
    rr, cc = np.nonzero(region)
    if len(rr) < MIN_PLANE_AREA or np.ptp(rr) < 5 or np.ptp(cc) < 5:
        return None
    values = surface[region]
    xscale, yscale = max(np.ptp(cc)/2, 1), max(np.ptp(rr)/2, 1)
    x, y = (cc-cc.mean())/xscale, (rr-rr.mean())/yscale
    design = np.column_stack([np.ones(len(x)), x, y])
    level = float(np.median(values))
    fit = np.linalg.lstsq(design, values-level, rcond=None)[0]
    residual = values-level-design@fit
    slope = math.hypot(fit[1]/xscale, fit[2]/yscale)
    rms = float(np.sqrt(np.mean(residual**2)))
    quadratic = np.column_stack([design, x*x, x*y, y*y])
    qfit = np.linalg.lstsq(quadratic, values-level, rcond=None)[0]
    qresidual = values-level-quadratic@qfit
    curvature = quadratic@qfit-design@fit
    curvature_span = float(np.ptp(np.percentile(curvature, [5, 95])))
    curved = rms > 0.035 and curvature_span > 0.10 \
        and float(np.sqrt(np.mean(qresidual**2))) < rms*0.65
    spread = float(np.ptp(np.percentile(values, [5, 95])))
    if slope > MAX_SLOPE or spread > 0.85 or curved:
        return None
    return dict(absoluteElevation=level, area=len(rr), slope=slope,
                residualRMS=rms, curvatureSpan=curvature_span)


def clean_roof(surface, mask):
    """Return ``(cleaned_absolute, classes, diagnostics)`` without mutating inputs.

    classes: planes uint32 labels (0 unclassified), flat/edited/elevated/uncertain
    boolean masks, and deckElevation float64 (NaN without a supported deck).
    ``flat`` includes confident unedited samples, allowing consumers to repair
    old ground-relative/double-rounding artifacts. Elevated candidates keep their
    measured geometry; their function is explicitly unverified.
    """
    source = np.asarray(surface)
    footprint = np.asarray(mask, bool)
    if source.ndim != 2 or source.shape != footprint.shape:
        raise ValueError("Roof surface and mask must be matching 2D arrays")
    cleaned = source.copy() if source.dtype.kind == "f" else source.astype(float)
    valid = footprint & np.isfinite(source)
    labels = np.zeros(source.shape, np.uint32)
    flat = np.zeros(source.shape, bool)
    elevated = np.zeros(source.shape, bool)
    deck = np.full(source.shape, np.nan)
    plane_records, object_records = [], []
    interior = ndimage.binary_erosion(valid, structure=STRUCTURE, iterations=1)
    next_label = 1
    if valid.any():
        for mode in _modes(source[valid]):
            with np.errstate(over="ignore", invalid="ignore"):
                candidates = valid & (labels == 0) & (np.abs(source-mode) <= MODE_RADIUS)
            components, count = ndimage.label(candidates, structure=STRUCTURE)
            for component_id, window in enumerate(ndimage.find_objects(components), 1):
                if window is None:
                    continue
                local_region = components[window] == component_id
                evidence = _plane_evidence(source[window], local_region)
                if evidence is None:
                    continue
                region = np.zeros(source.shape, bool)
                region[window] = local_region
                labels[region] = next_label
                flat[region] = True
                deck[region] = evidence["absoluteElevation"]
                editable = region & interior & (np.abs(source-evidence["absoluteElevation"]) <= MAX_EDIT)
                cleaned[editable] = evidence["absoluteElevation"]
                plane_records.append(dict(id=next_label, kind="flat_deck", **evidence))
                next_label += 1

    def elevated_candidate(region):
        area = int(region.sum())
        if not 4 <= area <= 100:
            return False
        rr, cc = np.nonzero(region)
        if np.ptp(rr) < 1 or np.ptp(cc) < 1 or max(np.ptp(rr), np.ptp(cc)) > 13:
            return False
        surround = ndimage.binary_dilation(region, structure=STRUCTURE, iterations=2)
        if (surround & ~footprint).any():
            return False
        ring = ndimage.binary_dilation(region, structure=STRUCTURE, iterations=3) & valid & ~region
        support = ring & flat
        if not ring.any() or support.sum()/ring.sum() < 0.65:
            return False
        ids, counts = np.unique(labels[support], return_counts=True)
        dominant = int(ids[np.argmax(counts)])
        dominant_support = support & (labels == dominant)
        if dominant_support.sum()/ring.sum() < 0.65:
            return False
        reference = float(np.median(deck[dominant_support]))
        heights = source[region]-reference
        if float(np.min(heights)) < 0.8 or float(np.max(heights)) > 8:
            return False
        elevated[region] = True
        flat[region] = False
        cleaned[region] = source[region]
        deck[region] = reference
        object_records.append(dict(area=area, supportedDeck=dominant,
                                   deckAbsoluteElevation=reference,
                                   relativeHeight=float(np.median(heights)),
                                   confidence="medium", function="unverified elevated roof object",
                                   uncertainty="Shape and neighbouring deck support only; equipment identity unverified"))
        return True

    # Small independently flat tops may be objects rather than separate roof decks.
    for record in plane_records:
        if record["area"] <= 100 and elevated_candidate(labels == record["id"]):
            record["kind"] = "elevated_candidate"
    if flat.any():
        nearest = ndimage.distance_transform_edt(~flat, return_distances=False, return_indices=True)
        reference = deck[tuple(nearest)]
        with np.errstate(invalid="ignore", over="ignore"):
            possible = valid & ~flat & ~elevated & (source-reference >= 0.8) & (source-reference <= 8)
        objects, count = ndimage.label(possible, structure=STRUCTURE)
        for identifier in range(1, count+1):
            elevated_candidate(objects == identifier)
    edited = valid & (cleaned != source)
    uncertain = footprint & ~flat & ~elevated
    differences = np.abs(cleaned[edited]-source[edited])
    diagnostics = dict(planes=plane_records, elevatedCandidates=object_records,
                       changedCells=int(edited.sum()), flatCells=int(flat.sum()),
                       elevatedCells=int(elevated.sum()), uncertainCells=int(uncertain.sum()),
                       noDataCells=int((footprint & ~valid).sum()),
                       maxChange=float(differences.max()) if len(differences) else 0.0,
                       editLimit=MAX_EDIT, slopeLimit=MAX_SLOPE)
    return cleaned, dict(planes=labels, flat=flat, edited=edited, elevated=elevated,
                         uncertain=uncertain, deckElevation=deck), diagnostics
