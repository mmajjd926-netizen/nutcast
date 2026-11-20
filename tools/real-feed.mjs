// Open a real feed through ?feed= and print what Nutcast makes of it. Usage: node tools/real-feed.mjs <feed-url> [site-url]
import { chromium } from 'playwright';
const feed = process.argv[2];
const site = process.argv[3] ?? 'http://127.0.0.1:4173/';
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1280, height: 1000 } });
const errs = [];
p.on('pageerror', (e) => errs.push(e.message));
const t0 = Date.now();
if (feed === 'featured') { await p.goto(site); await p.click('#featured button'); } else await p.goto(site + '?feed=' + encodeURIComponent(feed));
await p.waitForSelector('#episodes li', { timeout: 30000 });
console.log('loaded in', Date.now() - t0, 'ms');
console.log('show:', await p.textContent('#showTitle'), '| episodes:', await p.locator('#episodes li').count());
for (const n of [1, 2, 3]) {
  await p.click(`#episodes li:nth-child(${n}) button`);
  await p.waitForTimeout(300);
  console.log(`ep${n}:`, await p.textContent('#epTitle'));
  console.log('  split:', (await p.$$eval('#split li', (l) => l.map((x) => x.innerText.replace(/\s+/g, ' ')))).join(' | '));
  console.log('  note:', await p.textContent('#splitNote'), '| rate:', await p.inputValue('#rate'));
}
await p.screenshot({ path: 'shots/real-feed.png', fullPage: false });
console.log(errs.join('\n') || 'no page errors');
await b.close();
