import unittest

import numpy as np
import trimesh

from disney_model import shell_voxels, validate_transform


class DisneyMeshTests(unittest.TestCase):
    def test_overhang_and_hollow_volume_are_not_filled_downward(self):
        box = trimesh.creation.box(extents=[8, 8, 8])
        box.apply_translation([4.5, 14.5, 4.5])
        voxels, origin = shell_voxels([(box, 1)])
        world = {tuple(v[:3]+origin) for v in voxels}
        self.assertIn((4, 18, 4), world)  # modeled top shell
        self.assertNotIn((4, 14, 4), world)  # hollow interior
        self.assertNotIn((4, 0, 4), world)  # air below suspended mesh
        self.assertTrue((voxels[:, 3] == 1).all())

    def test_glazing_wins_only_intersecting_surface_voxels(self):
        steel = trimesh.creation.box(extents=[4, 4, 4])
        steel.apply_translation([2.5, 2.5, 2.5])
        glass = steel.copy()
        voxels, _ = shell_voxels([(glass, 2), (steel, 1)])
        self.assertTrue((voxels[:, 3] == 2).all())

    def test_transform_rejects_reflection_and_nonuniform_scale(self):
        good = np.array([[.5, 0, 0, 2600], [0, 0, .5, 56],
                         [0, -.5, 0, 760], [0, 0, 0, 1]])
        validate_transform(good)
        reflected = good.copy()
        reflected[2, :3] *= -1
        with self.assertRaises(ValueError):
            validate_transform(reflected)
        squashed = good.copy()
        squashed[0, 0] = .6
        with self.assertRaises(ValueError):
            validate_transform(squashed)


if __name__ == "__main__":
    unittest.main()
