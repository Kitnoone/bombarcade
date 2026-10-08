import test from 'node:test';
import assert from 'node:assert/strict';
import { Adventure, DIGITS, FIELD, TRANSITION_MS, hexDistance } from '../public/adventure.js';
function fixture() {
  let clock = 100;
  const game = new Adventure({now:()=>clock});
  return {game,advance(ms){clock+=ms;game.tick();}};
}
const press = (game,symbol,kind='key',overrides={}) => game.press({kind,symbol,round:game.round,layoutVersion:game.layoutVersion,...overrides});
function unlock(f) {
  f.game.start();f.advance(10000);
  for(const s of f.game.sequence) assert(press(f.game,s));
}
function reach(game,node) {
  while(game.position.col!==node.col) assert(press(game,game.position.col<node.col?'→':'←','move'));
  while(game.position.row!==node.row) assert(press(game,game.position.row<node.row?'↓':'↑','move'));
}
test('first success fades for 1.8 seconds then starts search in the same adventure',()=>{
  const f=fixture();unlock(f);assert.equal(f.game.stage,'transition');
  assert.equal(press(f.game,'↑','move'),false);
  f.advance(TRANSITION_MS-1);assert.equal(f.game.protocol,1);
  f.advance(1);assert.equal(f.game.protocol,2);assert.equal(f.game.stage,'explore');
  assert.equal(f.game.nodes.length,6);assert.equal(f.game.nodes.filter(n=>n.target).length,1);
  assert(hexDistance(f.game.position,f.game.nodes.find(n=>n.target))>=6);
});
test('pause freezes the transition and blocks untimed exploration',()=>{
  const f=fixture();unlock(f);f.advance(700);f.game.pause('connection');
  f.advance(60000);assert.equal(f.game.stage,'transition');assert.equal(f.game.remaining(),1100);
  f.game.resume();f.advance(1100);const pos={...f.game.position};
  f.game.pause();assert.equal(press(f.game,'→','move'),false);assert.deepEqual(f.game.position,pos);
  f.game.resume();f.advance(90000);assert.equal(f.game.stage,'explore');
});
test('movement stays inside the field and rejects stale commands',()=>{
  const f=fixture();f.game.startSearch();const g=f.game;
  for(let i=0;i<30;i++)press(g,'←','move');assert.equal(g.position.col,0);
  const version=g.layoutVersion;assert(press(g,'↑','move'));
  const pos={...g.position};assert.equal(press(g,'↓','move',{layoutVersion:version}),false);assert.deepEqual(g.position,pos);
  assert.equal(press(g,'0','move'),false);
  assert(g.position.row>=0&&g.position.row<FIELD.rows);
});
test('target contact reveals eight digits for 10 seconds then allows 20 seconds input',()=>{
  const f=fixture();f.game.startSearch();reach(f.game,f.game.nodes.find(n=>n.target));
  assert.equal(f.game.stage,'show');assert.match(f.game.sequence.join(''),/^\d{8}$/);
  assert.equal(press(f.game,'↑','move'),false);assert.equal(press(f.game,'0'),false);
  f.advance(9999);assert.equal(f.game.stage,'show');f.advance(1);assert.equal(f.game.remaining(),20000);
  f.advance(19999);assert.equal(f.game.stage,'input');f.advance(1);assert.equal(f.game.reason,'timeout');
});
test('decimal input includes zero, keeps the keypad stable and completes protocol two',()=>{
  const f=fixture();f.game.startSearch();reach(f.game,f.game.nodes.find(n=>n.target));f.advance(10000);
  f.game.sequence=['0','1','2','3','4','5','6','9'];
  for(const s of f.game.sequence){assert(press(f.game,s));assert.deepEqual(f.game.layout,DIGITS);}
  assert.equal(f.game.stage,'success');assert.equal(f.game.protocol,2);
});
test('wrong digits fail; retry stays in protocol two, final restart returns to protocol one',()=>{
  const f=fixture();f.game.startSearch();reach(f.game,f.game.nodes.find(n=>n.target));f.advance(10000);
  assert(press(f.game,f.game.sequence[0]==='0'?'1':'0'));assert.equal(f.game.stage,'failure');
  f.game.start();assert.equal(f.game.stage,'explore');assert.equal(f.game.protocol,2);
  reach(f.game,f.game.nodes.find(n=>n.target));f.advance(10000);for(const s of f.game.sequence)press(f.game,s);
  f.game.start();assert.equal(f.game.stage,'show');assert.equal(f.game.protocol,1);
  assert.equal(f.game.layout.length,9);assert(f.game.layout.every(k=>!DIGITS.includes(k)));
});
test('non-target nodes keep exploration active',()=>{
  const f=fixture();f.game.startSearch();f.game.nodes=[{col:3,row:5,target:false,sign:'○'},{col:12,row:8,target:true,sign:'◇'}];
  press(f.game,'→','move');assert.equal(f.game.stage,'explore');assert.deepEqual(f.game.sequence,[]);
});
test('phone state never exposes field, target, probe coordinates or the solution',()=>{
  const f=fixture();f.game.startSearch();reach(f.game,f.game.nodes.find(n=>n.target));
  const snapshot=f.game.controllerState();
  for(const key of ['sequence','nodes','position','field','contact','deadline']) assert.equal(key in snapshot,false);
  assert.equal(snapshot.protocol,2);assert.deepEqual(snapshot.layout,DIGITS);
  assert.equal(hexDistance({col:2,row:5},{col:3,row:5}),1);
});
