// Paired full-composer GPU timings: original sky shader vs distant mountains.
// Start Vite, then: node tools/profile-horizon.mjs [output.json]
// URL, BASE_REV, ROUNDS, SAMPLE_MS override defaults. Measurements stay in artifacts.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright-core';

const out = process.argv[2] || '../artifacts/horizon-performance.json';
fs.mkdirSync(path.dirname(path.resolve(out)), {recursive:true});
const base = process.env.BASE_REV || '4a8f3b8';
const source = execFileSync('git', ['show', `${base}:web/src/sky.ts`], {encoding:'utf8'});
const fragment = source.match(/const FRAG = `([\s\S]*?)`;/)?.[1];
if (!fragment) throw new Error('Baseline sky shader missing');
const browser = await chromium.launch({channel:'chrome', headless:true,
  args:['--enable-gpu','--ignore-gpu-blocklist','--disable-frame-rate-limit','--disable-gpu-vsync']});
const report = {baseline:base, date:new Date().toISOString(), browser:browser.version(), viewport:{width:1600,height:1000}, runs:[]};
const save = () => fs.writeFileSync(out, JSON.stringify(report,null,2));
try {
  for (const [view,query] of [
    ['north-day','cam=900,350,2500,2400,180,1400&hour=12'],
    ['north-sunset','cam=900,350,2500,2400,180,1400&hour=16.5'],
    ['bunker-night','view=bunkerhill&hour=19.5'],
  ]) {
    const page = await browser.newPage({viewport:report.viewport});
    const errors=[];page.on('pageerror',e=>errors.push(e.message));
    page.on('console',m=>{if(m.type()==='error') errors.push(m.text());});
    await page.goto(`${process.env.URL || 'http://127.0.0.1:5175/'}?${query}&date=11-03&continuous=1&ui=0`);
    await page.waitForFunction(()=>window.__ready && window.__city?.complete, null, {timeout:300000});
    await page.waitForTimeout(2500);
    const environment=await page.evaluate(fragment=>{
      const {renderer,post,daylight}=window.__three;
      const gl=renderer.getContext(), ext=gl.getExtension('EXT_disjoint_timer_query_webgl2');
      if(!ext) throw new Error('GPU timer unavailable; cannot make a GPU performance claim');
      const debug=gl.getExtension('WEBGL_debug_renderer_info');
      const original=daylight.sky.mesh.material;
      const baseline=original.clone();baseline.fragmentShader=fragment;baseline.uniforms=original.uniforms;
      const p=window.__horizonProfile={active:false,epoch:0,data:{},pending:[],last:0};
      const record=(key,v)=>{if(p.active)(p.data[key]??=[]).push(v);};
      const render=post.composer.render;
      renderer.info.autoReset=false;
      post.composer.render=function(...args){
        const now=performance.now();
        if(p.last)record('frameMs',now-p.last);p.last=now;
        const disjoint=gl.getParameter(ext.GPU_DISJOINT_EXT);
        p.pending=p.pending.filter(({q,epoch})=>{
          if(disjoint||gl.getQueryParameter(q,gl.QUERY_RESULT_AVAILABLE)){
            if(!disjoint&&epoch===p.epoch)record('gpuMs',gl.getQueryParameter(q,gl.QUERY_RESULT)/1e6);
            gl.deleteQuery(q);return false;
          }return true;
        });
        const q=p.active?gl.createQuery():null;
        if(q)gl.beginQuery(ext.TIME_ELAPSED_EXT,q);
        renderer.info.reset();const start=performance.now();const result=render.apply(this,args);
        record('cpuMs',performance.now()-start);record('calls',renderer.info.render.calls);record('triangles',renderer.info.render.triangles);
        if(q){gl.endQuery(ext.TIME_ELAPSED_EXT);p.pending.push({q,epoch:p.epoch});}
        return result;
      };
      p.select=enabled=>{p.active=false;daylight.sky.mesh.material=enabled?original:baseline;};
      p.begin=()=>{p.data={};p.last=0;p.epoch++;p.active=true;};
      p.end=()=>{p.active=false;return Object.fromEntries(Object.entries(p.data).map(([key,values])=>{
        const a=values.sort((a,b)=>a-b);return [key,{n:a.length,mean:a.reduce((s,v)=>s+v,0)/a.length,p50:a[Math.floor(a.length*.5)],p95:a[Math.floor(a.length*.95)]}];
      }));};
      return {gpu:debug?gl.getParameter(debug.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER),pixelRatio:renderer.getPixelRatio(),textureBytes:daylight.sky.u.uRidge.value.image.data.byteLength};
    },fragment);
    const run={view,environment,errors,measurements:[]};report.runs.push(run);save();
    console.log(view,JSON.stringify(environment));
    for(let round=0;round<+(process.env.ROUNDS||4);round++){
      for(const enabled of round%2?[true,false]:[false,true]){
        await page.evaluate(enabled=>window.__horizonProfile.select(enabled),enabled);
        await page.waitForTimeout(700);
        await page.evaluate(()=>window.__horizonProfile.begin());
        await page.waitForTimeout(+(process.env.SAMPLE_MS||2000));
        const stats=await page.evaluate(()=>window.__horizonProfile.end());
        run.measurements.push({round,enabled,stats});save();
        console.log(view,round,enabled?'mountains':'baseline','GPU',stats.gpuMs?.mean.toFixed(3),'frame',stats.frameMs?.mean.toFixed(3));
      }
    }
    await page.close();
  }
} finally {save();await browser.close();}
if(report.runs.some(r=>r.errors.length || r.measurements.some(m=>!m.stats.gpuMs?.n))) process.exitCode=1;
