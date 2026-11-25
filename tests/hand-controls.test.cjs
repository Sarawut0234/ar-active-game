const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
const source=html.slice(html.indexOf('(() => {'),html.lastIndexOf('})();'));
const block=(start,end)=>source.slice(source.indexOf(start),source.indexOf(end));
const controls=block('function cardHolder(card)','function typeTH(t)');
const mapping=block('function cameraPoint(point)','function resetARInteraction()');

function fixture(){
  const hidden={classList:{contains:()=>true}};
  const S={w:1440,h:900,running:true,gameOver:false,level:0,cursorState:'normal',grabbed:null,arPrimaryID:'left',
    pointer:{x:100,y:200,tx:100,ty:200},
    cards:[{id:'a',level:0,flowIndex:0,x:100,y:200},{id:'b',level:0,flowIndex:1,x:300,y:200}],
    slots:[{index:0,x:800,y:200,w:128,h:76,filled:null},{index:1,x:800,y:400,w:128,h:76,filled:null}]};
  const actor=(id,x)=>({id,pointer:{x,y:200,tx:x,ty:200},grabbed:null,cursorState:'normal'});
  const a=actor('left',100),b=actor('right',300);
  const arActors=new Map([[a.id,a],[b.id,b]]);
  const sandbox=vm.createContext({S,arActors,AR_MIRROR:true,LEVELS:[{flow:[{type:'process'},{type:'process'}]}],COLORS:{process:'#60a5fa'},
    els:{cam:{videoWidth:960,videoHeight:540},intro:hidden,calibration:hidden,resultModal:hidden,clearScreen:hidden,gameOver:hidden},
    toast:()=>{},burst:()=>{},updateSlotCounter:()=>{},setTimeout:()=>0});
  vm.runInContext(controls+mapping,sandbox);
  return {S,a,b,sandbox};
}

test('only the primary controller can grab cards; other hands cannot steal focus',()=>{
  const {S,a,b,sandbox}=fixture();
  assert.equal(vm.runInContext("tryGrab(100,200,arActors.get('left'))",sandbox),true);
  assert.equal(vm.runInContext("tryGrab(100,200,arActors.get('right'))",sandbox),false);
  assert.equal(vm.runInContext("tryGrab(300,200,arActors.get('right'))",sandbox),false);
  assert.equal(a.grabbed.card,S.cards[0]); assert.equal(b.grabbed,null);
  assert.equal(vm.runInContext('tryGrab(100,200)',sandbox),false,'mouse cannot steal a held card either');
});

test('a replacement primary cannot overwrite an occupied slot',()=>{
  const {S,a,b,sandbox}=fixture();
  vm.runInContext("tryGrab(100,200,arActors.get('left'))",sandbox);
  a.pointer.x=800;
  vm.runInContext("tryRelease(arActors.get('left'))",sandbox);
  S.arPrimaryID='right';
  vm.runInContext("tryGrab(300,200,arActors.get('right'))",sandbox);
  b.pointer.x=800;
  vm.runInContext("tryRelease(arActors.get('right'))",sandbox);
  assert.equal(S.slots[0].filled,S.cards[0]);
  assert.equal(S.slots[1].filled,null);
  assert.equal(S.cards[1].locked,undefined);
  assert.equal(a.grabbed,null); assert.equal(b.grabbed,null);
});

test('tracking cancellation returns only its own card without placing it',()=>{
  const {S,a,b,sandbox}=fixture();
  vm.runInContext("tryGrab(100,200,arActors.get('left'))",sandbox);
  S.cards[0].x=800;
  vm.runInContext("cancelARGrab(arActors.get('left'))",sandbox);
  assert.equal(S.cards[0].x,100); assert.equal(S.cards[0].y,200);
  assert.equal(S.slots[0].filled,null); assert.equal(a.grabbed,null);
  S.arPrimaryID='right';
  vm.runInContext("tryGrab(300,200,arActors.get('right'));cancelARGrab(arActors.get('left'))",sandbox);
  assert.equal(b.grabbed.card,S.cards[1]);
});

test('camera mapping uses the same cover crop and mirror for pointer and skeleton',()=>{
  const {sandbox}=fixture();
  const center=vm.runInContext('cameraPoint({x:.5,y:.5})',sandbox);
  assert.equal(center.x,720); assert.equal(center.y,450);
  const mirrored=vm.runInContext('cameraPoint({x:.25,y:.25})',sandbox);
  assert.equal(mirrored.x,1120); assert.equal(mirrored.y,225);
  sandbox.AR_MIRROR=false;
  assert.equal(vm.runInContext('cameraPoint({x:.25,y:.25}).x',sandbox),320);
});

test('inference pump never overlaps sends and cancels its queued work on stop',async()=>{
  const queue=new Map(); let id=0,sends=0,complete;
  const sandbox=vm.createContext({
    arGeneration:1,els:{cam:{readyState:2}},enableMouse:()=>assert.fail('unexpected fallback'),toast:()=>{},
    requestAnimationFrame:fn=>{queue.set(++id,fn);return id;},cancelAnimationFrame:id=>queue.delete(id),
    detector:{send:()=>{sends++;return new Promise(resolve=>complete=resolve);}}
  });
  vm.runInContext(block('function startFramePump(detector','async function startAR()'),sandbox);
  vm.runInContext('pump=startFramePump(detector,1)',sandbox);
  const [key,callback]=queue.entries().next().value; queue.delete(key);
  const pending=callback(0);
  assert.equal(sends,1); assert.equal(queue.size,0,'nothing else schedules while a send is in flight');
  complete(); await pending;
  assert.equal(queue.size,1);
  vm.runInContext('pump.stop()',sandbox);
  assert.equal(queue.size,0);
});

test('stale camera-generation callbacks cannot send into a newer session',async()=>{
  let callback;
  const sandbox=vm.createContext({arGeneration:1,els:{cam:{readyState:2}},
    requestAnimationFrame:fn=>{callback=fn;return 1;},cancelAnimationFrame:()=>{},
    detector:{send:()=>assert.fail('stale inference was sent')},enableMouse:()=>{},toast:()=>{}});
  vm.runInContext(block('function startFramePump(detector','async function startAR()'),sandbox);
  vm.runInContext('startFramePump(detector,1)',sandbox);
  sandbox.arGeneration=2;
  await callback(100);
});
