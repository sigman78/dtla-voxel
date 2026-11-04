// Current adaptive viewer: streaming CPU costs and settled GPU pass ablations.
// Run Vite, then URL=http://127.0.0.1:5177/ node tools/profile-streaming.mjs
import fs from 'node:fs';
import { chromium } from 'playwright-core';
const browser = await chromium.launch({channel:'chrome',headless:true,args:['--enable-gpu','--ignore-gpu-blocklist']});
const report = {date:new Date().toISOString(),browser:browser.version(),note:'Local desktop, 1600x1000 at DPR 1; not an M1 or tablet benchmark. CPU submission time is not GPU execution time.',samples:[]};
try {
  const page = await browser.newPage({viewport:{width:1600,height:1000},deviceScaleFactor:1});
  report.errors=[];
  page.on('pageerror',e=>report.errors.push(String(e)));
  await page.route('**/src/main.ts*',async route=>{
    const response=await route.fetch();
    await route.fulfill({response,body:await response.text()+`\nwindow.__profileThree=THREE;
Object.defineProperty(window,"__getStreamer",{get:()=>streamer,configurable:true});
Object.defineProperty(window,"__getShadows",{get:()=>shadowTiles,configurable:true});
const profileShadowUpdate=ShadowTiles.prototype.update;
ShadowTiles.prototype.update=function(...args){window.__shadowRoots=args[0];return profileShadowUpdate.apply(this,args);};`});
  });
  await page.goto(`${process.env.URL || 'http://127.0.0.1:5177/'}?view=default&hour=13&continuous=1`);
  await page.waitForFunction(()=>window.__city?.complete,null,{timeout:120000});
  await page.evaluate(()=>{
    const {renderer,post}=window.__three,s=window.__getStreamer;
    const gl=renderer.getContext(),ext=gl.getExtension('EXT_disjoint_timer_query_webgl2');
    const p=window.__streamProfile={data:{},pending:[],epoch:0,recording:false};
    const record=(key,v)=>{if(p.recording)(p.data[key]??=[]).push(v);};
    for(const key of ['flush','update']) {
      const fn=s[key];s[key]=function(...args){const busy=s.queue.length+s.inflight+s.replies.length;const start=performance.now();const value=fn.apply(this,args);record(key+'CpuMs',performance.now()-start);if(key==='flush')record('pendingJobs',busy);return value;};
    }
    const originalRender=renderer.render;
    renderer.render=function(scene,...args){const start=performance.now();const value=originalRender.call(this,scene,...args);if(scene!==window.__three.scene)record('auxRenderCpuMs',performance.now()-start);return value;};
    for(const [i,pass] of post.composer.passes.entries()) {
      const fn=pass.render;
      pass.render=function(...args){
        const q=ext&&p.recording?gl.createQuery():null;
        if(q)gl.beginQuery(ext.TIME_ELAPSED_EXT,q);
        const start=performance.now(),value=fn.apply(this,args);record('pass'+i+'CpuMs',performance.now()-start);
        if(q){gl.endQuery(ext.TIME_ELAPSED_EXT);p.pending.push({q,i,epoch:p.epoch});}
        return value;
      };
    }
    const render=post.composer.render;
    renderer.info.autoReset=false;
    post.composer.render=function(...args){
      if(ext){const disjoint=gl.getParameter(ext.GPU_DISJOINT_EXT);p.pending=p.pending.filter(e=>{
        if(disjoint||gl.getQueryParameter(e.q,gl.QUERY_RESULT_AVAILABLE)){if(!disjoint&&e.epoch===p.epoch)record('pass'+e.i+'GpuMs',gl.getQueryParameter(e.q,gl.QUERY_RESULT)/1e6);gl.deleteQuery(e.q);return false;}return true;});}
      renderer.info.reset();const start=performance.now(),value=render.apply(this,args);
      record('composerCpuMs',performance.now()-start);record('drawCalls',renderer.info.render.calls);record('triangles',renderer.info.render.triangles);return value;
    };
    let last=0;const tick=now=>{if(last)record('frameIntervalMs',now-last);last=now;requestAnimationFrame(tick);};requestAnimationFrame(tick);
    p.start=()=>{p.epoch++;p.data={};p.recording=true;};
    p.stop=()=>{p.recording=false;const stats={};for(const [key,values] of Object.entries(p.data)){values.sort((a,b)=>a-b);stats[key]={n:values.length,mean:values.reduce((a,b)=>a+b,0)/values.length,p95:values[Math.floor(values.length*.95)],max:values.at(-1)};}return {stats,complete:window.__city.complete,leaves:window.__city.selection.leaves.length,memory:s.memory};};
  });
  report.environment=await page.evaluate(()=>{const {renderer,daylight}=window.__three;const gl=renderer.getContext(),ext=gl.getExtension('WEBGL_debug_renderer_info');return {gpu:ext&&gl.getParameter(ext.UNMASKED_RENDERER_WEBGL),gpuTimers:!!gl.getExtension('EXT_disjoint_timer_query_webgl2'),shadowSize:daylight.sun.shadow.mapSize.toArray(),pixelRatio:renderer.getPixelRatio()};});
  const view=JSON.parse(fs.readFileSync('public/data/meta.json','utf8')).views.civic;
  await page.evaluate(v=>{window.__streamProfile.start();window.__three.flyTo({...v,ms:1200});},view);
  await page.waitForTimeout(1500);
  await page.waitForFunction(()=>window.__city.complete,null,{timeout:120000});
  report.samples.push({variant:'stream-to-civic',...await page.evaluate(()=>window.__streamProfile.stop())});
  console.log('streaming complete');
  await page.evaluate(async()=>{
    const s=window.__getStreamer,p=window.__streamProfile;
    // Hold the same geometry for resolution/material ablations: resolution
    // otherwise changes the projected-size LOD policy and confounds the result.
    s.update=()=>{};
    p.materials=new Map([...s.nodes.values()].filter(n=>n.mesh).map(n=>[n.mesh,n.mesh.material]));
    const {QUAD_PARS}=await import('/src/quadGeometry.ts');
    p.boxCull=(await import('/src/tileMesh.ts')).TileMesh.prototype.intersectsFrustum;
    p.flat=new window.__profileThree.MeshBasicMaterial({color:0xaaaaaa});
    p.flat.onBeforeCompile=shader=>{shader.vertexShader=shader.vertexShader.replace('#include <common>','#include <common>\n'+QUAD_PARS).replace('#include <begin_vertex>','vec3 transformed = quadPosition();');};
  });
  for(const variant of (process.env.VARIANTS || 'settled,force-shadows,shadow-4096,no-ao,half-resolution,flat-tile-material,settled-repeat').split(',')) {
    await page.evaluate(variant=>{
      const {renderer,post,daylight}=window.__three;
      const p=window.__streamProfile;
      const shadowVariant=/^shadow-([1248])-(box|sphere)$/.exec(variant);
      if(shadowVariant){
        const shadows=window.__getShadows,S=window.__getStreamer;
        shadows.minimumLevel=+shadowVariant[1];shadows.refined.clear();
        shadows.update(window.__shadowRoots,window.__three.camera);
        for(const n of S.nodes.values())if(n.foliage&&n.mesh)n.mesh.castShadow=n.mesh.visible&&S.shadowKeys.has(S.key(1,n.tx,n.ty));
        window.__three.scene.traverse(mesh=>{if(mesh.isMesh&&(mesh.geometry.attributes.qOrigin||mesh.geometry.attributes.vattr))
          mesh.intersectsFrustum=shadowVariant[2]==='box'?p.boxCull:window.__profileThree.Mesh.prototype.intersectsFrustum;});
      }
      for(const [mesh,material] of p.materials)mesh.material=variant==='flat-tile-material'?p.flat:material;
      post.n8.enabled=variant!=='no-ao';
      renderer.setPixelRatio(variant==='half-resolution'?.5:1);post.composer.setSize(innerWidth,innerHeight);
      const size=variant==='shadow-4096'?4096:8192;
      if(daylight.sun.shadow.mapSize.x!==size){daylight.sun.shadow.mapSize.set(size,size);daylight.sun.shadow.map?.dispose();daylight.sun.shadow.map=null;}
      renderer.shadowMap.autoUpdate=!!shadowVariant||variant==='force-shadows'||variant==='shadow-4096';
      daylight.invalidateShadow();
    },variant);
    await page.waitForTimeout(1000);
    await page.evaluate(()=>window.__streamProfile.start());
    await page.waitForTimeout(3500);
    report.samples.push({variant,...await page.evaluate(()=>window.__streamProfile.stop())});
    console.log(variant);
  }
} finally {
  fs.mkdirSync('../artifacts/profiling',{recursive:true});
  fs.writeFileSync(process.argv[2] || '../artifacts/profiling/streaming-current.json',JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report.environment));
  for(const s of report.samples)console.log(s.variant,JSON.stringify(Object.fromEntries(Object.entries(s.stats).map(([k,v])=>[k,{mean:+v.mean.toFixed(2),p95:+v.p95.toFixed(2)}]))));
  await browser.close();
}
