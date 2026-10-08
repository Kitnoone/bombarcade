import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { relayRequest } from '../relay/handler.mjs';
const HOST = 'a'.repeat(64), PHONE = 'b'.repeat(64), OTHER = 'c'.repeat(64);

export function sqliteAdapter(sqlite) {
  return { prepare(sql) {
    let values = [];
    const statement = {
      bind(...args) { values = args; return statement; },
      async first() { return sqlite.prepare(sql).get(...values) || null; },
      async all() { return { results: sqlite.prepare(sql).all(...values) }; },
      async run() { const result = sqlite.prepare(sql).run(...values); return { meta: { changes: Number(result.changes) } }; },
    }; return statement;
  }};
}
function fixture() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../relay/schema.sql', import.meta.url), 'utf8').replaceAll('--> statement-breakpoint', ''));
  const db = sqliteAdapter(sqlite);
  async function call(path, value, token, now = 10000, origin = 'https://kitnoone.github.io') {
    const req = new Request('https://relay.example/api/relay/' + path, {
      method: value === undefined ? 'GET' : 'POST',
      headers: { Origin: origin, ...(token ? { 'X-Bomb-Token': token } : {}), ...(value === undefined ? {} : {'Content-Type':'application/json'}) },
      ...(value === undefined ? {} : { body: JSON.stringify(value) }),
    });
    const res = await relayRequest(req, db, now); return { status: res.status, json: await res.json(), headers: res.headers };
  }
  return { sqlite, db, call };
}
async function setup(call) {
  assert.equal((await call('create', {room:'ABC234',token:HOST})).status, 200);
  assert.equal((await call('ABC234/join', {clientId:'phone-id-1234',token:PHONE,requestId:'request-join-1234'})).status, 200);
}
test('room creation and first phone claim; no takeover or role escalation', async () => {
  const { call, sqlite } = fixture(); try {
    await setup(call);
    assert.equal((await call('create',{room:'ABC234',token:OTHER})).status,409);
    assert.equal((await call('ABC234/join',{clientId:'other-phone-1234',token:OTHER,requestId:'other-join-1234'})).status,409);
    assert.equal((await call('ABC234/state',{kind:'state',state:{remainingMs:15}},PHONE)).status,403);
    assert.equal((await call('ABC234/phone',undefined,HOST)).status,403);
    assert.equal((await call('ABC234/host',undefined,OTHER)).status,403);
    assert.equal((await call('ABC234/join',{clientId:'phone-id-1234',token:PHONE,requestId:'rejoin-request-1234'})).status,200);
  } finally {sqlite.close();}
});
test('phone input reaches the host exactly once despite HTTP retries', async () => {
  const { call, sqlite } = fixture(); try {
    await setup(call);
    const initial = (await call('ABC234/host',undefined,HOST)).json.events;
    assert.equal(initial[0].packet.kind,'hello');
    const packet={kind:'key',symbol:'↑',round:1,layoutVersion:2,command:1};
    const body={requestId:'request-key-1234',packet};
    await call('ABC234/event',body,PHONE); await call('ABC234/event',body,PHONE);
    const events=(await call('ABC234/host?after='+initial[0].id,undefined,HOST)).json.events;
    assert.equal(events.length,1); assert.deepEqual(events[0].packet,packet);
    assert.equal((await call('ABC234/host?after='+events[0].id,undefined,HOST)).json.events.length,0);
  } finally {sqlite.close();}
});
test('countdown ages on the server; paused timer remains frozen',async()=>{
  const {call,sqlite}=fixture();try{
    await setup(call);
    await call('ABC234/state',{kind:'state',state:{remainingMs:15000,paused:false}},HOST,10000);
    const answer=(await call('ABC234/phone',undefined,PHONE,11300)).json;
    assert.equal(answer.packet.state.remainingMs,13700);
    assert.equal(answer.serverNow,11300);
    await call('ABC234/state',{kind:'state',state:{remainingMs:13700,paused:true}},HOST,11300);
    assert.equal((await call('ABC234/phone',undefined,PHONE,50000)).json.packet.state.remainingMs,13700);
    assert.equal((await call('ABC234/state',{kind:'state',state:{remainingMs:100,sequence:['↑']}},HOST)).status,400);
  }finally{sqlite.close();}
});
test('unknown and expired rooms, invalid packets and foreign origins fail clearly',async()=>{
  const {call,sqlite}=fixture();try{
    await setup(call);
    assert.equal((await call('ZZZ999/join',{token:PHONE,clientId:'phone-id-1234',requestId:'join-unknown-1234'})).status,404);
    assert.equal((await call('ABC234/phone',undefined,PHONE,8_000_000)).status,404);
    assert.equal((await call('ABC234/event',{requestId:'bad-input-1234',packet:{kind:'admin'}},PHONE)).status,400);
    assert.equal((await call('health',undefined,undefined,10000,'https://other.example')).status,403);
  }finally{sqlite.close();}
});
test('second protocol movement and all decimal digits cross the relay',async()=>{
  const {call,sqlite}=fixture();try{
    await setup(call);
    for(const [i,symbol] of ['↑','↓','←','→','0','1','2','3','4','5','6','7','8','9'].entries()){
      const packet={kind:i<4?'move':'key',symbol,round:2,layoutVersion:i,command:i+1};
      assert.equal((await call('ABC234/event',{requestId:'second-protocol-'+i,packet},PHONE)).status,200);
    }
    const events=(await call('ABC234/host',undefined,HOST)).json.events.filter(e=>e.packet.kind!=='hello');
    assert.equal(events.length,14);assert.equal(events[4].packet.symbol,'0');
    assert.equal((await call('ABC234/event',{requestId:'invalid-move-1234',packet:{kind:'move',symbol:'5',round:2,layoutVersion:1,command:1}},PHONE)).status,400);
  }finally{sqlite.close();}
});
