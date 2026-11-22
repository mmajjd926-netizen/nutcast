// Headless, NIP-60 interop on live relays and testnut:
// 1. a podcaster's NIP-60 wallet (kind 17375) and kind 10019 are made by applesauce-wallet, as another app would;
// 2. a listener nutzaps the show from Nutcast (locked to that wallet's key);
// 3. the podcaster signs into Nutcast with the same Nostr key: Nutcast finds the 17375 key, redeems the nutzap
//    into a kind 7375 token event and marks it redeemed (kind 7376);
// 4. applesauce reads the token event back and the mint says the proofs are unspent; a fresh browser skips the nutzap as redeemed.
// Usage: node tools/e2e-nip60.mjs [url]
import { chromium } from 'playwright';
import { generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';
import { PrivateKeySigner } from 'applesauce-signers';
import { WalletFactory, NutzapInfoFactory } from 'applesauce-wallet/factories';
import { unlockTokenContent, isNutzapRedeemed } from 'applesauce-wallet/helpers';
import { Wallet } from '@cashu/cashu-ts';
import WebSocket from 'ws';
import { SimplePool, useWebSocketImplementation } from 'nostr-tools/pool';
useWebSocketImplementation(WebSocket); // node's own WebSocket recurses in nostr-tools when a relay refuses

const url = process.argv[2] ?? 'http://127.0.0.1:4173/';
const MINT = 'https://testnut.cashu.space';
const RELAYS = ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.primal.net'];
const hex = (b) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
const pool = new SimplePool();
const publish = async (ev) => {
  const r = await Promise.allSettled(pool.publish(RELAYS, ev));
  return r.filter((x) => x.status === 'fulfilled').length;
};

// 1. the other app
const sk = generateSecretKey();
const pk = getPublicKey(sk);
const signer = new PrivateKeySigner(sk);
const walletKey = generateSecretKey();
const wEv = await WalletFactory.create([MINT], walletKey, RELAYS).sign(signer);
const iEv = await NutzapInfoFactory.create().setMints([{ url: MINT, units: ['sat'] }]).setRelays(RELAYS).setPubkey(walletKey).sign(signer);
console.log('applesauce wallet 17375 accepted by', await publish(wEv), '/ 10019 by', await publish(iEv));
const npub = nip19.npubEncode(pk);

const b = await chromium.launch();
const logs = [];
async function page(inboxKey) {
  const ctx = await b.newContext({ viewport: { width: 1280, height: 1100 } });
  if (inboxKey) await ctx.addInitScript((k) => localStorage.setItem('nutcast:inboxKey', k), inboxKey);
  const p = await ctx.newPage();
  p.on('pageerror', (e) => logs.push('pageerror: ' + e.message));
  p.on('dialog', (d) => d.accept());
  await p.goto(url);
  return p;
}

// 2. listener
const lis = await page();
const xml = `<?xml version="1.0"?><rss version="2.0" xmlns:podcast="https://podcastindex.org/namespace/1.0"><channel><title>NIP-60 test show</title>
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
await lis.fill('#boostMsg', 'Nutzap into a NIP-60 wallet');
await lis.click('#nzBtn');
await lis.waitForFunction(() => /Sent|rror|enough/.test(document.getElementById('nzState').textContent), null, { timeout: 30000 });
console.log('listener:', await lis.textContent('#nzState'));

// 3. podcaster in Nutcast, same Nostr key
const pod = await page(hex(sk));
await pod.click('#creatorBtn');
await pod.click('#inLocal');
await pod.waitForFunction(() => !/Looking/.test(document.getElementById('nzAcceptState').textContent), null, { timeout: 20000 });
console.log('setup:', await pod.textContent('#nzAcceptState'));
console.log('keep in Nostr wallet checked:', await pod.isChecked('#nzToNostr'));
await new Promise((r) => setTimeout(r, 2000));
await pod.click('#inCheck');
await pod.waitForFunction(() => !/Asking/.test(document.getElementById('inState').textContent), null, { timeout: 40000 });
console.log('inbox:', await pod.textContent('#inState'));
console.log('items:', (await pod.$$eval('#inList li', (l) => l.map((x) => x.innerText.replace(/\s+/g, ' ')))).join(' | '));
console.log('balance in this browser (should stay 0):', await pod.textContent('#balance'));
await pod.locator('#creatorDlg').screenshot({ path: 'shots/nip60-inbox.png' });

// 4. applesauce reads it back
await new Promise((r) => setTimeout(r, 3000));
const tokens = await pool.querySync(RELAYS, { kinds: [7375], authors: [pk] }, { maxWait: 6000 });
const hist = await pool.querySync(RELAYS, { kinds: [7376], authors: [pk] }, { maxWait: 6000 });
const zaps = await pool.querySync(RELAYS, { kinds: [9321], '#p': [pk] }, { maxWait: 6000 });
console.log(`relays: ${tokens.length} token event(s), ${hist.length} history event(s), ${zaps.length} nutzap(s)`);
let total = 0;
const w = new Wallet(MINT);
await w.loadMint();
for (const t of tokens) {
  const c = await unlockTokenContent(t, signer);
  const st = await w.checkProofsStates(c.proofs);
  const sum = c.proofs.reduce((s, p) => s + Number(p.amount), 0);
  console.log(`  7375 ${t.id.slice(0, 8)}: ${c.mint} ${sum} sat, states ${[...new Set(st.map((s) => s.state))].join(',')}`);
  total += sum;
}
console.log('applesauce sees', total, 'sat; nutzap redeemed per 7376:', zaps.map((z) => isNutzapRedeemed(z.id, hist)).join(','));

// a fresh browser (no local memory of the nutzap) skips it because of the 7376 marker
const fresh = await page(hex(sk));
await fresh.click('#creatorBtn');
await fresh.click('#inLocal');
await fresh.waitForFunction(() => !/Looking/.test(document.getElementById('nzAcceptState').textContent), null, { timeout: 20000 });
await fresh.click('#inCheck');
await fresh.waitForFunction(() => !/Asking/.test(document.getElementById('inState').textContent), null, { timeout: 40000 });
console.log('fresh browser:', (await fresh.$$eval('#inList li', (l) => l.map((x) => x.innerText.replace(/\s+/g, ' ')))).join(' | '));
console.log(logs.slice(0, 10).join('\n'));
await b.close();
pool.close(RELAYS);
process.exit(0);
