// Headless check: boost from your own wallet (no page wallet). Usage: node tools/e2e-handoff.mjs <url>
import { chromium } from 'playwright';
const url = process.argv[2] ?? 'http://127.0.0.1:4173/';
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1280, height: 1100 } });
const logs = [];
p.on('pageerror', (e) => logs.push('pageerror: ' + e.message));
await p.goto(url);
await p.click('#demoBtn');
await p.waitForSelector('#episodes li', { timeout: 15000 });
for (const ep of [1, 2]) {
  await p.click(`#episodes li:nth-child(${ep}) button`);
  await p.waitForTimeout(500);
  await p.fill('#boostAmt', '100');
  await p.fill('#boostMsg', 'from my own wallet');
  await p.click('#handoffBtn');
  await p.waitForFunction(() => !document.getElementById('handoff').textContent.includes('Preparing'), null, { timeout: 20000 });
  console.log(`ep${ep}:`, (await p.$$eval('#handoff .item', (l) => l.map((x) => x.innerText.replace(/\s+/g, ' ') + ' [qr:' + !!x.querySelector('svg') + ' ' + (x.querySelector('a')?.getAttribute('href') ?? '').slice(0, 24) + ']'))).join(' | '));
  await (await p.$('#handoff')).screenshot({ path: `shots/handoff-ep${ep}.png` });
}
console.log('balance (page wallet untouched):', await p.textContent('#balance'));
console.log(logs.join('\n') || 'no page errors');
await b.close();
