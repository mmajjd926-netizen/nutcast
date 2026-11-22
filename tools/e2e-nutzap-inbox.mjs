// Headless, both sides of NIP-61: a podcaster (fresh key kept in the browser) publishes kind 10019 from "For podcasters",
// a listener opens a feed naming that npub and nutzaps it, the podcaster's inbox redeems the nutzap with the lock key.
// Usage: node tools/e2e-nutzap-inbox.mjs [url]
import { chromium } from 'playwright';
const url = process.argv[2] ?? 'http://127.0.0.1:4173/';
const b = await chromium.launch();
const logs = [];
async function page() {
  const ctx = await b.newContext({ viewport: { width: 1280, height: 1100 } });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => logs.push('pageerror: ' + e.message));
  p.on('dialog', (d) => d.accept());
  await p.goto(url);
  return p;
}
// podcaster
const pod = await page();
await pod.click('#creatorBtn');
await pod.click('#inLocal');
await pod.waitForFunction(() => /accept nutzaps/i.test(document.getElementById('nzAcceptState').textContent), null, { timeout: 20000 });
console.log('before:', await pod.textContent('#nzAcceptState'));
await pod.click('#nzAccept');
await pod.waitForFunction(() => /Published|rror|relay/.test(document.getElementById('nzAcceptState').textContent), null, { timeout: 30000 });
console.log('accept:', await pod.textContent('#nzAcceptState'));
const npub = await pod.inputValue('#crNpub');
console.log('podcaster npub:', npub);

// listener
const lis = await page();
const xml = `<?xml version="1.0"?><rss version="2.0" xmlns:podcast="https://podcastindex.org/namespace/1.0"><channel><title>Inbox test show</title>
<podcast:txt purpose="nostr">${npub}</podcast:txt>
<item><title>Ep 1</title><enclosure url="https://example.com/a.mp3" type="audio/mpeg" length="1"/><guid>e1</guid></item></channel></rss>`;
await lis.click('#pasteBtn');
await lis.fill('#pasteXml', xml);
await lis.waitForSelector('#nzRow:not(.hidden)', { timeout: 20000 });
console.log('listener sees:', (await lis.textContent('#nzState')).trim());
await lis.click('#walletBtn');
await lis.fill('#topupAmt', '100');
await lis.click('#topupBtn');
await lis.waitForFunction(() => document.getElementById('balance').textContent !== '0', null, { timeout: 30000 });
await lis.click('#walletDlg button[value=close]').catch(() => lis.keyboard.press('Escape'));
await lis.fill('#boostAmt', '21');
await lis.fill('#boostMsg', 'Nutzap to the inbox');
await lis.click('#nzBtn');
await lis.waitForFunction(() => /Sent|rror|enough/.test(document.getElementById('nzState').textContent), null, { timeout: 30000 });
console.log('listener:', await lis.textContent('#nzState'));

// podcaster redeems
await new Promise((r) => setTimeout(r, 2000));
await pod.click('#inCheck');
await pod.waitForFunction(() => !/Asking/.test(document.getElementById('inState').textContent), null, { timeout: 40000 });
console.log('inbox:', await pod.textContent('#inState'));
console.log('items:', (await pod.$$eval('#inList li', (l) => l.map((x) => x.innerText.replace(/\s+/g, ' ')))).join(' | '));
console.log('podcaster balance:', await pod.textContent('#balance'));
await pod.locator('#creatorDlg').screenshot({ path: 'shots/nutzap-inbox.png' });
await pod.click('#inCheck');
await pod.waitForFunction(() => !/Asking/.test(document.getElementById('inState').textContent), null, { timeout: 40000 });
console.log('second check:', (await pod.$$eval('#inList li', (l) => l.map((x) => x.innerText.replace(/\s+/g, ' ')))).join(' | '));
console.log(logs.slice(0, 10).join('\n'));
await b.close();
