import unittest

import numpy as np

from layers import trim_edge_slivers


def tower_on_podium():
    """A 200 m tower (rows 5-14, cols 5-14) on a 25 m podium (rows 2-17, cols 2-17)."""
    topi = np.zeros((20, 20), np.int32)
    topi[2:18, 2:18] = 25
    topi[5:15, 5:15] = 200
    return topi, topi > 0


class EdgeSliverTests(unittest.TestCase):
    def test_full_height_sliver_beside_tower_drops_to_podium(self):
        topi, bmask = tower_on_podium()
        topi[8:10, 16] = 198  # a 2-cell column on the podium edge, as tall as the tower
        trim_edge_slivers(topi, bmask, keep=np.zeros_like(bmask))
        self.assertTrue((topi[8:10, 16] == 25).all())
        self.assertTrue((topi[5:15, 5:15] == 200).all())

    def test_sliver_over_street_leaves_the_footprint(self):
        topi = np.zeros((20, 20), np.int32)
        topi[5:15, 5:15] = 200  # no podium: the tower meets the street
        topi[9, 15] = 199
        bmask = topi > 0
        trim_edge_slivers(topi, bmask, keep=np.zeros_like(bmask))
        self.assertFalse(bmask[9, 15])
        self.assertTrue(bmask[5:15, 5:15].all())

    def test_rooftop_mast_and_crown_stay(self):
        topi, bmask = tower_on_podium()
        topi[9, 9] = 240  # mast in the middle of the roof
        topi[5, 5:15] = 230  # 1-cell crown rim on the tower's edge
        before = topi.copy()
        trim_edge_slivers(topi, bmask, keep=np.zeros_like(bmask))
        self.assertTrue((topi == before).all())

    def test_kept_cells_stay(self):
        topi, bmask = tower_on_podium()
        topi[8:10, 16] = 198
        keep = np.zeros_like(bmask)
        keep[8:10, 16] = True
        trim_edge_slivers(topi, bmask, keep=keep)
        self.assertTrue((topi[8:10, 16] == 198).all())


if __name__ == "__main__":
    unittest.main()
