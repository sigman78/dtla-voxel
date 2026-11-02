import os
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

import numpy as np
from shapely.geometry import box

from palette import C, M_CITY_HALL, M_ROOF, M_WALL, pal
from roof_pilot import RoofPilot, apply_roof_pilot


class RoofPilotTests(unittest.TestCase):
    def setUp(self):
        self.env = patch.dict(os.environ, {"DTLA_ROOF_PILOT": "1", "DTLA_ROOF_AUDIT": "0"})
        self.env.start()
        self.addCleanup(self.env.stop)
        self.footprint = box(1, 1, 7, 7)
        self.spec = RoofPilot("test", "Test Roof", ("way", 12), (4, 4), 36)
        shape = (8, 8)
        ground = np.tile(np.arange(2, 10), (8, 1)).astype(np.int32)
        top = 20-ground
        top[2:5, 1] += 1
        top[1, 1] += 10  # measured plane differs too much: never accept this edit
        top[5:7, 5:7] = 23-ground[5:7, 5:7]  # existing compact elevated feature
        wall = np.full(shape, pal("#cccccc", M_WALL), np.uint16)
        wall[4, 4] = pal("#ded6c8", M_CITY_HALL)
        roof = np.full(shape, C["roof_default"], np.uint16)
        roof[2, 2] = C["garden_roof"]
        replacement = np.zeros(shape, bool)
        replacement[3, 3] = True
        self.layers = dict(osm=SimpleNamespace(areas=[(12, "way", {"building": "yes"}, self.footprint)]),
                           bmask=np.ones(shape, bool), topi=top, g=ground,
                           dtm=ground+100, base=100, basewall=wall, roofc=roof,
                           roofMeasuredAbsolute=np.full(shape, 120.12),
                           landmarkVolumes=SimpleNamespace(replacement_mask=replacement))
        self.layers["roofMeasuredAbsolute"][5:7, 5:7] = 123
        self.cleaner = Mock(side_effect=self.clean)
        self.module = patch.dict("sys.modules", {"roof_cleanup": SimpleNamespace(clean_roof=self.cleaner)})
        self.module.start()
        self.addCleanup(self.module.stop)

    @staticmethod
    def clean(surface, mask):
        # The classifier itself has its own tests. This supplies explicit accepted
        # deck/elevated masks to exercise datum conversion and importer boundaries.
        elevated = np.zeros_like(mask)
        elevated[4:6, 4:6] = mask[4:6, 4:6]  # global [5:7,5:7], cropped [1:7,1:7]
        flat = mask & ~elevated
        deck = np.full(mask.shape, np.nan)
        deck[elevated] = 120
        classes = dict(flat=flat, elevated=elevated, uncertain=~mask,
                       edited=flat, planes=flat.astype(np.uint32), deckElevation=deck)
        return surface, classes, dict(planes=1)

    def test_absolute_plane_stays_level_over_terrain_and_changes_are_bounded(self):
        before = self.layers["topi"].copy()
        ground = self.layers["g"].copy()
        apply_roof_pilot(self.layers, [self.spec])
        top = self.layers["topi"]
        for row in (2, 3, 4):
            self.assertEqual(ground[row, 1]+top[row, 1], 20)
        self.assertEqual(top[1, 1], before[1, 1])
        self.assertLessEqual(np.abs(top-before).max(), 3)
        np.testing.assert_array_equal(self.layers["g"], ground)

    def test_footprint_model_garden_landmark_and_nested_owner_are_protected(self):
        before = self.layers["topi"].copy()
        before[0, 0] += 1
        self.layers["topi"] = before.copy()
        owners = np.ones(before.shape, np.uint32)
        owners[2, 1] = 2  # a distinct nested footprint wins the source ownership raster
        self.layers["roofBuildingId"] = owners
        self.layers["blds"] = [(12, {"building": "yes"}, self.footprint),
                               (13, {"building": "yes"}, box(1, 2, 2, 3))]
        walls = self.layers["basewall"].copy()
        apply_roof_pilot(self.layers, [self.spec])
        for point in ((0, 0), (3, 3), (2, 2), (4, 4), (2, 1)):
            self.assertEqual(self.layers["topi"][point], before[point])
        np.testing.assert_array_equal(self.layers["basewall"], walls)

    def test_equipment_changes_material_only_above_supported_deck(self):
        before = self.layers["topi"].copy()
        apply_roof_pilot(self.layers, [self.spec])
        self.assertEqual(self.layers["topi"][5, 5], before[5, 5])
        self.assertEqual(self.layers["roofEquipmentBottom"][5, 5], 20)
        material = int(self.layers["roofEquipmentMaterial"][5, 5])
        self.assertEqual(pal.entries[material][3], M_ROOF)
        self.assertEqual(self.layers["roofc"][5, 5], material)
        self.assertEqual(np.count_nonzero(self.layers["roofEquipmentBottom"]), 4)

    def test_partially_erased_equipment_rejects_whole_measured_component(self):
        self.layers["topi"][5, 5] = 20-self.layers["g"][5, 5]  # no voxel height survives above its deck
        before = self.layers["roofc"].copy()
        apply_roof_pilot(self.layers, [self.spec])
        self.assertFalse(self.layers["roofEquipmentBottom"].any())
        self.assertFalse(self.layers["roofEquipmentMaterial"].any())
        np.testing.assert_array_equal(self.layers["roofc"], before)
        self.assertEqual(self.layers["roofDiagnostics"][0]["rejectedEquipmentCells"], 4)

    def test_too_small_elevated_component_does_not_produce_roof_speckles(self):
        def tiny(surface, mask):
            cleaned, classes, diagnostic = self.clean(surface, mask)
            classes["elevated"][5, 5] = False  # three connected cells, all with surviving height
            return cleaned, classes, diagnostic
        self.cleaner.side_effect = tiny
        apply_roof_pilot(self.layers, [self.spec])
        self.assertFalse(self.layers["roofEquipmentBottom"].any())
        self.assertFalse(self.layers["roofEquipmentMaterial"].any())

    def test_disable_switch_preserves_all_input_data_and_allocates_no_colors(self):
        before = {key: value.copy() for key, value in self.layers.items() if isinstance(value, np.ndarray)}
        palette_before = list(pal.entries)
        with patch.dict(os.environ, {"DTLA_ROOF_PILOT": "0"}):
            apply_roof_pilot(self.layers, [self.spec])
        self.cleaner.assert_not_called()
        for key, value in before.items():
            np.testing.assert_array_equal(self.layers[key], value)
        self.assertEqual(pal.entries, palette_before)
        self.assertFalse(self.layers["roofEquipmentBottom"].any())
        self.assertFalse(self.layers["roofEquipmentMaterial"].any())


if __name__ == "__main__":
    unittest.main()
