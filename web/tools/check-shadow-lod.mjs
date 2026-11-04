import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chromium } from 'playwright-core';
const browser=await chromium.launch({channel:'chrome',headless:true,args:['--enable-gpu','--ignore-gpu-blocklist']});
const report={errors:[],samples:[]};
try {
  const page=await browser.newPage({viewport:{width:1200,height:800}});
  page.on('pageerror',e=>report.errors.push(String(e)));
  await page.route('**/src/main.ts*',async route=>{
    const response=await route.fetch();
    await route.fulfill({response,body:await response.text()+'\nwindow.__shadowLodTest={three:THREE,get streamer(){return streamer;},get shadows(){return shadowTiles;}};'});
  });
  await page.goto(`${process.env.URL || 'http://127.0.0.1:5177/'}?view=civic&hour=13`);
  await page.waitForFunction(()=>window.__city?.complete,null,{timeout:120000});
  const snapshot=()=>page.evaluate(()=>{
    const {streamer:S,shadows}=window.__shadowLodTest;
    const {nx,ny}=S.dims[1],coverage=new Uint8Array(nx*ny);
    let shared=true,packedDepth=true;
    for(const key of S.shadowKeys){const n=S.nodes.get(key);if(!n||n.state!=='ready')throw new Error('Missing caster '+key);
      for(let y=n.ty*n.s;y<Math.min(ny,(n.ty+1)*n.s);y++)for(let x=n.tx*n.s;x<Math.min(nx,(n.tx+1)*n.s);x++)coverage[y*nx+x]++;
    }
    for(const proxy of shadows.group.children){const n=S.nodes.get(proxy.name.slice(7));shared&&=proxy.geometry===n.mesh.geometry;packedDepth&&=proxy.customDepthMaterial===n.mesh.customDepthMaterial;}
    return {keys:[...S.shadowKeys],holes:[...coverage].filter(v=>v===0).length,overlaps:[...coverage].filter(v=>v>1).length,
      shared,packedDepth,hidden:!shadows.group.visible,visibleBaseCasts:[...S.nodes.values()].filter(n=>!n.foliage&&n.mesh?.castShadow).length,
      visible:window.__city.selection.active.length,memory:S.memory.total};
  });
  const check=async name=>{const s=await snapshot();report.samples.push({name,...s});assert.equal(s.holes,0);assert.equal(s.overlaps,0);assert(s.shared&&s.packedDepth&&s.hidden);assert.equal(s.visibleBaseCasts,0);};
  await check('civic');
  await page.waitForTimeout(800);
  await page.screenshot({path:'../artifacts/profiling/shadow-lod-civic.png'});
  // Compare exact and coarse shadows with precisely the same color geometry.
  report.comparison=await page.evaluate(()=>{
    const {streamer:S,shadows}=window.__shadowLodTest,{renderer,post,camera,daylight}=window.__three;
    renderer.setAnimationLoop(null);
    const leaf=n=>({key:n.key,s:n.s,tx:n.tx,ty:n.ty,children:[],score:0});
    const coarse=[...S.shadowKeys].map(k=>leaf(S.nodes.get(k)));
    const exact=[...S.nodes.values()].filter(n=>!n.foliage&&n.mesh?.visible).map(leaf);
    const gl=renderer.getContext();renderer.info.autoReset=false;
    const render=roots=>{shadows.update(roots,camera);
      for(const n of S.nodes.values())if(n.foliage&&n.mesh)n.mesh.castShadow=n.mesh.visible&&S.shadowKeys.has(S.key(1,n.tx,n.ty));
      daylight.invalidateShadow();renderer.info.reset();post.composer.render();
      const result={calls:renderer.info.render.calls,triangles:renderer.info.render.triangles};
      const pixels=new Uint8Array(gl.drawingBufferWidth*gl.drawingBufferHeight*4);gl.readPixels(0,0,gl.drawingBufferWidth,gl.drawingBufferHeight,gl.RGBA,gl.UNSIGNED_BYTE,pixels);return {result,pixels};};
    const a=render(coarse);
    const {three:T}=window.__shadowLodTest,methods=new Map();
    window.__three.scene.traverse(mesh=>{if(mesh.isMesh&&(mesh.geometry.attributes.qOrigin||mesh.geometry.attributes.vattr)){
      methods.set(mesh,mesh.intersectsFrustum);mesh.intersectsFrustum=T.Mesh.prototype.intersectsFrustum;
    }});
    const sphere=render(coarse);
    for(const [mesh,method] of methods)mesh.intersectsFrustum=method;
    let cullingTotal=0,cullingOver8=0;
    for(let i=0;i<a.pixels.length;i++){const d=Math.abs(a.pixels[i]-sphere.pixels[i]);cullingTotal+=d;if(d>8)cullingOver8++;}
    const viewFrustum=new T.Frustum().setFromProjectionMatrix(new T.Matrix4().multiplyMatrices(camera.projectionMatrix,camera.matrixWorldInverse));
    let offscreenDraws=0;
    for(const mesh of shadows.group.children)mesh.onBeforeShadow=()=>{if(!mesh.intersectsFrustum(viewFrustum))offscreenDraws++;};
    render(coarse);
    for(const mesh of shadows.group.children)mesh.onBeforeShadow=()=>{};
    const b=render(exact);
    let total=0,over16=0;for(let i=0;i<a.pixels.length;i++){const d=Math.abs(a.pixels[i]-b.pixels[i]);total+=d;if(d>16)over16++;}
    return {coarse:a.result,exact:b.result,sphere:sphere.result,offscreenShadowDraws:offscreenDraws,
      cullingMeanDifference:cullingTotal/a.pixels.length,cullingFractionOver8:cullingOver8/a.pixels.length,
      meanChannelDifference:total/a.pixels.length,fractionOver16:over16/a.pixels.length,glError:gl.getError()};
  });
  await page.screenshot({path:'../artifacts/profiling/shadow-lod-civic-exact.png'});
  assert(report.comparison.coarse.triangles<report.comparison.exact.triangles);
  assert(report.comparison.coarse.calls<report.comparison.exact.calls);
  assert.equal(report.comparison.glError,0);
  assert(report.comparison.cullingMeanDifference<.2&&report.comparison.cullingFractionOver8<.001,'tight culling must preserve the image');
  assert(report.comparison.offscreenShadowDraws>0,'casters outside the viewing camera must still render');
  // Reload to restore the animation loop and exercise navigation and sunlight.
  await page.reload();await page.waitForFunction(()=>window.__city?.complete,null,{timeout:120000});
  const views=JSON.parse(fs.readFileSync('public/data/meta.json','utf8')).views;
  for(const [name,v] of [['bunkerhill',views.bunkerhill],['civic',views.civic]]){
    await page.evaluate(v=>window.__three.flyTo({...v,ms:500}),v);await page.waitForTimeout(800);
    await page.waitForFunction(()=>window.__city?.complete,null,{timeout:120000});await check(name);
  }
  await page.evaluate(()=>window.__three.setHour(17));await page.waitForTimeout(1200);
  await page.waitForFunction(()=>window.__city?.complete,null,{timeout:120000});await check('low sun');
  await page.screenshot({path:'../artifacts/profiling/shadow-lod-low-sun.png'});
  const canRestore=await page.evaluate(()=>{
    const {renderer}=window.__three,ext=renderer.getContext().getExtension('WEBGL_lose_context');
    if(!ext)return false;
    window.__restoredShadowDraws=0;
    for(const proxy of window.__shadowLodTest.shadows.group.children)proxy.onBeforeShadow=()=>window.__restoredShadowDraws++;
    ext.loseContext();setTimeout(()=>ext.restoreContext(),500);return true;
  });
  if(canRestore){await page.waitForFunction(()=>window.__restoredShadowDraws>0,null,{timeout:30000});await check('context restored');}
  assert.deepEqual(report.errors,[]);
  console.log(JSON.stringify(report.comparison));
  console.log('Passed: shadow coverage without overlap, shared buffers/depth materials, pass isolation, lower draw counts, navigation and sun changes');
} finally {
  fs.writeFileSync('../artifacts/profiling/shadow-lod-check.json',JSON.stringify(report,null,2)+'\n');
  await browser.close();
}
