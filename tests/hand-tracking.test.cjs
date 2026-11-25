const {test}=require('node:test');
const assert=require('node:assert/strict');
const {HandTracker,OneEuroFilter}=require('../hand-tracking.js');
const {hand,results}=require('./hand-fixtures.cjs');
const pair=(r1=.9,r2=.9)=>results(hand(.25,.4,r1),hand(.75,.4,r2,'Right'));
function registered() {
  const tracker=new HandTracker();
  for(let t=0;t<=600;t+=100) tracker.update(pair(),t);
  assert.equal(tracker.lock(600,tracker.tracks.find(t=>t.label==='Left').id),true);
  tracker.update(pair(),700); tracker.update(pair(),800);
  return tracker;
}

test('calibration needs two stable hands, not a single or transient second hand',()=>{
  const t=new HandTracker();
  t.update(results(hand()),0); t.update(results(hand()),600);
  assert.equal(t.lock(600),false);
  t.update(pair(),700); assert.equal(t.lock(700),false);
  t.update(pair(),1300); assert.equal(t.lock(1300),true);
});

test('stable IDs survive MediaPipe array reordering and continuous movement',()=>{
  const t=registered(),left=t.tracks.find(h=>h.label==='Left').id;
  for(let now=900;now<1800;now+=33){
    const x=.25+(now-900)*.00004;
    t.update(results(hand(.75,.4,.9,'Right'),hand(x,.4)),now);
    assert.equal(t.tracks.find(h=>h.label==='Left').id,left);
    assert.ok(t.tracks.find(h=>h.id===left).palm.x<.4);
  }
});

test('only the primary hand can pinch and release; other hands are ignored',()=>{
  const t=registered();
  assert.deepEqual(t.update(pair(.2,.2),900).events,[]);
  assert.deepEqual(t.update(pair(.2,.2),940).events,[]);
  const starts=t.update(pair(.2,.2),990).events;
  assert.equal(starts.filter(e=>e.type==='pinchstart').length,1);
  assert.equal(starts[0].id,t.primaryID);
  assert.deepEqual(t.update(pair(.4,.4),1030).events,[],'dead band cannot release');
  t.update(pair(.9,.4),1100);
  const events=t.update(pair(.9,.4),1210).events;
  assert.equal(events.filter(e=>e.type==='pinchend').length,1);
  assert.equal(t.tracks.length,1);
  assert.equal(t.tracks[0].label,'Left');
});

test('one-frame noise cannot grab or drop a card',()=>{
  const t=registered();
  t.update(pair(.2),900);
  assert.deepEqual(t.update(pair(),933).events,[]);
  assert.ok(t.tracks.every(h=>!h.pinched));
});

test('pinch threshold is normalized by palm scale (near and far hands)',()=>{
  for(const size of [.4,1,1.5]){
    const t=new HandTracker();
    const frame=ratio=>results(hand(.25,.4,ratio,'Left',size),hand(.75,.4,.9,'Right',size));
    for(let now=0;now<=600;now+=100) t.update(frame(.9),now);
    t.lock(600,t.tracks.find(h=>h.label==='Left').id); t.update(frame(.9),700); t.update(frame(.9),810);
    t.update(frame(.25),900);
    assert.equal(t.update(frame(.25),1000).events.filter(e=>e.type==='pinchstart').length,1);
  }
});

test('other hands cannot steal focus during a short primary-hand dropout',()=>{
  const t=registered(),ids=t.tracks.map(h=>h.id);
  const left=t.tracks.find(h=>h.label==='Left');
  const before=left.pointer.x;
  for(let now=900;now<=1200;now+=100){
    t.update(results(hand(.75,.4,.9,'Right'),hand(.45,.8,.2),hand(.9,.8,.2,'Right')),now);
  }
  assert.deepEqual(t.tracks.map(h=>h.id),ids);
  assert.equal(left.pointer.x,before);
  assert.equal(left.lastSeen,800);
});

test('ambiguous similar hands freeze the track instead of changing ownership',()=>{
  const t=registered(),left=t.tracks.find(h=>h.label==='Left'),before=left.lastSeen;
  t.update(results(hand(.246),hand(.254),hand(.75,.4,.9,'Right')),900);
  assert.equal(left.lastSeen,before);
  assert.equal(t.tracks.length,1);
  assert.equal(t.primaryID,left.id);
});

test('a nearby outsider cannot steal focus while the primary is visible',()=>{
  const t=registered(),left=t.tracks.find(h=>h.label==='Left');
  t.update(results(hand(.25),hand(.75,.4,.9,'Right'),hand(.32)),900);
  assert.ok(t.excluded.length>0);
  for(let now=950;now<=1750;now+=50){
    t.update(results(hand(.25),hand(.75,.4,.9,'Right'),hand(.30,.4,.2)),now);
  }
  assert.equal(left.lastSeen,1750);
  assert.equal(left.cancelled,false);
  assert.equal(t.tracks.length,1);
  assert.equal(t.primaryID,left.id);
});

test('prolonged overlapping hands do not trigger a focus handoff',()=>{
  const t=registered(),id=t.primaryID;
  for(let now=850;now<=2500;now+=50){
    const state=t.update(results(hand(.246),hand(.254),hand(.75,.4,.2,'Right')),now);
    assert.equal(state.primaryID,id);
    assert.ok(!state.events.some(e=>e.type==='focus'));
  }
  const clear=t.update(results(hand(.25)),2550);
  assert.equal(clear.tracks.length,1);
  assert.equal(clear.tracks[0].label,'Left');
  assert.ok(clear.primaryID);
});

test('confident handedness mismatch cannot steal the opposite controller',()=>{
  const t=registered();
  t.update(results(hand(.25,.4,.2,'Right')),900);
  assert.equal(t.tracks.find(h=>h.label==='Left').lastSeen,800);
});

test('brief dropout freezes a pinch, longer loss cancels without emitting release',()=>{
  const t=registered();
  t.update(pair(.2),900); t.update(pair(.2),1000);
  assert.deepEqual(t.update({},1100).events,[]);
  assert.equal(t.tracks.find(h=>h.label==='Left').pinched,true);
  const lost=t.update({},1700).events;
  assert.ok(lost.some(e=>e.type==='cancel'));
  assert.ok(!lost.some(e=>e.type==='pinchend'));
  assert.deepEqual(t.update({},1800).events,[],'cancel only once');
  assert.ok(!t.update(pair(.2),1850).events.some(e=>e.type==='pinchstart'),'closed hand cannot auto-grab on reacquisition');
});

test('a long-lost primary automatically reacquires one hand without recalibration',()=>{
  const t=registered();
  const oldID=t.primaryID;
  const lost=t.update({},5000);
  assert.equal(t.primaryID,null);
  assert.equal(t.tracks.length,0);
  assert.ok(lost.events.some(e=>e.type==='cancel' && e.id===oldID));
  const recovered=t.update(results(hand(.85,.7,.9,'Right')),5100);
  assert.equal(t.locked,true);
  assert.equal(t.tracks.length,1);
  assert.notEqual(t.primaryID,oldID);
  assert.equal(t.tracks[0].label,'Right');
  assert.equal(t.tracks[0].lastSeen,5100);
  assert.ok(recovered.events.some(e=>e.type==='focus' && e.id===t.primaryID));
});

test('the newly acquired primary keeps focus when the former hand returns',()=>{
  const t=registered();
  t.update({},1500);
  t.update(results(hand(.75,.4,.9,'Right')),1600);
  const id=t.primaryID;
  for(let now=1650;now<=2500;now+=50){
    const state=t.update(results(hand(.25,.4,.2),hand(.75,.4,.9,'Right')),now);
    assert.equal(state.primaryID,id);
    assert.equal(state.tracks.length,1);
    assert.equal(state.tracks[0].label,'Right');
    assert.ok(!state.events.some(e=>e.type==='pinchstart'));
  }
});

test('repeated losses can recover with either hand without getting suspended',()=>{
  const t=registered();
  for(let i=1;i<=8;i++){
    const now=10000*i;
    t.update({},now);
    assert.equal(t.primaryID,null);
    t.update(results(hand(i%2 ? .8:.2,.5,.9,i%2 ? 'Right':'Left')),now+50);
    assert.equal(t.tracks.length,1);
    assert.equal(t.tracks[0].lastSeen,now+50);
    assert.equal(t.locked,true);
  }
});

test('reacquisition while pinched requires opening before a new grab',()=>{
  const t=registered();
  t.update({},5000);
  for(let now=5100;now<=5600;now+=50){
    assert.ok(!t.update(results(hand(.75,.4,.2,'Right')),now).events.some(e=>e.type==='pinchstart'));
  }
  t.update(results(hand(.75,.4,.9,'Right')),5700);
  t.update(results(hand(.75,.4,.9,'Right')),5810);
  t.update(results(hand(.75,.4,.2,'Right')),5900);
  assert.equal(t.update(results(hand(.75,.4,.2,'Right')),6000).events.filter(e=>e.type==='pinchstart').length,1);
});

test('calibration pinch/disarm cannot become a gameplay grab without opening first',()=>{
  const t=registered();
  t.disarm();
  t.update(pair(.2),900);
  assert.deepEqual(t.update(pair(.2),1000).events,[]);
  t.update(pair(),1100); t.update(pair(),1210);
  t.update(pair(.2),1300);
  assert.equal(t.update(pair(.2),1400).events.filter(e=>e.type==='pinchstart').length,1);
});

test('One Euro reduces static jitter and follows deliberate movement',()=>{
  const f=new OneEuroFilter();
  const raw=[],smooth=[];
  for(let i=0;i<90;i++){
    const v=.5+(i%2 ? .003 : -.003); raw.push(v); smooth.push(f.filter(v,i*33));
  }
  const deviation=xs=>Math.sqrt(xs.reduce((s,v)=>s+(v-.5)**2,0)/xs.length);
  assert.ok(deviation(smooth.slice(20))<deviation(raw.slice(20))*.5);
  for(let i=90;i<96;i++) f.filter(.75,i*33);
  assert.ok(f.value>.71,'follows a 25% movement within 200 ms');
});

test('invalid/degenerate landmarks are ignored without throwing',()=>{
  const t=registered();
  for(const frame of [null,{}, {multiHandLandmarks:{}}, {multiHandLandmarks:[[]]},results({points:Array(21).fill({x:0,y:0}),label:'Left'}),results({points:Array(21).fill({x:NaN,y:.5}),label:'Left'})]){
    assert.doesNotThrow(()=>t.update(frame,900));
    assert.equal(t.tracks.length,1);
  }
});
