// Headless: what a listener owes below the 10-sat nutzap batch is paid when they switch episodes, tagged with the
// episode they heard (NIP-73), not the one they switched to.
// Usage: node tools/e2e-flush.mjs [url]
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
await p.click('#walletBtn'); await p.fill('#topupAmt', '50'); await p.click('#topupBtn');
await p.waitForFunction(() => document.getElementById('balance').textContent !== '0', null, { timeout: 30000 });
await p.click('button[value=close]');
await p.fill('#rate', '10'); await p.check('#streamOn'); await p.check('#streamNz');
const t0 = Math.floor(Date.now() / 1000) - 5;
await p.click('#episodes li:nth-child(1) button');
const ep1 = await p.evaluate(() => window.nutcast.episode?.guid);
await p.waitForFunction(() => window.nutcast.streamer.owedSats() >= 5, null, { timeout: 60000 });
const owed = await p.evaluate(() => window.nutcast.streamer.owedSats());
const paidBefore = await p.evaluate(() => window.nutcast.streamer.history.length);
await p.click('#episodes li:nth-child(2) button');
await p.waitForFunction((n) => window.nutcast.streamer.history.length > n, paidBefore, { timeout: 30000 }).catch(() => console.log('TIMEOUT: nothing paid on switch'));
const ep2 = await p.evaluate(() => window.nutcast.episode?.guid);
const hist = await p.evaluate(() => window.nutcast.streamer.history.map((h) => ({ r: h.recipient, a: h.address, sats: h.sats, ok: h.ok, e: h.error })));
console.log('owed before switch', owed.toFixed(2), 'history', JSON.stringify(hist), 'ep1', ep1, 'ep2', ep2);
await p.evaluate(() => document.getElementById('audio').pause());
const show = hist[0]?.a;
await b.close();
let ok = false;
if (show) {
  const relays = ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.primal.net'];
  const pool = new SimplePool();
  await new Promise((r) => setTimeout(r, 2000));
  const evs = await pool.querySync(relays, { kinds: [9321], '#p': [show], since: t0 });
  for (const e of evs) {
    const tags = e.tags.filter((t) => t[0] === 'i').map((t) => t[1]);
    console.log('relay has', e.id.slice(0, 12), JSON.stringify(e.content), tags.join(' '));
    if (tags.some((t) => t.endsWith(ep1)) && !tags.some((t) => ep2 && t.endsWith(ep2))) ok = true;
  }
  pool.close(relays);
}
console.log(ok ? 'PASS: flushed nutzap carries the episode that was heard' : 'FAIL');
console.log('errors:', errs.join(' ; ') || 'none');
process.exit(ok ? 0 : 1);
