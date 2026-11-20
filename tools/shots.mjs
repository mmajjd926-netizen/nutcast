// Screenshots for the README: wallet top-up with QR, and the phone layout. Usage: node tools/shots.mjs <url>
import { chromium } from 'playwright';
const url = process.argv[2] ?? 'http://127.0.0.1:4173/';
const b = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const errs = [];
{
  const p = await b.newPage({ viewport: { width: 1280, height: 900 } });
  p.on('pageerror', (e) => errs.push(e.message));
  await p.goto(url);
  await p.click('#walletBtn');
  await p.fill('#topupAmt', '1000');
  await p.click('#topupBtn');
  await p.waitForSelector('#invQr svg', { timeout: 15000 });
  await p.locator('#walletDlg').screenshot({ path: 'shots/wallet.png' });
  await p.close();
}
{
  const p = await b.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  p.on('pageerror', (e) => errs.push(e.message));
  await p.goto(url);
  await p.click('#demoBtn');
  await p.waitForSelector('#episodes li', { timeout: 15000 });
  await p.waitForFunction(() => { const i = document.getElementById('cover'); return i.complete && i.naturalWidth > 0; }, null, { timeout: 15000 });
  await p.screenshot({ path: 'shots/phone.png', fullPage: true });
  const overflow = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  console.log('horizontal overflow px:', overflow);
  await p.close();
}
console.log(errs.join('\n') || 'no page errors');
await b.close();
