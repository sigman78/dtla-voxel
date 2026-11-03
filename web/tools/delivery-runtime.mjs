// Benchmark-only source injections. Production modules are never modified.
export const broker = `
const deliveryCache = new Map(), deliveryPending = new Map();
const deliveryDemand = new Set();
let deliveryBytes = 0, deliveryPeak = 0, deliveryUseful = 0;
globalThis.__deliveryTransport = () => ({cacheBytes:deliveryBytes, peakCacheBytes:deliveryPeak,
  usefulBytes:deliveryUseful, uniqueTiles:deliveryDemand.size});
async function deliveryServe(worker, request) {
  try {
    const url = new URL(request.url), match = /tiles\\/([^/]+)\\/(\\d+)_(\\d+)\\.bin$/.exec(url.pathname);
    if (!match) throw new Error('Not a tile URL: '+url);
    const [,level,xs,ys] = match, x=+xs,y=+ys,g=(level==='1'||level==='1f')?4:2;
    const pack = url.href.replace(/tiles\\/.*$/, 'packs/'+level+'/'+Math.floor(x/g)+'_'+Math.floor(y/g)+'.bin');
    let bytes = deliveryCache.get(pack);
    if (bytes) {deliveryCache.delete(pack);deliveryCache.set(pack,bytes);}
    else {
      let pending=deliveryPending.get(pack);
      if (!pending) {
        pending=fetch(pack).then(async response=>{
          if (!response.ok) throw new Error('Pack HTTP '+response.status);
          const data=await response.arrayBuffer();
          while (deliveryBytes+data.byteLength>4*1024*1024 && deliveryCache.size) {
            const key=deliveryCache.keys().next().value;
            deliveryBytes-=deliveryCache.get(key).byteLength;deliveryCache.delete(key);
          }
          if(data.byteLength<=4*1024*1024){deliveryCache.set(pack,data);deliveryBytes+=data.byteLength;deliveryPeak=Math.max(deliveryPeak,deliveryBytes);}
          return data;
        }).finally(()=>deliveryPending.delete(pack));
        deliveryPending.set(pack,pending);
      }
      bytes=await pending;
    }
    const index=(y%g)*g+(x%g), header=new DataView(bytes);
    let offset=4+g*g*4;
    for(let i=0;i<index;i++)offset+=header.getUint32(4+i*4,true);
    const length=header.getUint32(4+index*4,true);
    if(!length)throw new Error('Missing tile in pack');
    if(!deliveryDemand.has(url.href)){deliveryDemand.add(url.href);deliveryUseful+=length;}
    const tile=bytes.slice(offset,offset+length);
    worker.postMessage({type:'delivery-bytes',requestId:request.requestId,bytes:tile},[tile]);
  } catch(error) {worker.postMessage({type:'delivery-bytes',requestId:request.requestId,error:String(error)});}
}
`;

export const worker = `
const deliveryWaiters = new Map();let deliveryId=0;
self.addEventListener('message',event=>{
  if(event.data.type!=='delivery-bytes')return;
  const waiter=deliveryWaiters.get(event.data.requestId);
  if(waiter){deliveryWaiters.delete(event.data.requestId);waiter.done(event.data);}
});
function deliveryRead(url,signal){
  return new Promise((resolve,reject)=>{
    const requestId=++deliveryId;
    const abort=()=>{deliveryWaiters.delete(requestId);reject(new DOMException('Aborted','AbortError'));};
    if(signal.aborted){abort();return;}
    signal.addEventListener('abort',abort,{once:true});
    deliveryWaiters.set(requestId,{done(result){signal.removeEventListener('abort',abort);result.error?reject(new Error(result.error)):resolve(result.bytes);}});
    self.postMessage({type:'delivery-fetch',requestId,url});
  });
}
`;

export const instrumentation = `
let deliveryStart=0, deliveryReady=null, deliveryCoverage=null, delivery90=null, deliveryFrames=[],deliveryLast=0,deliveryPeakPayload=0;
globalThis.__deliveryTest={
  reset(){deliveryStart=performance.now();deliveryReady=deliveryCoverage=delivery90=null;deliveryFrames=[];deliveryLast=0;deliveryPeakPayload=0;},
  view(name){const v=views[name];camera.position.fromArray(v.pos);controls.target.fromArray(v.target);controls.update();},
  snapshot(){return {startOffsetMs:deliveryStart,readyMs:deliveryReady,coverageMs:deliveryCoverage,detail90Ms:delivery90,
    elapsedMs:performance.now()-deliveryStart,complete:!!city?.complete,peakPayload:deliveryPeakPayload,
    memory:streamer?.memory,stats:streamer?.stats,active:city?.selection.active.sort(),
    transport:globalThis.__deliveryTransport?.(),frames:deliveryFrames,gl:renderer.getContext().getError()};}
};
globalThis.__deliveryTest.reset();
setInterval(()=>{
  const elapsed=performance.now()-deliveryStart;
  if(window.__ready && deliveryReady===null)deliveryReady=elapsed;
  if(!city||!streamer)return;
  deliveryPeakPayload=Math.max(deliveryPeakPayload,streamer.memory.total);
  let area=0,ready=0;const selection=city.selection;
  for(const key of selection.active){const n=streamer.nodes.get(key);if(!n||n.foliage)continue;
    const l=n.s*streamer.N;area+=Math.max(0,Math.min(l,map.max.x-n.tx*l))*Math.max(0,Math.min(l,map.max.z-n.ty*l));}
  if(area>=map.max.x*map.max.z && deliveryCoverage===null)deliveryCoverage=elapsed;
  for(const key of selection.leaves){const n=streamer.nodes.get(key);
    if(n?.state==='ready'&&(n.s!==1||streamer.nodes.get(streamer.foliageKey(n.tx,n.ty))?.state==='ready'))ready++;}
  if(ready>=selection.leaves.length*.9&&delivery90===null)delivery90=elapsed;
},100);
function deliveryTick(now){if(deliveryLast)deliveryFrames.push(now-deliveryLast);deliveryLast=now;requestAnimationFrame(deliveryTick)}
requestAnimationFrame(deliveryTick);
`;
