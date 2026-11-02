"""Rooftop equipment must not recolor the facade below its supporting deck."""
import unittest
from unittest.mock import patch

import numpy as np

from palette import C
from voxelize import fill_band


class RoofMaterialTests(unittest.TestCase):
    def test_equipment_material_is_bounded_vertically_and_spatially(self):
        shape = (4, 4)
        zero = np.zeros(shape, np.int32)
        layers = {key: zero.copy() for key in (
            "boti", "deck", "deck_top", "crown_top", "crown_bot", "leafc",
            "canopy", "canopy_top", "nd_b", "rib", "rib_top")}
        layers.update(g=np.full(shape, 2), gcol=np.full(shape, C["paving"]),
                      bmask=np.ones(shape, bool), topi=np.full(shape, 8),
                      basewall=np.full(shape, 71), roofc=np.full(shape, 72),
                      roofEquipmentBottom=zero.copy(), roofEquipmentMaterial=zero.copy())
        layers["roofEquipmentBottom"][1, 1] = 7
        layers["roofEquipmentMaterial"][1, 1] = 73
        with patch("voxelize.D", 4), patch("voxelize.W", 4):
            volume = fill_band(layers, 0, 4, 12, np.empty((0, 4), np.int64))
        np.testing.assert_array_equal(volume[2:7, 1, 1], 71)
        np.testing.assert_array_equal(volume[7:9, 1, 1], 73)
        self.assertEqual(volume[9, 1, 1], 72)
        np.testing.assert_array_equal(volume[2:9, 1, 2], 71)
        self.assertEqual(volume[10, 1, 1], 0)


if __name__ == "__main__":
    unittest.main()
