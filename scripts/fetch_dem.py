"""USGS 3DEP 1 m bare-earth DEM of the same 2023 LA County survey, read straight onto the rotated grid.

Buildings and freeways hide the ground from the LiDAR; USGS's finished DEM already fills those holes. Only the
windows the AOI needs are read from the two 10 x 10 km tiles. Writes CACHE/dtm.npy: (D, W) float32, 1 m cells,
same row/column order as prep_lidar.py.
"""
import numpy as np
import rasterio
from rasterio.enums import Resampling
from rasterio.transform import Affine
from rasterio.vrt import WarpedVRT

from aoi import CACHE, CX, CY, GRID_DEG, U_MAX, U_MIN, V_MAX, V_MIN, uv_to_utm

URL = "https://prd-tnm.s3.amazonaws.com/StagedProducts/Elevation/1m/Projects/CA_LosAngeles_B23/TIFF/USGS_1M_11_{}_CA_LosAngeles_B23.tif"
TILES = ["x38y377", "x38y378"]
W, D = int(U_MAX - U_MIN), int(V_MAX - V_MIN)


def grid_transform():
    """Affine from (col, row) of the rotated 1 m grid to UTM 11N."""
    x0, y0 = uv_to_utm(U_MIN, V_MAX)  # corner of cell (0, 0)
    a = np.radians(GRID_DEG)
    # +col moves along +u, +row moves along -v
    return Affine(np.cos(a), np.sin(a), x0, np.sin(a), -np.cos(a), y0)


def main():
    out = np.full((D, W), np.nan, np.float32)
    tr = grid_transform()
    for t in TILES:
        with rasterio.Env(GDAL_DISABLE_READDIR_ON_OPEN="EMPTY_DIR", CPL_VSIL_CURL_ALLOWED_EXTENSIONS=".tif"), \
                rasterio.open(URL.format(t)) as src, \
                WarpedVRT(src, crs="EPSG:32611", transform=tr, width=W, height=D, resampling=Resampling.bilinear,
                          src_nodata=src.nodata, nodata=np.nan, dtype="float32") as vrt:
            a = vrt.read(1)
            m = np.isfinite(a) & (a > -100)
            out[m] = a[m]
            print(t, src.crs, f"{m.mean() * 100:.1f}% of AOI", flush=True)
    print(f"DTM range {np.nanmin(out):.1f}..{np.nanmax(out):.1f} m, missing {np.isnan(out).mean() * 100:.2f}%")
    np.save(CACHE / "dtm.npy", out)
    print("DEM DONE", flush=True)


if __name__ == "__main__":
    main()
