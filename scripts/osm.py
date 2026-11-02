"""OSM (Overpass `out geom` JSON) parsed into shapely geometries in grid coordinates.

Grid coordinates: x = column = u - U_MIN, y = row = V_MAX - v (see aoi.py); cell (c, r) spans [c, c+1) x [r, r+1).
Adapted from warsaw-vibe-voxel (MIT, Piotr Migdał).
"""
import json

import numpy as np
from shapely.geometry import LineString, MultiPolygon, Point, Polygon
from shapely.ops import polygonize, unary_union

from aoi import CACHE, U_MIN, V_MAX, lonlat_to_uv


def to_grid_many(lons, lats):
    u, v = lonlat_to_uv(np.asarray(lons, float), np.asarray(lats, float))
    return np.stack([u - U_MIN, V_MAX - v], 1)


def to_grid(lon, lat):
    c, r = to_grid_many([lon], [lat])[0]
    return float(c), float(r)


def _coords(geom):
    pts = [p for p in geom if p]
    if not pts:
        return []
    return [tuple(p) for p in to_grid_many([p["lon"] for p in pts], [p["lat"] for p in pts])]


AREA_KEYS = ("building", "building:part", "landuse", "leisure", "natural", "amenity", "area:highway",
             "man_made", "place", "parking", "water", "waterway")


class OSM:
    def __init__(self, path=CACHE / "osm.json"):
        data = json.load(open(path, encoding="utf-8"))
        self.nodes = []  # (id, tags, Point)
        self.lines = []  # (id, tags, LineString)
        self.areas = []  # (id, type, tags, Polygon|MultiPolygon)
        for e in data["elements"]:
            tags = e.get("tags", {})
            if not tags:
                continue
            if e["type"] == "node":
                self.nodes.append((e["id"], tags, Point(to_grid(e["lon"], e["lat"]))))
            elif e["type"] == "way":
                g = e.get("geometry", [])
                c = _coords(g)
                if len(c) < 2:
                    continue
                closed = len(c) >= 4 and g[0] and g[-1] and g[0] == g[-1]
                is_area = closed and (tags.get("area") == "yes" or any(k in tags for k in AREA_KEYS)) \
                    and tags.get("area") != "no" and not ("highway" in tags and tags.get("area") != "yes"
                                                           and "area:highway" not in tags) \
                    and tags.get("waterway") not in ("river", "stream", "canal", "drain", "ditch")
                if is_area:
                    p = Polygon(c)
                    if not p.is_valid:
                        p = p.buffer(0)
                    if p.area > 0:
                        self.areas.append((e["id"], "way", tags, p))
                else:
                    self.lines.append((e["id"], tags, LineString(c)))
            elif e["type"] == "relation" and tags.get("type") in ("multipolygon", "building"):
                outer, inner = [], []
                for m in e.get("members", []):
                    if m["type"] != "way" or not m.get("geometry"):
                        continue
                    c = _coords(m["geometry"])
                    if len(c) < 2:
                        continue
                    (inner if m.get("role") == "inner" else outer).append(LineString(c))
                if not outer:
                    continue
                o = unary_union(list(polygonize(unary_union(outer))))
                if inner:
                    o = o.difference(unary_union(list(polygonize(unary_union(inner)))))
                if o.is_empty or o.area == 0:
                    continue
                if not isinstance(o, (Polygon, MultiPolygon)):
                    o = o.buffer(0)
                self.areas.append((e["id"], "relation", tags, o))

    def areas_with(self, key, values=None):
        return [a for a in self.areas if key in a[2] and (values is None or a[2][key] in values)]

    def lines_with(self, key, values=None):
        return [a for a in self.lines if key in a[1] and (values is None or a[1][key] in values)]

    def nodes_with(self, key, values=None):
        return [a for a in self.nodes if key in a[1] and (values is None or a[1][key] in values)]
