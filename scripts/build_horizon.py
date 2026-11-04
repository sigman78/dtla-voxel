"""Bake a distant-only 360-degree ridge from USGS 3DEP; no runtime DEM requests.

Run with the project's Python environment. Regional 100 m elevation export stays
in DTLA_CACHE. Eight rows cover eye elevations 0..3500 m in 500 m steps.
RGBA bytes encode slope (-.25..+.15) and peak elevation (0..4095 m)
as two unsigned 16-bit values, high byte first.
"""
import hashlib
import json
from urllib.parse import urlencode
from urllib.request import urlopen

import numpy as np
import rasterio
from pyproj import Geod, Transformer

from aoi import CACHE, CENTER_LATLON, CX, CY, ROOT

SERVICE = "https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer"
SAMPLES = 2048
MIN_DISTANCE, MAX_DISTANCE = 20000, 120000


def main():
    cache = CACHE / "horizon"
    cache.mkdir(parents=True, exist_ok=True)
    dem = cache / "regional-100m.tif"
    params = dict(f="json", bbox=f"{CX-121000},{CY-121000},{CX+121000},{CY+121000}",
                  bboxSR=32611, imageSR=32611, size="2420,2420", format="tiff",
                  pixelType="F32", noData=-999999, interpolation="RSP_BilinearInterpolation",
                  renderingRule=json.dumps({"rasterFunction": "None"}))
    if not dem.exists():
        with urlopen(SERVICE + "/exportImage?" + urlencode(params), timeout=180) as response:
            result = json.load(response)
        if "href" not in result:
            raise RuntimeError(result)
        with urlopen(result["href"], timeout=180) as response:
            dem.write_bytes(response.read())
    bearings = np.arange(SAMPLES) * 360 / SAMPLES
    distances = np.arange(MIN_DISTANCE, MAX_DISTANCE + 1, 100)
    az, dist = np.broadcast_arrays(bearings[:, None], distances[None, :])
    lat, lon = CENTER_LATLON
    lons, lats, _ = Geod(ellps="WGS84").fwd(np.full(az.shape, lon), np.full(az.shape, lat), az, dist)
    with rasterio.open(dem) as src:
        assert src.count == 1 and src.dtypes[0] == "float32", "Expected raw elevations, not hillshade"
        x, y = Transformer.from_crs(4326, src.crs, always_xy=True).transform(lons, lats)
        rows, cols = rasterio.transform.rowcol(src.transform, x.ravel(), y.ravel())
        z = src.read(1)[np.array(rows), np.array(cols)].reshape(az.shape)
        valid = np.isfinite(z) & (z > -100) & (z < 5000)
        # Ocean nodata is allowed. Land elevations must cover the northern ranges.
        assert valid[:SAMPLES // 4].mean() > .95, "Incomplete northern DEM coverage"
    # Geometric curvature (no assumed weather/refraction). Recompute the visible
    # envelope at each eye height; moving a single winning peak produces spikes.
    corrected = z - dist * dist / (2 * 6371000)
    profiles = []
    max_angles = []
    for eye in range(0, 3501, 500):
        slopes = np.where(valid, (corrected - eye) / dist, -np.inf)
        winner = slopes.argmax(axis=1)
        ridge = corrected[np.arange(SAMPLES), winner]
        envelope = slopes.max(axis=1)
        ridge = np.where(np.isfinite(envelope), np.maximum(ridge, 0), 0)
        envelope = np.where(np.isfinite(envelope), envelope, -.25)
        # Periodic three-tap filter suppresses single DEM-cell needles.
        envelope = .25 * np.roll(envelope, 1) + .5 * envelope + .25 * np.roll(envelope, -1)
        heights = np.rint(np.clip(ridge / 4095, 0, 1) * 65535).astype(np.uint16)
        angles = np.rint(np.clip((envelope + .25) / .4, 0, 1) * 65535).astype(np.uint16)
        profiles.append(np.stack([angles >> 8, angles & 255, heights >> 8, heights & 255], axis=1).astype(np.uint8))
        max_angles.append(float(np.degrees(np.arctan(envelope.max()))))
    packed = np.stack(profiles)
    out = ROOT / "web" / "src" / "assets"
    out.mkdir(exist_ok=True)
    (out / "horizon.bin").write_bytes(packed.tobytes())
    manifest = dict(source=SERVICE, credit="USGS 3DEP, public domain", export=params,
                    dem_sha256=hashlib.sha256(dem.read_bytes()).hexdigest(),
                    center=CENTER_LATLON, samples=SAMPLES, min_distance_m=MIN_DISTANCE,
                    max_distance_m=MAX_DISTANCE, eye_elevations_m=list(range(0, 3501, 500)),
                    encoding="RGBA8: RG = (slope + 0.25) / 0.4; BA = curvature-corrected elevation / 4095; uint16 big endian",
                    maximum_angles_deg=max_angles)
    (out / "horizon.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(json.dumps(manifest, indent=2))


if __name__ == "__main__":
    main()
