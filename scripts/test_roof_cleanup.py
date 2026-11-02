import unittest

import numpy as np

from roof_cleanup import MAX_EDIT, clean_roof


class RoofCleanupTests(unittest.TestCase):
    def test_absolute_flat_roof_over_sloping_terrain(self):
        rr, cc = np.indices((24, 28))
        terrain = 80 + cc*0.35
        surface = 144.34 + np.where((rr+cc) % 2, .03, -.03)
        mask = np.ones(surface.shape, bool)
        cleaned, classes, diagnostic = clean_roof(surface, mask)
        self.assertTrue(classes['flat'].all())
        self.assertLess(np.ptp(cleaned[2:-2, 2:-2]), 1e-8)
        self.assertGreater(np.ptp((surface-terrain)[mask]), 9)
        self.assertAlmostEqual(float(np.median(cleaned)), 144.34)
        self.assertLessEqual(diagnostic['maxChange'], MAX_EDIT)

    def test_multiple_setback_tiers_remain_separate(self):
        surface = np.full((30, 32), 100.0)
        surface[:, 16:] = 104.5
        cleaned, classes, diagnostic = clean_roof(surface, np.ones(surface.shape, bool))
        np.testing.assert_array_equal(cleaned, surface)
        self.assertEqual(len(diagnostic['planes']), 2)
        self.assertTrue(classes['flat'].all())
        self.assertFalse(classes['edited'].any())
        self.assertEqual(len(np.unique(classes['planes'])), 2)

    def test_thin_mast_outlier_and_nan_preserved(self):
        surface = np.full((25, 25), 100.0)
        surface[9, 9] = 125.0
        surface[16, 16] = 1e12
        surface[4, 4] = np.nan
        original = surface.copy()
        mask = np.ones(surface.shape, bool)
        cleaned, classes, diagnostic = clean_roof(surface, mask)
        np.testing.assert_array_equal(cleaned, original)
        self.assertTrue(classes['uncertain'][9, 9])
        self.assertTrue(classes['uncertain'][16, 16])
        self.assertFalse(classes['elevated'][9, 9])
        self.assertEqual(diagnostic['noDataCells'], 1)
        np.testing.assert_array_equal(surface, original)

    def test_pitched_roof_and_shallow_ramp_are_not_flattened(self):
        rr, cc = np.indices((32, 36))
        for slope in (.25, .025):
            surface = 100.0 + slope*cc
            cleaned, classes, _ = clean_roof(surface, np.ones(surface.shape, bool))
            np.testing.assert_array_equal(cleaned, surface)
            self.assertFalse(classes['flat'].any())

    def test_curved_roof_is_not_flattened_even_at_horizontal_apex(self):
        rr, cc = np.indices((32, 36))
        for surface in (100 + .02*(cc-18)**2, 110 - .025*((rr-16)**2+(cc-18)**2)):
            cleaned, classes, _ = clean_roof(surface, np.ones(surface.shape, bool))
            np.testing.assert_array_equal(cleaned, surface)
            self.assertFalse(classes['flat'].any())

    def test_compact_elevated_objects_keep_measured_geometry_and_deck_reference(self):
        surface = np.full((36, 36), 100.0)
        surface[8:11, 8:11] = 102.4
        surface[18:26, 18:26] = 103.6  # large enough to be a separately flat top
        cleaned, classes, diagnostic = clean_roof(surface, np.ones(surface.shape, bool))
        np.testing.assert_array_equal(cleaned, surface)
        self.assertTrue(classes['elevated'][8:11, 8:11].all())
        self.assertTrue(classes['elevated'][18:26, 18:26].all())
        self.assertTrue((classes['deckElevation'][classes['elevated']] == 100).all())
        self.assertFalse(classes['flat'][18:26, 18:26].any())
        self.assertEqual(len(diagnostic['elevatedCandidates']), 2)
        self.assertIn('unverified', diagnostic['elevatedCandidates'][0]['function'])

    def test_boundary_mask_and_no_data_are_unchanged_and_output_is_deterministic(self):
        rng = np.random.default_rng(52)
        surface = 100+rng.uniform(-.18, .18, (28, 30))
        mask = np.zeros(surface.shape, bool)
        mask[3:25, 3:27] = True
        a = clean_roof(surface, mask)
        b = clean_roof(surface, mask)
        np.testing.assert_array_equal(a[0][~mask], surface[~mask])
        np.testing.assert_array_equal(a[0], b[0])
        for key in a[1]:
            np.testing.assert_array_equal(a[1][key], b[1][key])
        self.assertEqual(a[2], b[2])
        self.assertEqual(clean_roof(np.full((4, 4), np.nan), np.ones((4, 4), bool))[2]['changedCells'], 0)


if __name__ == '__main__':
    unittest.main()
