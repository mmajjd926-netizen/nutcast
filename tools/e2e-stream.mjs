// Headless: real playback of the demo's first episode with streaming on. Usage: node tools/e2e-stream.mjs <url>
import { chromium } from 'playwright';
const url = process.argv[2] ?? 'http://127.0.0.1:4173/';
const b = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const p = await b.newPage();
const errs = [];
p.on('pageerror', (e) => errs.push(e.message));
await p.goto(url);
await p.click('#demoBtn');
await p.waitForSelector('#episodes li');
await p.click('#walletBtn'); await p.fill('#topupAmt', '200'); await p.click('#topupBtn');
await p.waitForFunction(() => document.getElementById('balance').textContent !== '0', null, { timeout: 30000 });
await p.click('button[value=close]');
await p.fill('#rate', '60'); await p.check('#streamOn');
await p.click('#episodes li:nth-child(1) button');
for (let i = 0; i < 11; i++) {
  await p.waitForTimeout(5000);
  const st = await p.evaluate(() => ({ t: document.getElementById('audio').currentTime.toFixed(1), paused: document.getElementById('audio').paused,
    acc: document.getElementById('stStreamed').textContent, paid: document.getElementById('stPaid').textContent, bal: document.getElementById('balance').textContent }));
  console.log(JSON.stringify(st), await p.evaluate(() => { const s = window.nutcast.streamer; return JSON.stringify({ owed: s.owedSats(), settling: !!s.settling, hist: s.history.length, opts: s.opts }); }));
}
console.log('history:', (await p.$$eval('#history li', (l) => l.map((x) => x.innerText.replace(/\s+/g, ' ')))).join(' | '));
console.log('errors:', errs.join(' ; '));
await b.close();
