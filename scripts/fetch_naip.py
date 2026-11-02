"""NAIP aerial imagery (USDA, public domain, 0.6 m, RGB + NIR) for the AOI from Microsoft Planetary Computer.

Only the windows covering the AOI are read from the cloud-optimised GeoTIFFs, then mosaicked onto one UTM 11N
grid at 0.6 m and saved as CACHE/naip.tif (4 bands). The newest California survey that covers the AOI is used.
"""
import numpy as np
import rasterio
import requests
from rasterio.enums import Resampling
from rasterio.transform import from_origin
from rasterio.vrt import WarpedVRT

from aoi import CACHE, bbox_lonlat, corners_uv, uv_to_utm

STAC = "https://planetarycomputer.microsoft.com/api/stac/v1/search"
TOKEN = "https://planetarycomputer.microsoft.com/api/sas/v1/token/naip"
RES = 0.6
OUT = CACHE / "naip.tif"


def main():
    s, w, n, e = bbox_lonlat(60)
    r = requests.post(STAC, json={"collections": ["naip"], "bbox": [w, s, e, n], "limit": 200}, timeout=60)
    r.raise_for_status()
    items = r.json()["features"]
    years = sorted({it["properties"]["datetime"][:4] for it in items})
    print("NAIP years available:", years)
    year = years[-1]
    items = [it for it in items if it["properties"]["datetime"][:4] == year]
    print(f"using {year}: {len(items)} quarter-quads")
    sas = requests.get(TOKEN, timeout=60).json()["token"]

    xs, ys = zip(*[uv_to_utm(u, v) for u, v in corners_uv(60)])
    x0, y0, x1, y1 = min(xs), min(ys), max(xs), max(ys)
    W, H = int((x1 - x0) / RES) + 1, int((y1 - y0) / RES) + 1
    tr = from_origin(x0, y1, RES, RES)
    out = np.zeros((4, H, W), np.uint8)
    for it in items:
        href = it["assets"]["image"]["href"] + "?" + sas
        with rasterio.open(href) as src, WarpedVRT(src, crs="EPSG:32611", transform=tr, width=W, height=H,
                                                    resampling=Resampling.bilinear, nodata=0) as vrt:
            a = vrt.read()
            m = a[:3].sum(0) > 0
            out[:, m] = a[:, m]
            print(it["id"], f"{m.mean() * 100:.1f}% of AOI", flush=True)
    print(f"empty pixels: {(out[:3].sum(0) == 0).mean() * 100:.2f}%")
    with rasterio.open(OUT, "w", driver="GTiff", width=W, height=H, count=4, dtype="uint8", crs="EPSG:32611",
                       transform=tr, compress="deflate", tiled=True, predictor=2) as dst:
        dst.write(out)
        dst.update_tags(year=year)
    print(f"NAIP DONE {OUT} {OUT.stat().st_size / 1e6:.1f} MB", flush=True)


if __name__ == "__main__":
    main()
