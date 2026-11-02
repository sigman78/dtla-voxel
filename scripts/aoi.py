"""The diorama's area and coordinate frames.

Everything downstream works in a local grid frame:
  u = metres along the DTLA numbered streets (SW -> NE), v = metres across them (SE -> NW).
The frame is UTM 11N (EPSG:32611) rotated by GRID_DEG about CENTER.
"""
import math
import os
from pathlib import Path

from pyproj import Transformer

ROOT = Path(__file__).resolve().parent.parent
# Raw downloads and big intermediates live outside the project (D: is nearly full).
CACHE = Path(os.environ.get("DTLA_CACHE", r"C:\data\dtla-voxel-cache"))
WEB_DATA = ROOT / "web" / "public" / "data"

CENTER_LATLON = (34.0480, -118.2480)
GRID_DEG = 52.0  # numbered streets run 52 deg counter-clockwise from east
U_MIN, U_MAX = -2075.0, 2125.0  # 4200 m: Convention Center -> Chinatown
V_MIN, V_MAX = -2200.0, 1400.0  # 3600 m: east bank of the LA River -> Harbor Fwy

_to_utm = Transformer.from_crs(4326, 32611, always_xy=True)
_from_utm = Transformer.from_crs(32611, 4326, always_xy=True)
CX, CY = _to_utm.transform(CENTER_LATLON[1], CENTER_LATLON[0])
_C, _S = math.cos(math.radians(GRID_DEG)), math.sin(math.radians(GRID_DEG))


def utm_to_uv(x, y):
    dx, dy = x - CX, y - CY
    return dx * _C + dy * _S, -dx * _S + dy * _C


def uv_to_utm(u, v):
    return CX + u * _C - v * _S, CY + u * _S + v * _C


def lonlat_to_uv(lon, lat):
    return utm_to_uv(*_to_utm.transform(lon, lat))


def uv_to_lonlat(u, v):
    return _from_utm.transform(*uv_to_utm(u, v))


def corners_uv(margin=0.0):
    return [(U_MIN - margin, V_MIN - margin), (U_MAX + margin, V_MIN - margin),
            (U_MAX + margin, V_MAX + margin), (U_MIN - margin, V_MAX + margin)]


def bbox_lonlat(margin=0.0):
    """(south, west, north, east) covering the rotated rectangle."""
    pts = [uv_to_lonlat(u, v) for u, v in corners_uv(margin)]
    lons, lats = zip(*pts)
    return min(lats), min(lons), max(lats), max(lons)
