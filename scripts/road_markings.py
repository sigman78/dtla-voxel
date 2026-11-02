"""Conservative, road-oriented crosswalk paint and surface-junction interiors.

All geometry uses the export metre grid. Crosswalk bars follow traffic, rather
than a global pixel checkerboard. Unknown/ambiguous locations stay unpainted.
"""
import math

import numpy as np
from affine import Affine
from rasterio.features import rasterize
from scipy import ndimage
from shapely.geometry import LineString, Point, Polygon
from shapely.ops import unary_union
from shapely.strtree import STRtree


ROAD_TYPES = {"primary", "secondary", "tertiary", "unclassified", "residential", "living_street", "trunk"}
NEGATIVE_MARKINGS = {"no", "none", "unmarked"}


def _surface(tags):
    try:
        layer = float(str(tags.get("layer", 0)).split(";")[0])
    except ValueError:
        return False
    return (layer == 0 and tags.get("bridge", "no") in ("no", "false", "0")
            and tags.get("tunnel", "no") in ("no", "false", "0")
            and tags.get("location") != "underground")


def _marked(tags):
    if not _surface(tags) or tags.get("crossing") in NEGATIVE_MARKINGS:
        return False
    markings = tags.get("crossing:markings", "")
    if markings in NEGATIVE_MARKINGS:
        return False
    if markings:
        return markings in ("yes", "zebra", "ladder", "ladder:skewed", "continental", "lines")
    return tags.get("crossing") in ("marked", "zebra")


def _resolved_pixels(mask):
    components, _ = ndimage.label(mask)
    counts = np.bincount(components.ravel())
    keep = counts >= 3
    keep[0] = False
    return keep[components]


def apply_crosswalk_paint(colors, mask, road_palette_ids, paint_id):
    """Late palette allocation cannot repaint centre lines, rail beds or rivers."""
    paint = _resolved_pixels(mask & np.isin(colors, road_palette_ids))
    colors[paint] = paint_id
    return paint


def finalize_crosswalk_paint(layers):
    """Allocate paint only after model materials, preserving every older palette slot.

    Call once after prepare_landmark_volumes and before band filling. Layers keep
    the unpainted ground for terrain and coarse LOD restoration.
    """
    if "crosswalkPalette" in layers:
        return
    from palette import M_MARK, pal
    paint = pal("#d4d3ca", M_MARK)
    far = pal("#979994", M_MARK)
    layers["crosswalkMask"] = apply_crosswalk_paint(layers["gcol"], layers["crosswalkMask"],
                                                   layers["roadPaletteIds"], paint)
    layers["crosswalkPalette"] = paint
    layers["crosswalkFarPalette"] = far
    layers["roadMarkingDiagnostics"]["paintedCells"] = int(layers["crosswalkMask"].sum())


def _tangent(line, point):
    at = line.project(point)
    a, b = line.interpolate(max(0, at - 2)), line.interpolate(min(line.length, at + 2))
    direction = np.array([b.x-a.x, b.y-a.y])
    length = np.linalg.norm(direction)
    return direction / length if length > 0.1 else None


def _roads(roads):
    selected = []
    for oid, tags, line, width in roads:
        kind = tags.get("highway", "").replace("_link", "")
        if (kind in ROAD_TYPES and _surface(tags) and not line.is_empty
                and line.length >= 2 and math.isfinite(width) and 3 <= width <= 35):
            selected.append((oid, tags, line, width))
    return selected


def junction_interiors(roads):
    """Physical at-grade intersections; exclude collinear joins and service ways.

    Local strips extend through T endpoints so the full junction is clear, not
    just the half of the through-road covered by the terminating line's buffer.
    """
    roads = _roads(roads)
    if not roads:
        return Polygon()
    lines = [road[2] for road in roads]
    tree = STRtree(lines)
    patches = []
    for i, (_, _, line, width) in enumerate(roads):
        for j in tree.query(line):
            j = int(j)
            if j <= i:
                continue
            other, other_width = roads[j][2:]
            intersection = line.intersection(other)
            points = [intersection] if intersection.geom_type == "Point" else list(intersection.geoms) if intersection.geom_type == "MultiPoint" else []
            for point in points:
                # The parser retains OSM vertices: a point shared by both paths
                # is a conservative proxy for a topological road junction.
                if any(not any(math.hypot(x-point.x, y-point.y) <= 0.2 for x,y in path.coords)
                       for path in (line, other)):
                    continue
                a, b = _tangent(line, point), _tangent(other, point)
                if a is None or b is None or abs(float(np.dot(a, b))) > 0.94:
                    continue
                extent = max(width, other_width) * 3
                def strip(direction, road_width):
                    x, y = point.x, point.y
                    return LineString([(x-direction[0]*extent, y-direction[1]*extent),
                                       (x+direction[0]*extent, y+direction[1]*extent)]).buffer(road_width / 2, cap_style="flat")
                patches.append(strip(a, width).intersection(strip(b, other_width)))
    return unary_union(patches) if patches else Polygon()


def build_crosswalk_mask(lines, nodes, roads, road_mask):
    """Return 1 m paint mask and counts, preferring explicit crossing footways.

    Road tuples are (id,tags,centreline,width). Nodes without a positive marking
    tag do not imply paint just because they carry signals or crossing priority.
    """
    roads = _roads(roads)
    result = np.zeros(road_mask.shape, bool)
    diagnostics = dict(explicit=0, nodeFallback=0, ambiguous=0, bars=0, cells=0)
    if not roads:
        return result, diagnostics
    corridors = [r[2].buffer(r[3]/2, cap_style="flat") for r in roads]
    tree = STRtree(corridors)
    represented = []
    explicit_paths = [line for _, tags, line in lines
                      if tags.get("footway") == "crossing" or tags.get("cycleway") == "crossing"
                      or (tags.get("highway") in ("path", "cycleway")
                          and ("crossing" in tags or "crossing:markings" in tags))]
    explicit_tree = STRtree(explicit_paths)

    def road_at(point, walk_axis=None):
        candidates = []
        for index in tree.query(point.buffer(3)):
            index = int(index)
            road = roads[index]
            direction = _tangent(road[2], point)
            if direction is None or (walk_axis is not None and abs(float(np.dot(direction, walk_axis))) > 0.45):
                continue
            distance = road[2].distance(point)
            if distance <= road[3]/2 + 1:
                candidates.append((distance, index, direction))
        if not candidates:
            return None
        candidates.sort(key=lambda item: (item[0], roads[item[1]][0]))
        best = candidates[0]
        close = [item for item in candidates if item[0] <= best[0] + 1.0]
        if any(abs(float(np.dot(best[2], item[2]))) < 0.94 for item in close):
            return None
        return best, unary_union([corridors[item[1]] for item in close])

    def paint(walk, tags, context):
        start, end = Point(walk.coords[0]), Point(walk.coords[-1])
        axis = np.array([end.x-start.x, end.y-start.y])
        length = np.linalg.norm(axis)
        if not 3 <= length <= 45 or length / walk.length < 0.9:
            return False
        axis /= length
        traffic = np.array([-axis[1], axis[0]])
        try:
            width = float(str(tags.get("width", 3.6)).split()[0])
        except ValueError:
            width = 3.6
        width = min(4.0, max(3.0, width))
        bars = []
        if tags.get("crossing:markings") == "lines":
            # Standard crosswalks have two borders, not continental traffic-parallel bars.
            if length < 5:
                return False
            for side in (-1, 1):
                offset = traffic * side * width/2
                border = LineString([np.array([start.x, start.y])+offset,
                                     np.array([end.x, end.y])+offset]).buffer(0.55, cap_style="flat")
                bars.append(border.intersection(context))
        else:
            # Symmetric phase gives resolved 1.5 m bars, separated by 1.3 m.
            count = max(1, int((length-1.5)/2.8)+1)
            span = (count-1)*2.8 + 1.5
            for along in (length-span)/2 + np.arange(count)*2.8:
                centre = np.array([start.x, start.y]) + axis*(along+0.75)
                corners = [centre+axis*a+traffic*b for a,b in ((-.75,-width/2),(.75,-width/2),(.75,width/2),(-.75,width/2))]
                bar = Polygon(corners).intersection(context)
                if not bar.is_empty:
                    bars.append(bar)
        bars = [bar for bar in bars if not bar.is_empty]
        if not bars:
            return False
        geometry = unary_union(bars)
        x0, y0, x1, y1 = geometry.bounds
        c0, r0 = max(0, math.floor(x0)), max(0, math.floor(y0))
        c1, r1 = min(result.shape[1], math.ceil(x1)), min(result.shape[0], math.ceil(y1))
        if c1 <= c0 or r1 <= r0:
            return False
        pixels = rasterize([(geometry, 1)], out_shape=(r1-r0, c1-c0),
                           transform=Affine.translation(c0, r0), dtype="uint8").astype(bool)
        pixels &= road_mask[r0:r1, c0:c1] > 0
        pixels = _resolved_pixels(pixels)
        if not pixels.any():
            return False
        result[r0:r1, c0:c1] |= pixels
        diagnostics["bars"] += len(bars)
        return True

    for _, tags, line in lines:
        if tags.get("footway") != "crossing" or not _marked(tags) or line.length < 3:
            continue
        vector = np.array(line.coords[-1]) - np.array(line.coords[0])
        length = np.linalg.norm(vector)
        if length < 3:
            continue
        context = road_at(line.interpolate(0.5, normalized=True), vector/length)
        if context is None:
            diagnostics["ambiguous"] += 1
            continue
        if paint(line, tags, context[1]):
            represented.append(line)
            diagnostics["explicit"] += 1
    for _, tags, point in nodes:
        if tags.get("highway") != "crossing" or not _marked(tags):
            continue
        if any(explicit_paths[int(i)].distance(point) <= 1.0 for i in explicit_tree.query(point.buffer(1.0))):
            continue  # Explicit negative/unsupported ways also take precedence over node fallbacks.
        if any(line.distance(point) < 3 for line in represented):
            continue
        context = road_at(point)
        if context is None:
            diagnostics["ambiguous"] += 1
            continue
        (_, index, traffic), corridor = context
        axis = np.array([-traffic[1], traffic[0]])
        half_length = roads[index][3]/2 + 0.5
        walk = LineString([(point.x-axis[0]*half_length, point.y-axis[1]*half_length),
                           (point.x+axis[0]*half_length, point.y+axis[1]*half_length)])
        if paint(walk, tags, corridor):
            represented.append(walk)
            diagnostics["nodeFallback"] += 1
    diagnostics["cells"] = int(result.sum())
    return result, diagnostics
