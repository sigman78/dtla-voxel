"""Rasterise the LiDAR point cloud onto the rotated grid.

Grid: column i along u (U_MIN -> U_MAX), row j along -v (V_MAX -> V_MIN), so row 0 is the north-west edge.
The 2023 LA County survey only classifies ground (2), bridge decks (17) and noise (7, 18); everything else is 1.

Writes CACHE/lidar.npz:
  dsm   (2D, 2W) float32  0.5 m  highest non-noise point (NaN where empty)
  gsum, gcnt (D, W)       1 m    ground points: sum of z and count
  bmax  (D, W) float32    1 m    highest bridge-deck point
  n1    (D, W) uint16     1 m    unclassified points
  nl1   (D, W) uint16     1 m    unclassified points that are not the last return (foliage lets the beam through)
  low1  (D, W) float32    1 m    lowest unclassified point (under-sides: overpasses, canopies)
"""
import glob
import multiprocessing as mp
import time

import laspy
import numpy as np
from pyproj import Transformer

from aoi import CACHE, U_MAX, U_MIN, V_MAX, V_MIN, utm_to_uv

W, D = int(U_MAX - U_MIN), int(V_MAX - V_MIN)
_tr = None


def load(path):
    global _tr
    if _tr is None:
        _tr = Transformer.from_crs(3857, 32611, always_xy=True)
    las = laspy.read(path)
    cls = np.asarray(las.classification)
    keep = (cls != 7) & (cls != 18)
    x, y = _tr.transform(np.asarray(las.x)[keep], np.asarray(las.y)[keep])
    u, v = utm_to_uv(x, y)
    i2 = np.floor((u - U_MIN) * 2).astype(np.int64)
    j2 = np.floor((V_MAX - v) * 2).astype(np.int64)
    inside = (i2 >= 0) & (i2 < 2 * W) & (j2 >= 0) & (j2 < 2 * D)
    rn = np.asarray(las.return_number)[keep][inside]
    nr = np.asarray(las.number_of_returns)[keep][inside]
    return (i2[inside].astype(np.int32), j2[inside].astype(np.int32), np.asarray(las.z, np.float32)[keep][inside],
            cls[keep][inside].astype(np.uint8), (rn < nr))


def main():
    files = sorted(glob.glob(str(CACHE / "lidar" / "ept" / "*.laz")))
    dsm = np.full(4 * W * D, -np.inf, np.float32)
    gsum = np.zeros(W * D, np.float64)
    gcnt = np.zeros(W * D, np.uint16)
    bmax = np.full(W * D, -np.inf, np.float32)
    n1 = np.zeros(W * D, np.uint16)
    nl1 = np.zeros(W * D, np.uint16)
    low1 = np.full(W * D, np.inf, np.float32)
    t0, npts = time.time(), 0
    with mp.Pool(max(1, mp.cpu_count() - 1)) as pool:
        for k, (i2, j2, z, cls, nonlast) in enumerate(pool.imap_unordered(load, files, chunksize=8)):
            npts += len(z)
            np.maximum.at(dsm, j2.astype(np.int64) * 2 * W + i2, z)
            c1 = (j2 // 2).astype(np.int64) * W + i2 // 2
            g = cls == 2
            np.add.at(gsum, c1[g], z[g])
            np.add.at(gcnt, c1[g], 1)
            b = cls == 17
            np.maximum.at(bmax, c1[b], z[b])
            u = cls == 1
            np.add.at(n1, c1[u], 1)
            np.add.at(nl1, c1[u & nonlast], 1)
            np.minimum.at(low1, c1[u], z[u])
            if k % 500 == 0:
                print(f"{k}/{len(files)} files, {npts:,} points, {time.time() - t0:.0f}s", flush=True)
    dsm[~np.isfinite(dsm)] = np.nan
    bmax[~np.isfinite(bmax)] = np.nan
    low1[~np.isfinite(low1)] = np.nan
    print(f"{npts:,} points in AOI; dsm coverage {np.isfinite(dsm).mean() * 100:.1f}%, ground cells "
          f"{(gcnt > 0).mean() * 100:.1f}%", flush=True)
    np.savez(CACHE / "lidar.npz", dsm=dsm.reshape(2 * D, 2 * W), gsum=gsum.reshape(D, W).astype(np.float32),
             gcnt=gcnt.reshape(D, W), bmax=bmax.reshape(D, W), n1=n1.reshape(D, W), nl1=nl1.reshape(D, W),
             low1=low1.reshape(D, W))
    print("PREP_LIDAR DONE", flush=True)


if __name__ == "__main__":
    main()
