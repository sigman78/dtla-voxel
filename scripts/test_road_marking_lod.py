import unittest

import numpy as np

from tiles import downsample
from voxelize import downsample_road_surface


class RoadMarkingLodTests(unittest.TestCase):
    def test_coarse_paint_is_subdued_without_mutating_full_detail_or_other_cells(self):
        original = np.zeros((4, 4, 4), np.uint16)
        original[:2] = 7
        original[1, 0, :3] = 8
        original[3, 2, 2] = 8  # An unrelated elevated cell must not be substituted.
        ground = np.full((4, 4), 2, np.int32)
        mask = np.zeros((4, 4), bool)
        mask[0, :2] = True
        mask[2, 2] = True
        underlay = np.full((4, 4), 7, np.uint16)
        for scale in (2, 4):
            with self.subTest(scale=scale):
                volume = original.copy()
                expected = original.copy()
                expected[1, 0, :2] = 9 if scale == 2 else 7
                result = downsample_road_surface(volume, scale, ground, mask, underlay, 8, 9)
                np.testing.assert_array_equal(result, downsample(expected, scale))
                np.testing.assert_array_equal(volume, original)


if __name__ == "__main__":
    unittest.main()
