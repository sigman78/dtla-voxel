import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np
from scipy import ndimage

from vegetation import classify_edges


class VegetationTests(unittest.TestCase):
    def scene(self):
        shape = (36, 40)
        self.top = np.zeros(shape)
        self.ndvi = np.full(shape, -.08)
        self.passthru = np.zeros(shape)
        self.count = np.full(shape, 16)
        self.low = np.zeros(shape)
        self.buildings = np.zeros(shape, bool)
        self.buildings[:, :6] = True
        self.protected = np.zeros(shape, bool)

    def classify(self):
        return classify_edges(self.top,self.top,self.ndvi,self.passthru,self.count,self.low,self.buildings,
                              protected=self.protected)

    def crown(self):
        rr, cc = np.indices(self.top.shape)
        radius = np.hypot(rr-18,cc-13)
        mask = radius <= 6
        self.top[mask] = 12-.12*radius[mask]**2
        self.low[mask] = self.top[mask]-1
        self.passthru[mask & (radius >= 4)] = .65
        return mask

    def test_dark_dense_crown_recovers_solid_interior(self):
        self.scene(); crown=self.crown()
        supported,_,audit=self.classify()
        self.assertTrue(supported[18,13])
        self.assertGreater((supported & crown).sum(),80)
        self.assertEqual(len(audit['crowns']),1)
        self.assertFalse(supported[self.buildings].any())

    def test_flat_kiosk_with_porous_edges_stays_structural(self):
        self.scene()
        self.top[12:25,8:21]=9
        rim=(self.top>0)&~ndimage.binary_erosion(self.top>0,iterations=2)
        self.passthru[rim]=.65
        supported,_,_=self.classify()
        self.assertFalse(supported.any())

    def test_sloping_roof_is_not_a_crown(self):
        self.scene()
        rr,cc=np.indices(self.top.shape)
        mask=(rr>=12)&(rr<25)&(cc>=8)&(cc<21)
        self.top[mask]=4+.15*cc[mask]
        self.passthru[mask]=.7
        self.assertFalse(self.classify()[0].any())

    def test_thin_eave_preserves_air_below(self):
        self.scene()
        self.top[10:24,6]=7; self.low[10:24,6]=6.5
        self.passthru[10:24,6]=.8
        supported,attachment,_=self.classify()
        self.assertFalse(supported.any())
        self.assertTrue(attachment[10:24,6].all())

    def test_dome_awning_at_wall_is_not_tree(self):
        self.scene()
        rr,cc=np.indices(self.top.shape)
        mask=(rr>=12)&(rr<23)&(cc>=6)&(cc<10)
        self.top[mask]=6-0.03*(rr[mask]-17)**2
        self.low[mask]=self.top[mask]-.5
        self.passthru[mask]=.8
        self.assertFalse(self.classify()[0].any())

    def test_protected_features_and_mapped_buildings_never_reclassified(self):
        self.scene(); self.protected=self.crown()
        supported,attachments,_=self.classify()
        self.assertFalse(supported.any())
        self.assertFalse(attachments[self.protected].any())
        self.assertFalse(attachments[self.buildings].any())

    def test_wide_domed_awning_attached_along_wall_is_not_tree(self):
        self.scene()
        rr,cc=np.indices(self.top.shape)
        mask=(rr>=10)&(rr<27)&(cc>=6)&(cc<14)
        self.top[mask]=12-.04*(rr[mask]-18)**2-.08*(cc[mask]-9)**2
        self.low[mask]=self.top[mask]-.5
        self.passthru[mask]=.8
        self.ndvi[mask]=.2  # even a misleading green spectral vote is not enough
        self.assertFalse(self.classify()[0].any())

    def test_uncertain_broad_crown_does_not_become_wall_attachment(self):
        self.scene()
        self.top[10:27,6:14]=10; self.low[10:27,6:14]=8
        self.passthru[10:27,6:14]=.6
        supported,attachments,_=self.classify()
        self.assertFalse(supported.any())  # insufficient shape evidence
        self.assertFalse(attachments[10:27,6:14].any())

    def test_sparse_or_missing_returns_do_not_prove_tree_or_attachment(self):
        self.scene(); self.crown(); self.count[:]=1; self.low[:]=np.nan
        supported,attachments,_=self.classify()
        self.assertFalse(supported.any()); self.assertFalse(attachments.any())

    def test_empty_building_map_is_noop(self):
        self.scene(); self.crown(); self.buildings[:]=False
        supported,attachments,_=self.classify()
        self.assertFalse(supported.any()); self.assertFalse(attachments.any())

    def test_elevated_flag_keeps_measured_vertical_span(self):
        self.scene()
        self.top[15:18,6]=11; self.low[15:18,6]=6; self.passthru[15:18,6]=.6
        supported,attachments,_=self.classify()
        self.assertFalse(supported.any()); self.assertTrue(attachments[15:18,6].all())

    def test_flower_street_dense_interiors(self):
        with np.load(Path(__file__).parent/'fixtures'/'flower-vegetation.npz') as p:
            supported,attachments,_=classify_edges(p['top'],p['mean'],p['ndvi'],p['passthru'],p['count'],p['low'],p['building']>0)
            objects,n=ndimage.label((p['published']>3)&(p['building']==0))
            towers=[objects==i for i in range(1,n+1) if (objects==i).sum()>10]
            self.assertEqual(len(towers),4)
            for tower in towers:
                self.assertGreaterEqual((supported&tower).sum()/tower.sum(),.9)
            self.assertFalse(supported[p['building']>0].any())
            self.assertFalse(attachments[p['building']>0].any())

    def test_attachment_voxels_do_not_fill_to_ground(self):
        import voxelize
        from palette import C
        shape=(5,5)
        keys=['g','gcol','bmask','topi','boti','basewall','roofc','deck','deck_top','crown_top','crown_bot',
              'leafc','canopy','canopy_top','nd_b','rib','rib_top','attachment_top','attachment_bot','attachment_material']
        layers={k:np.zeros(shape,np.int32) for k in keys}
        for k in ['bmask','deck','canopy','rib']: layers[k]=layers[k].astype(bool)
        layers['g'][:]=2; layers['gcol'][:]=C['paving']
        layers['attachment_top'][2,2]=8; layers['attachment_bot'][2,2]=6
        layers['attachment_material'][2,2]=C['roof_default']
        with patch.multiple(voxelize,W=5,D=5):
            vol=voxelize.fill_band(layers,0,5,12,np.empty((0,4),np.int64))
        self.assertTrue((vol[2:8,2,2]==0).all())
        self.assertTrue((vol[8:10,2,2]==C['roof_default']).all())
        self.assertTrue((vol[10:,2,2]==0).all())


if __name__=='__main__': unittest.main()
