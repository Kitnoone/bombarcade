import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { createBombarcadeServer } from '../server.mjs';
import { relayRequest } from '../relay/handler.mjs';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { server, hub } = createBombarcadeServer();
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ channel:'chrome', headless:true });
const sqlite = new DatabaseSync(':memory:');
sqlite.exec(readFileSync(new URL('../relay/schema.sql', import.meta.url),'utf8').replaceAll('--> statement-breakpoint',''));
const db = { prepare(sql) { let values = []; const statement = { bind(...args) { values = args; return statement; }, async first() { return sqlite.prepare(sql).get(...values) || null; }, async all() { return { results:sqlite.prepare(sql).all(...values) }; }, async run() { const r=sqlite.prepare(sql).run(...values); return {meta:{changes:Number(r.changes)}}; } }; return statement; } };
const checks = [], errors = [];
try {
  for (const mode of ['demo','relay']) {
    const contexts = [];
    const context = await browser.newContext({viewport:{width:1920,height:1080}}); contexts.push(context);
    let requests = 0;
    async function routes(c) {
      await c.route('**/api/local', route => route.fulfill({status:404,body:'Static hosting'}));
      await c.route('https://bombarcade-relay.kittyty.chatgpt.site/api/relay/**', async route => {
        requests++;
        const r = route.request(), headers = r.headers();
        const response = await relayRequest(new Request(r.url(), {method:r.method(),headers,...(r.method()==='POST'?{body:r.postData()}: {})}), db);
        await route.fulfill({status:response.status,headers:Object.fromEntries(response.headers),body:await response.text()});
      });
    }
    await routes(context);
    const host = await context.newPage(); host.on('pageerror',e=>errors.push(e.message));
    await host.goto(`${base}/?view=host${mode === 'demo' ? '&transport=local' : ''}`);
    await host.waitForFunction(() => document.querySelector('#phone-link').href.includes('room='));
    const url = await host.locator('#phone-link').getAttribute('href');
    let phoneContext = context;
    if (mode === 'relay') { phoneContext = await browser.newContext({viewport:{width:390,height:844}}); contexts.push(phoneContext); await routes(phoneContext); }
    const phone = await phoneContext.newPage(); phone.on('pageerror',e=>errors.push(e.message));
    await phone.goto(url); await host.waitForFunction(() => document.querySelector('#host-connection').textContent.includes('подключён'));
    await host.locator('#master-toggle').click(); await host.locator('#length').selectOption('4'); await host.locator('#master-close').click();
    await host.locator('#start').click(); await host.waitForFunction(() => document.body.dataset.stage === 'show');
    const code = await host.locator('#sequence .sequence-tile>span').allTextContents(); assert.equal(code.length,4);
    await phone.waitForFunction(() => document.body.dataset.stage === 'input', null, {timeout:15000});
    for (let i=0;i<code.length;i++) {
      await phone.locator(`#keypad button[data-symbol="${code[i]}"]`).click();
      if (i<code.length-1) await phone.waitForFunction(n=>document.querySelectorAll('#phone-progress .filled').length===n,i+1);
    }
    await host.waitForFunction(()=>document.body.dataset.stage==='explore'); await phone.waitForFunction(()=>document.body.dataset.stage==='explore');
    await phone.locator('[data-direction="→"]').click();
    await host.waitForFunction(()=>document.querySelector('#field').dataset.position==='3:5');
    assert.equal(await phone.locator('#phone-error').textContent(),'');
    if (mode==='demo') assert.equal(requests,0); else assert(requests>20);
    checks.push(`${mode}: real client handshake, four shuffled keys, automatic phase transition, movement and ACKs`);
    console.log('PASS',checks.at(-1));
    for (const c of contexts) await c.close();
  }
  assert.deepEqual(errors,[]);
  await mkdir('test-results',{recursive:true}); await writeFile('test-results/fallback-report.json',JSON.stringify({checks,errors,relay:'production handler with local SQLite; no requests to live service'},null,2));
} finally {
  await browser.close(); sqlite.close(); for (const s of hub.sessions.values()) s.close(); await new Promise(resolve=>server.close(resolve));
}
