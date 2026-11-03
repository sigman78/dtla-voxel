"""Conservative object evidence for vegetation beside mapped buildings.

Dense crowns can have solid, spectrally dark interiors. Use their porous rims and
non-planar shape before the unmapped-structure pass fills those interiors to ground.
Mapped footprints are never carved away. Elevated wall surfaces retain measured
vertical bounds rather than acquiring a synthetic crown and ground-reaching trunk.
"""
import numpy as np
from scipy import ndimage


def classify_edges(top, mean, ndvi, passthru, count, low, buildings, excluded=None, protected=None):
    shape = top.shape
    supported = np.zeros(shape, bool)
    attachments = np.zeros(shape, bool)
    excluded = np.zeros(shape, bool) if excluded is None else excluded
    protected = np.zeros(shape, bool) if protected is None else protected
    diagnostics = dict(crowns=[], supportedCells=0, attachmentCells=0)
    if not buildings.any():
        return supported, attachments, diagnostics
    distance = ndimage.distance_transform_edt(~buildings)
    valid = ~buildings & ~excluded & ~protected & np.isfinite(top) & (mean > 2) & (top < 35)
    # Opening separates crowns joined by a narrow facade strip; tall one-cell
    # strips must not become crown seeds merely because they are tall.
    opened = ndimage.binary_opening(valid, iterations=2)
    labels, _ = ndimage.label(opened)
    for ident, bounds in enumerate(ndimage.find_objects(labels), 1):
        if bounds is None:
            continue
        r, c = bounds
        sl = (slice(max(0, r.start-1), min(shape[0], r.stop+1)),
              slice(max(0, c.start-1), min(shape[1], c.stop+1)))
        mask = labels[sl] == ident
        area = int(mask.sum())
        if not 20 <= area <= 1500 or max(mask.shape) > 4*min(mask.shape):
            continue
        if distance[sl][mask].min() > 12:
            continue
        z = top[sl]
        height = float(np.median(z[mask]))
        # A crown touching a facade does not inherit the facade's taller returns.
        mask &= z <= height+3
        core = ndimage.binary_erosion(mask, iterations=2)
        rim = mask & ~core
        reliable_rim = rim & (count[sl] >= 4)
        if core.sum() < 4 or reliable_rim.sum() < 8:
            continue
        rr, cc = np.nonzero(mask)
        plane = np.column_stack((rr, cc, np.ones(len(rr))))
        residual = z[mask] - plane @ np.linalg.lstsq(plane, z[mask], rcond=None)[0]
        roughness = float(np.median(np.abs(residual)))
        rise = float(np.median(z[core])-np.median(z[rim]))
        porous = float(np.mean(passthru[sl][reliable_rim] > .3))
        green = float(np.mean(ndvi[sl][mask] > .05))
        core_distance = float(np.median(distance[sl][core]))
        wall_contact = float(np.mean(distance[sl][mask] <= 1.5))
        # Spectrally dark crowns need room away from the wall: an attached dome
        # awning or flag is not promoted using multiple returns alone.
        accepted = (porous >= .25 and rise >= .35 and roughness >= .3 and wall_contact <= .1
                    and (green >= .15 or core_distance >= 3))
        if not accepted:
            continue
        grown = ndimage.binary_dilation(mask) & valid[sl] & (z <= height+3)
        supported[sl] |= grown
        diagnostics['crowns'].append(dict(bounds=[sl[1].start, sl[0].start, sl[1].stop, sl[0].stop],
            cells=int(grown.sum()), medianHeight=round(height,3), rimPorosity=round(porous,3),
            greenFraction=round(green,3), coreDistance=round(core_distance,3),
            wallContactFraction=round(wall_contact,3),
            domeRise=round(rise,3), planeResidual=round(roughness,3)))
    # Only positively observed, elevated surfaces. Do not guess a function (flag,
    # billboard, eave) or invent an underside where returns extend to the ground.
    attachments = (~buildings & ~excluded & ~protected & ~supported & (distance <= 2.5)
                   & ~ndimage.binary_dilation(opened, iterations=2)
                   & np.isfinite(low) & np.isfinite(top) & (count >= 4) & (low >= 2.5)
                   & (top >= low) & (top-low <= 8) & (ndvi < .12)
                   & ((ndvi > .05) | (passthru > .3)))
    diagnostics['supportedCells'] = int(supported.sum())
    diagnostics['attachmentCells'] = int(attachments.sum())
    return supported, attachments, diagnostics
