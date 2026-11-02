from dataclasses import replace
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import numpy as np
from shapely.geometry import box

from palette import C, M_DISNEY, pal
from landmark_volumes import LandmarkVolumes, VolumeSpec, prepare_landmark_volumes


class LandmarkVolumeTests(unittest.TestCase):
    def setUp(self):
        self.temp = TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / "shell.npz"
        self.spec = VolumeSpec("test", ("relation", 12), self.path, (4, 4), 2, 10, 20)
        self.feature = (12, "relation", {"building": "yes"}, box(2, 2, 6, 6))
        self.neighbour = (13, "way", {"building": "yes"}, box(5, 2, 6, 6))
        shape = (8, 8)
        zero = np.zeros(shape, np.int32)
        bm = np.zeros(shape, bool)
        bm[2:6, 2:6] = True
        self.layers = dict(osm=SimpleNamespace(areas=[self.feature, self.neighbour]),
                           g=np.full(shape, 2, np.int32), gcol=np.full(shape, C["paving"], np.uint16),
                           bmask=bm, topi=np.full(shape, 8), boti=zero.copy(),
                           basewall=np.full(shape, pal("#c5cbcc", M_DISNEY), np.uint16),
                           roofc=np.full(shape, C["roof_default"], np.uint16))
        self.layers["roofc"][3, 3] = C["garden_roof"]
        for key in ("deck", "crown_top", "crown_bot", "leafc", "canopy", "canopy_top",
                    "nd_b", "rib", "rib_top", "deck_top"):
            self.layers[key] = zero.copy()

    def write_shell(self):
        np.savez_compressed(self.path, origin=np.array([0, 0, 0], np.int32),
                            voxels=np.array([[4, 2, 4, 1], [4, 6, 4, 1],  # two separated shell intervals
                                             [3, 4, 4, 2],  # actual glazing
                                             [4, 1, 4, 1],  # below physical ground
                                             [3, 4, 3, 1],  # planted roof
                                             [5, 4, 4, 1],  # neighbouring building
                                             [0, 4, 0, 1]], np.uint16))  # outside footprint buffer

    def test_sparse_band_fill_retains_air_gaps_ground_garden_and_neighbour(self):
        from voxelize import fill_band
        self.write_shell()
        prepared = prepare_landmark_volumes(self.layers, [self.spec])
        self.layers["landmarkVolumes"] = prepared
        with patch("voxelize.D", 8), patch("voxelize.W", 8):
            volume = fill_band(self.layers, -1, 9, 12, np.empty((0, 4), np.int64))
        self.assertNotEqual(volume[2, 5, 4], 0)
        self.assertNotEqual(volume[6, 5, 4], 0)
        np.testing.assert_array_equal(volume[3:6, 5, 4], 0)  # never fill a shell down to ground
        self.assertEqual(volume[0, 5, 4], C["soil"])
        self.assertEqual(volume[1, 5, 4], C["paving"])
        self.assertNotEqual(volume[4, 5, 5], 0)  # neighbour's original solid column
        self.assertEqual(volume[9, 4, 3], C["garden_roof"])
        self.assertEqual(pal.entries[int(volume[4, 5, 3])][3], 29)
        self.assertEqual(prepared.max_height, 7)
        diagnostic = prepared.diagnostics[0]
        self.assertEqual(diagnostic["status"], "applied")
        self.assertEqual(diagnostic["belowGroundClipped"], 1)
        self.assertEqual(diagnostic["gardenClipped"], 1)
        self.assertEqual(diagnostic["neighbourClipped"], 1)
        self.assertEqual(diagnostic["outsideFootprintBuffer"], 1)

    def test_missing_asset_or_invalid_identity_never_clears_measured_building(self):
        prepared = prepare_landmark_volumes(self.layers, [self.spec])
        self.assertFalse(prepared.replacement_mask.any())
        self.assertEqual(prepared.diagnostics[0]["status"], "asset_missing")
        self.write_shell()
        for spec in (replace(self.spec, identity=("way", 12)),
                     replace(self.spec, anchor=(50, 50)), replace(self.spec, min_area=100)):
            prepared = prepare_landmark_volumes(self.layers, [spec])
            self.assertFalse(prepared.replacement_mask.any())
            self.assertEqual(len(prepared.voxels), 0)

    def test_unregistered_shell_outside_footprint_leaves_legacy_volume_intact(self):
        np.savez_compressed(self.path, origin=np.array([30, 0, 30], np.int32),
                            voxels=np.array([[0, 4, 0, 1]], np.uint16))
        prepared = prepare_landmark_volumes(self.layers, [self.spec])
        self.assertFalse(prepared.replacement_mask.any())
        self.assertEqual(len(prepared.voxels), 0)

    def test_peripheral_legacy_columns_outside_model_envelope_are_preserved(self):
        from voxelize import fill_band
        shape = (16, 16)
        layers = {k: np.zeros(shape, v.dtype) if isinstance(v, np.ndarray) else v
                  for k, v in self.layers.items()}
        layers["osm"] = SimpleNamespace(areas=[(12, "relation", {"building": "yes"}, box(1, 1, 13, 13))])
        layers["bmask"][1:13, 1:13] = True
        layers["g"][:] = 2
        layers["gcol"][:] = C["paving"]
        layers["topi"][:] = 8
        layers["basewall"][:] = pal("#c5cbcc", M_DISNEY)
        layers["roofc"][:] = C["roof_default"]
        spec = replace(self.spec, anchor=(7, 7), min_area=100, max_area=200)
        np.savez_compressed(self.path, origin=np.array([0, 0, 0], np.int32),
                            voxels=np.array([[3, 2, 3, 1], [3, 6, 3, 1], [4, 6, 4, 1]], np.uint16))
        layers["landmarkVolumes"] = prepare_landmark_volumes(layers, [spec])
        with patch("voxelize.D", 16), patch("voxelize.W", 16):
            volume = fill_band(layers, 0, 16, 12, np.empty((0, 4), np.int64))
        self.assertEqual(volume[4, 3, 3], 0)  # main hall's shell gap stays open
        self.assertNotEqual(volume[4, 10, 10], 0)  # unmodeled service wing stays solid
        self.assertFalse(layers["landmarkVolumes"].replacement_mask[10, 10])

    def test_coarse_fallback_retains_thin_plane_without_filling_gaps_or_neighbours(self):
        from tiles import downsample
        fine = np.zeros((24, 8, 24), np.uint16)
        fine[:8, :, 0] = 101  # a 1 m plane occupies only one eighth of its block
        fine[7, :, 0] = 103  # topmost source palette represents the surviving block
        fine[16:24, :, 0] = 102  # separate upper shell leaves an entire 8 m gap
        zz, rr, cc = np.nonzero(fine)
        voxels = np.column_stack((rr, cc, zz, fine[zz, rr, cc])).astype(np.int64)
        shells = LandmarkVolumes(np.zeros((8, 24), bool), voxels, [])
        coarse = downsample(fine, 8)
        self.assertEqual(coarse[0, 0, 0], 0)  # ordinary majority downsampling loses the plane
        coarse[2, 0, 0] = 777  # an existing generic city cell must win
        self.assertEqual(shells.preserve_coarse_silhouette(coarse), 1)
        self.assertEqual(coarse[0, 0, 0], 103)
        self.assertEqual(coarse[2, 0, 0], 777)
        self.assertEqual(coarse[1, 0, 0], 0)
        self.assertFalse(coarse[:, :, 1:].any())
        shuffled = LandmarkVolumes(shells.replacement_mask, voxels[::-1], [])
        comparison = np.zeros_like(coarse)
        comparison[2, 0, 0] = 777
        shuffled.preserve_coarse_silhouette(comparison)
        np.testing.assert_array_equal(comparison, coarse)


if __name__ == "__main__":
    unittest.main()
