// No dependencies: node --test tests/layout.test.cjs
const { readFileSync } = require('node:fs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const path = require('node:path');

const html = readFileSync(path.join(__dirname, '../index.html'), 'utf8');
const inlineScripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)]
  .map(match => match[1]).filter(script => script.trim());
const source = inlineScripts.find(script => script.includes('function layoutLevel()'));
const levels = source.slice(source.indexOf('const LEVELS = ['), source.indexOf('const els = {'));
const layout = source.slice(source.indexOf('function layoutLevel()'), source.indexOf('function retryWithoutReset()'));

test('all inline JavaScript parses', () => {
  inlineScripts.forEach(script => assert.doesNotThrow(() => new vm.Script(script)));
});

function fixture(width, level) {
  const S = { w:width, h:900, level, slots:[], cards:[] };
  const sandbox = vm.createContext({
    S, SLOT_W:128, SLOT_H:76, COL:{indigoSoft:'#818cf8'},
    document:{body:{classList:{contains:() => true}}},
    els:{stage:{getBoundingClientRect:() => ({top:0})}, promptBar:{getBoundingClientRect:() => ({bottom:200})}}
  });
  vm.runInContext(levels + layout, sandbox);
  const flow = vm.runInContext('LEVELS[S.level].flow', sandbox);
  S.slots = flow.map((_,i) => ({index:i,filled:null}));
  S.cards = flow.map((_,i) => ({trayIndex:i,flowIndex:i}));
  vm.runInContext('layoutLevel()',sandbox);
  return {S,sandbox};
}

for (const width of [320,390,506,768,1000,1024,1440,1920]) {
  test(`all seven levels: straight connectors and separated slots at ${width}px`, () => {
    for (let level=0; level<7; level++) {
      const {S} = fixture(width,level);
      const {board} = S.layout;
      assert.equal(S.slots.length,7);
      assert.ok(S.slots.every(slot => slot.x === S.slots[0].x), 'all steps share one column');
      assert.ok(S.slots[6].y > S.slots[5].y, 'messages flow from start to end');
      for (const slot of S.slots) {
        assert.ok(slot.x-slot.w/2>=board.x && slot.x+slot.w/2<=board.x+board.w);
        assert.ok(slot.y-slot.h/2>=board.y-0.001);
        assert.ok(slot.y+slot.h/2<=board.y+board.h+0.001);
        for (const other of S.slots.filter(s => s.index>slot.index)) {
          assert.ok(Math.abs(slot.x-other.x)>=(slot.w+other.w)/2 || Math.abs(slot.y-other.y)>=(slot.h+other.h)/2, 'slots do not overlap');
        }
      }
      for (const route of S.routes) {
        for (let i=1;i<route.points.length;i++) {
          const [x1,y1]=route.points[i-1], [x2,y2]=route.points[i];
          assert.ok(x1===x2 || y1===y2, 'no diagonal segment');
          assert.ok(x1>=board.x && x1<=board.x+board.w && y1>=board.y && y1<=board.y+board.h);
          for (const slot of S.slots) {
            const left=slot.x-slot.w/2, right=slot.x+slot.w/2, top=slot.y-slot.h/2, bottom=slot.y+slot.h/2;
            const crosses = x1===x2
              ? x1>left && x1<right && Math.max(y1,y2)>top && Math.min(y1,y2)<bottom
              : y1>top && y1<bottom && Math.max(x1,x2)>left && Math.min(x1,x2)<right;
            assert.ok(!crosses, `connector passes through slot ${slot.index+1}`);
          }
        }
      }
      assert.deepEqual(Array.from(S.routes.filter(r=>r.from===3),r=>r.to),[4,5]);
      assert.ok(!S.routes.some(r=>r.from===3 && r.to===6), 'the condition does not jump straight to the end');
    }
  });
}

test('answer layout preserves filled cards and leaves floating cards unchanged', () => {
  const {S,sandbox}=fixture(1440,0);
  S.score=140; S.wrongs=1;
  const card=S.cards[2];
  S.cards[0].x=140; S.cards[0].y=120;
  card.slotIndex=2; card.locked=true; S.slots[2].filled=card;
  S.w=390;
  vm.runInContext('layoutLevel()',sandbox);
  assert.equal(S.slots[2].filled,card);
  assert.equal(card.x,S.slots[2].x); assert.equal(card.y,S.slots[2].y);
  assert.equal(S.score,140); assert.equal(S.wrongs,1);
  assert.equal(S.cards[0].x,140); assert.equal(S.cards[0].y,120);
});

test('answer slots do not reveal the expected block type or highlight matching answers', () => {
  const drawing=source.slice(source.indexOf('function drawSlot(s)'),source.indexOf('function drawEdges()'));
  assert.ok(!drawing.includes('COLORS['));
  assert.ok(!drawing.includes('flow['));
  assert.ok(!drawing.includes('S.grabbed'));
  assert.ok(!source.includes('ขอคำใบ้'));
  assert.ok(!source.includes('คำใบ้:'));
  assert.ok(!source.includes('drawPanels'));
});
