"""Check the rebuilt Flower Street tiles and unchanged terrain/landmark metadata."""
import argparse
import hashlib
import json
from pathlib import Path

import numpy as np
from scipy import ndimage

from aoi import CACHE, WEB_DATA
from audit_vegetation import tile_heights


def validate(baseline, current):
    with np.load(Path(__file__).parent/'fixtures'/'flower-vegetation.npz') as p:
        bounds=p['bounds'].tolist()
        before=tile_heights(bounds,baseline)
        after=tile_heights(bounds,current)
        foliage=tile_heights(bounds,current,'1f')
        buildings=p['building']>0
        np.testing.assert_array_equal(before[buildings],after[buildings],err_msg='Mapped building heights changed')
        objects,n=ndimage.label((p['published']>3)&~buildings)
        entries=[]
        for i in range(1,n+1):
            m=objects==i
            if m.sum()<=10: continue
            remaining=int((m&(after>3)).sum())
            leaves=int((m&(foliage>3)).sum())
            assert remaining <= 3, f'Object {i} is still a solid tower'
            assert leaves >= .85*m.sum(), f'Object {i} lost its crown'
            entries.append(dict(id=i,cells=int(m.sum()),remainingSolidCells=remaining,foliageCells=leaves))
        assert len(entries)==4
    old=json.loads((baseline/'meta.json').read_text())
    new=json.loads((current/'meta.json').read_text())
    unchanged=[]
    for key in ['palette','roofDiagnostics','landmarkDiagnostics','facadeDiagnostics','roadMarkingDiagnostics',
                'landmarkVolumeDiagnostics','labels','obstructionLights','obstructionLightDiagnostics']:
        assert old[key]==new[key], f'Unexpected change in {key}'
        unchanged.append(key)
    digest=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
    assert digest(baseline/'terrain.bin')==digest(current/'terrain.bin'), 'Terrain fallback changed'
    # lamp_voxels excludes bmask/crown_top and deduplicates nearby placements.
    # Corrected crowns therefore legitimately change these procedural positions.
    old_lamps={tuple(p) for p in old['lamps']}
    new_lamps={tuple(p) for p in new['lamps']}
    return dict(flower=entries,unchanged=unchanged+['terrain.bin','Flower mapped-building heights'],
                proceduralLamps=dict(removed=len(old_lamps-new_lamps),added=len(new_lamps-old_lamps)),
                classification=new['vegetationDiagnostics'])


if __name__=='__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('--baseline',type=Path,default=CACHE/'vegetation-baseline')
    parser.add_argument('--current',type=Path,default=WEB_DATA)
    parser.add_argument('--output',type=Path,default=CACHE/'vegetation-review'/'validation.json')
    args=parser.parse_args()
    result=validate(args.baseline,args.current)
    args.output.parent.mkdir(parents=True,exist_ok=True)
    args.output.write_text(json.dumps(result,indent=2),encoding='utf-8')
    print(json.dumps(result,indent=2))
