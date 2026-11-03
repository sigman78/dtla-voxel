"""Inspect a bounded vegetation/building case using cached survey inputs and exported tiles."""
import argparse
import gzip
import json

import numpy as np
import rasterio
import rasterio.features
from affine import Affine
from PIL import Image, ImageDraw
from rasterio.enums import Resampling
from rasterio.vrt import WarpedVRT
from rasterio.windows import Window
from scipy import ndimage

from aoi import CACHE, WEB_DATA
from fetch_dem import grid_transform
from layers import W, D, wall_clean
from osm import OSM


def tile_heights(bounds, data_dir=WEB_DATA, level='1'):
    c0,r0,c1,r1=bounds
    heights=np.zeros((r1-r0,c1-c0),np.float32)
    for ty in range(r0//128,(r1-1)//128+1):
        for tx in range(c0//128,(c1-1)//128+1):
            data=gzip.decompress((data_dir/f'tiles/{level}/{tx}_{ty}.bin').read_bytes())
            counts=np.frombuffer(data,np.uint16,130*130)
            ground=np.frombuffer(data,np.uint8,130*130,130*130*2)
            runs=np.frombuffer(data,np.uint16,int(counts.sum())*3,130*130*3).reshape(-1,3)
            offsets=np.r_[0,np.cumsum(counts)]
            for r in range(max(r0,ty*128),min(r1,(ty+1)*128)):
                for c in range(max(c0,tx*128),min(c1,(tx+1)*128)):
                    k=(r-ty*128+1)*130+c-tx*128+1
                    rs=runs[offsets[k]:offsets[k+1]]
                    if len(rs): heights[r-r0,c-c0]=max(rs[:,0].astype(int)+rs[:,1])-int(ground[k])
    return heights


def inspect(bounds, output, data_dir=WEB_DATA):
    c0, r0, c1, r1 = bounds
    h, w = r1-r0, c1-c0
    output.mkdir(parents=True, exist_ok=True)
    dtm = np.load(CACHE/'dtm.npy', mmap_mode='r')[r0:r1,c0:c1].copy()
    with np.load(CACHE/'lidar.npz') as lidar:
        # A 16 m halo keeps DSM cleanup independent of the audit crop edge.
        a, b, x, y = max(0,r0-16), min(D,r1+16), max(0,c0-16), min(W,c1+16)
        dsm = lidar['dsm'][2*a:2*b,2*x:2*y].copy()
        holes = ~np.isfinite(dsm)
        if holes.any():
            ix = ndimage.distance_transform_edt(holes, return_distances=False, return_indices=True)
            dsm = dsm[tuple(ix)]
        clean = wall_clean(dsm).reshape(b-a,2,y-x,2).max((1,3))[r0-a:r1-a,c0-x:c1-x]-dtm
        raw = dsm[2*(r0-a):2*(r1-a),2*(c0-x):2*(c1-x)].reshape(h,2,w,2)
        top, mean = raw.max((1,3))-dtm, raw.mean((1,3))-dtm
        count = lidar['n1'][r0:r1,c0:c1].copy()
        nonlast = lidar['nl1'][r0:r1,c0:c1].copy()
        low = lidar['low1'][r0:r1,c0:c1].copy()-dtm
    with rasterio.open(CACHE/'naip.tif') as src, WarpedVRT(src, crs='EPSG:32611', transform=grid_transform(),
            width=W, height=D, resampling=Resampling.average) as vrt:
        naip = vrt.read(window=Window(c0,r0,w,h)).astype(np.float32)
    rgb = np.moveaxis(naip[:3],0,-1)
    ndvi = (naip[3]-naip[0])/(naip[3]+naip[0]+1)
    passthru = nonlast/np.maximum(count,1)
    buildings = [(oid,t,g) for oid,_,t,g in OSM().areas if t.get('building') not in (None,'no','roof','construction')]
    shapes = [(g,i+1) for i,(_,_,g) in enumerate(buildings)]
    ids = rasterio.features.rasterize(shapes, out_shape=(h,w), transform=Affine.translation(c0,r0), dtype='uint32')
    published = tile_heights(bounds, data_dir)
    np.savez_compressed(output/'inputs.npz',top=top,mean=mean,clean=clean,ndvi=ndvi,passthru=passthru,
                        count=count,low=low,building=ids,dtm=dtm,rgb=rgb,published=published,bounds=bounds)
    components,n = ndimage.label((published>3)&(ids==0))
    objects=[]
    for i,sl in enumerate(ndimage.find_objects(components),1):
        if sl is None: continue
        m=components[sl]==i
        if m.sum()<4: continue
        objects.append(dict(id=i,bounds=[sl[1].start+c0,sl[0].start+r0,sl[1].stop+c0,sl[0].stop+r0],cells=int(m.sum()),
            **{k:np.percentile(v[sl][m],[10,50,90]).round(3).tolist() for k,v in
               [('top',top),('clean',clean),('ndvi',ndvi),('passthru',passthru),('count',count),('low',low)]}))
    info=dict(bounds=bounds,objects=objects,buildings=[dict(id=int(i),osmId=buildings[i-1][0],tags=buildings[i-1][1]) for i in np.unique(ids) if i])
    (output/'audit.json').write_text(json.dumps(info,indent=2),encoding='utf-8')
    edge=(ids>0)&~ndimage.binary_erosion(ids>0)
    panels=[]
    for title,values in [('NAIP RGB',rgb),('Raw height',top),('Cleaned height',clean),('Exported solid height',published),('NDVI',ndvi),('Non-last fraction',passthru)]:
        if values.ndim==3: pixels=values.clip(0,255).astype('uint8')
        else:
            v=np.clip((values+.15)/.5 if title=='NDVI' else values if title=='Non-last fraction' else values/35,0,1)
            pixels=np.stack([255*v,180*np.sqrt(v),255*(1-v)],-1).astype('uint8')
        pixels[edge]=[255,255,255]
        panel=Image.new('RGB',(w*4,h*4+32),'#18202a')
        panel.paste(Image.fromarray(pixels).resize((w*4,h*4),Image.Resampling.NEAREST),(0,32))
        draw=ImageDraw.Draw(panel); draw.text((8,8),title,fill='white')
        for obj in objects:
            c,r,_,_=obj['bounds']; draw.text(((c-c0)*4,(r-r0)*4+32),str(obj['id']),fill='white',stroke_width=1,stroke_fill='black')
        panels.append(panel)
    sheet=Image.new('RGB',(w*4*3,(h*4+32)*2))
    for i,panel in enumerate(panels): sheet.paste(panel,((i%3)*w*4,(i//3)*(h*4+32)))
    sheet.save(output/'audit.png')
    print(json.dumps(info,indent=2))


if __name__=='__main__':
    from pathlib import Path
    parser=argparse.ArgumentParser()
    parser.add_argument('--bounds',type=int,nargs=4,default=[1190,490,1300,580])
    parser.add_argument('--output',type=Path,default=CACHE/'vegetation-review'/'flower')
    parser.add_argument('--data',type=Path,default=WEB_DATA)
    args=parser.parse_args()
    inspect(args.bounds,args.output,args.data)
