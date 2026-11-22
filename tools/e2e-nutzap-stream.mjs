// Headless: stream to the demo show as nutzaps (its npub publishes kind 10019 with testnut). Plays the first
// episode at 60 sat/min, waits for two 10-sat nutzaps, then reads them back from the relays and checks the NIP-73 tags.
// Usage: node tools/e2e-nutzap-stream.mjs [url]
import { chromium } from 'playwright';
import WebSocket from 'ws';
import { useWebSocketImplementation, SimplePool } from 'nostr-tools/pool';
useWebSocketImplementation(WebSocket);
const url = process.argv[2] ?? 'http://127.0.0.1:4173/';
const b = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const p = await b.newPage({ viewport: { width: 1280, height: 1100 } });
const errs = [];
p.on('pageerror', (e) => errs.push(e.message));
await p.goto(url);
await p.click('#demoBtn');
await p.waitForSelector('#episodes li');
await p.waitForSelector('#streamNzRow:not(.hidden)', { timeout: 20000 });
await p.click('#walletBtn'); await p.fill('#topupAmt', '100'); await p.click('#topupBtn');
await p.waitForFunction(() => document.getElementById('balance').textContent !== '0', null, { timeout: 30000 });
await p.click('button[value=close]');
const before = Number(await p.textContent('#balance'));
await p.fill('#rate', '60'); await p.check('#streamOn'); await p.check('#streamNz');
const t0 = Math.floor(Date.now() / 1000) - 5;
await p.click('#episodes li:nth-child(1) button');
await p.waitForFunction(() => window.nutcast.streamer.history.filter((h) => h.ok).length >= 2, null, { timeout: 90000 }).catch(() => console.log('TIMEOUT'));
const hist = await p.evaluate(() => window.nutcast.streamer.history.map((h) => ({ r: h.recipient, a: h.address, sats: h.sats, ok: h.ok, e: h.error })));
console.log('stream history:', JSON.stringify(hist));
await p.evaluate(() => document.getElementById('audio').pause());
console.log('balance', before, '->', await p.textContent('#balance'));
await p.locator('#streamNzRow').evaluate((e) => e.closest('.card').scrollIntoView());
await p.locator('#streamNzRow').evaluate((e) => e.closest('.card')).then(() => p.screenshot({ path: 'shots/nutzap-stream.png' }));
const show = hist[0]?.a;
await b.close();
if (show) {
  const pool = new SimplePool();
  const evs = await pool.querySync(['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.primal.net'], { kinds: [9321], '#p': [show], since: t0 });
  for (const e of evs) console.log('relay has', e.id.slice(0, 12), e.content, JSON.stringify(e.tags.filter((t) => t[0] === 'i' || t[0] === 'k')), 'proofs', e.tags.filter((t) => t[0] === 'proof').length);
  pool.close(['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.primal.net']);
}
console.log('errors:', errs.join(' ; ') || 'none');
process.exit(0);
