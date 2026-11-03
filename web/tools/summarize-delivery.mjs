// Local-only comparison report; no benchmark captures should be committed.
// node tools/summarize-delivery.mjs ../artifacts/profiling/delivery-results.json
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const input=path.resolve(process.argv[2]||'../artifacts/profiling/delivery-results.json');
const report=JSON.parse(fs.readFileSync(input,'utf8'));
const median=values=>{const a=values.filter(Number.isFinite).sort((a,b)=>a-b);return a.length?(a[Math.floor((a.length-1)/2)]+a[Math.ceil((a.length-1)/2)])/2:null};
const hash=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const rows=[];
for(const profile of [...new Set(report.results.map(r=>r.profile))])for(const phase of [...new Set(report.results.map(r=>r.phase))]){
  const baseline=report.results.filter(r=>r.profile===profile&&r.phase===phase&&r.variant==='current');
  const reference=new Set(baseline.map(r=>hash(r.active)));
  for(const variant of ['current','immutable','batch','both']){
    const samples=report.results.filter(r=>r.profile===profile&&r.phase===phase&&r.variant===variant);if(!samples.length)continue;
    const metric=key=>median(samples.map(r=>r[key]));
    rows.push({profile,phase,variant,n:samples.length,seconds:metric('completeMs')/1000,
      minSeconds:Math.min(...samples.map(r=>r.completeMs))/1000,maxSeconds:Math.max(...samples.map(r=>r.completeMs))/1000,
      readySeconds:metric('readyMs')/1000,coverageSeconds:metric('coverageMs')/1000,detail90Seconds:metric('detail90Ms')/1000,
      tileRequests:metric('tileRequests'),revalidations:metric('tile304'),tileMiB:metric('tileBytes')/1048576,
      frameP95:metric('frameP95'),longFrames:metric('longFrames'),peakPayloadMiB:metric('peakPayload')/1048576,
      packCacheMiB:median(samples.map(r=>r.transport?.peakCacheBytes||0))/1048576,
      matchesBaselineTiles:samples.every(r=>reference.has(hash(r.active))),
      activeTiles:median(samples.map(r=>r.active.length))});
  }
}
console.table(rows.map(r=>({profile:r.profile,phase:r.phase,variant:r.variant,n:r.n,seconds:+r.seconds.toFixed(2),tileRequests:r.tileRequests,MiB:+r.tileMiB.toFixed(2),sameTiles:r.matchesBaselineTiles})));
const output=input.replace(/\.json$/,'.html');
const data=JSON.stringify({method:report.method,revision:report.revision,profiles:report.profiles,rows}).replace(/</g,'\\u003c');
fs.writeFileSync(output,`<!doctype html><meta charset="utf-8"><title>DTLA delivery experiment</title>
<style>body{font:15px system-ui;margin:36px;max-width:1250px;background:#111923;color:#e4edf6}h1{font-size:26px}p{max-width:95ch;color:#b9c8d8;line-height:1.5}select{font:inherit;margin:0 18px 20px 8px;padding:7px}table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}th,td{text-align:right;padding:12px 8px;border-bottom:1px solid #34404f}th:first-child,td:first-child{text-align:left}small{display:block;color:#94a9be;margin-top:5px}.bar{background:#70c7ad;height:6px;margin-top:8px;border-radius:3px}code{color:#c4d6f0}.warning{color:#ffc87b}</style>
<h1>DTLA: caching and tile batching</h1><p id="method"></p>
<label>Network<select id="profile"></select></label><label>Scenario<select id="phase"><option value="cold">Cold Civic view</option><option value="away">Navigate to Viaduct</option><option value="return">Return to Civic</option><option value="warm">New page, warm browser cache</option></select></label>
<p id="conditions"></p><table><thead><tr><th>Delivery</th><th>Ready / base coverage</th><th>90% detail</th><th>Complete</th><th>Tile requests</th><th>Tile body</th><th>Frame p95</th><th>Peak payload + pack cache</th></tr></thead><tbody id="rows"></tbody></table>
<p>Values are medians; completion ranges appear below each median. With two repeats, treat small differences as noise. “Ready” means terrain/UI initialized; base coverage means active voxel tiles cover the map. Detail includes foliage. Navigation uses instant viewpoint changes with settled pauses, not rapid camera movement. These milestones are proxies for experience, not a perceptual quality score. Shader compilation, CPU meshing and GPU upload still contribute to completion.</p>
<p>Local HTTP/2 server simulates request latency and shared body bandwidth; it does not reproduce Cloudflare cache misses, HTTP/3, packet loss or a mobile CPU. Third-party fonts are disabled and app assets lack transport compression equally across variants. The server counts actual network requests, including 304 responses; body bytes exclude headers. Immutable cases use versioned URLs. Packs group 4×4 fine tiles or 2×2 coarse tiles, keep gzip streams separate, and use a bounded 4 MiB shared LRU. The batch prototype finishes shared requests after individual cancellation. No production changes have been deployed.</p>
<p id="quality"></p><small id="revision"></small>
<script>const data=${data};const labels={current:'Current',immutable:'Immutable cache',batch:'Spatial batches',both:'Batches + immutable'};
const profile=document.querySelector('#profile'),phase=document.querySelector('#phase');
profile.innerHTML=Object.keys(data.profiles).map(p=>'<option>'+p+'</option>').join('');
if(data.profiles.latency)profile.value='latency';
document.querySelector('#method').textContent=data.method;document.querySelector('#revision').textContent='Source revision: '+data.revision;
function render(){const available=data.rows.filter(r=>r.profile===profile.value).map(r=>r.phase);for(const option of phase.options)option.disabled=!available.includes(option.value);if(!available.includes(phase.value))phase.value=available[0];
const rows=data.rows.filter(r=>r.profile===profile.value&&r.phase===phase.value),max=Math.max(...rows.map(r=>r.seconds)),p=data.profiles[profile.value];
document.querySelector('#conditions').textContent=p.latency+' ms per network response; '+(p.bytesPerSecond/1048576).toFixed(1)+' MiB/s shared bandwidth.';
document.querySelector('#rows').innerHTML=rows.map(r=>'<tr><td>'+labels[r.variant]+'<small>n='+r.n+'</small></td><td>'+r.readySeconds.toFixed(2)+' / '+r.coverageSeconds.toFixed(2)+' s</td><td>'+r.detail90Seconds.toFixed(2)+' s</td><td>'+r.seconds.toFixed(2)+' s<small>'+r.minSeconds.toFixed(2)+'–'+r.maxSeconds.toFixed(2)+' s</small><div class="bar" style="width:'+100*r.seconds/max+'%"></div></td><td>'+r.tileRequests+'<small>'+r.revalidations+' revalidations</small></td><td>'+r.tileMiB.toFixed(2)+' MiB</td><td>'+r.frameP95.toFixed(1)+' ms</td><td>'+r.peakPayloadMiB.toFixed(1)+' + '+r.packCacheMiB.toFixed(1)+' MiB</td></tr>').join('');
const exact=rows.every(r=>r.matchesBaselineTiles);document.querySelector('#quality').textContent=exact?'All measured variants finished with the same active tiles as the baseline.':'Caution: final active tile sets differ; completion times may include different detail levels.';document.querySelector('#quality').className=exact?'':'warning';}
profile.onchange=phase.onchange=render;render();</script>`);
console.log('Report: '+output);
