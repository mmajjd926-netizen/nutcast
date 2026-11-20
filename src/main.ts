import { PaymentRequest, PaymentRequestTransportType } from '@cashu/cashu-ts';
import { nip19 } from 'nostr-tools';
import { renderSVG } from 'uqr';
import { walletPayer } from './core/payer';
import { boost, Streamer, type Settlement } from './core/stream';
import { chooseBlock, parseFeed, payable, splitAmount, type Episode, type Feed, type ValueBlock } from './core/value';
import { DEMO_MINT, EcashWallet, type Store } from './core/wallet';
import { extensionSigner, fetchPayments, localSigner, newLocalKey, type Signer } from './core/inbox';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const store: Store = { get: (k) => localStorage.getItem(k), set: (k, v) => localStorage.setItem(k, v) };

// Feed text is untrusted: everything below is rendered with textContent, never innerHTML.
function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, ...kids: (Node | string)[]) {
  const e = Object.assign(document.createElement(tag), props);
  for (const k of kids) e.append(k);
  return e;
}

// ---------- wallet ----------
let mintUrl = localStorage.getItem('nutcast:mint') ?? DEMO_MINT;
let wallet = new EcashWallet(mintUrl, store);
let payer = walletPayer(wallet);

/** Every mint this browser holds ecash at (the inbox receives at the payer's mint, so there can be several). */
function mintBalances(): { mint: string; sats: number }[] {
  const out: { mint: string; sats: number }[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const m = /^nutcast:(https?:\/\/.+):proofs$/.exec(localStorage.key(i) ?? '');
    if (!m) continue;
    const sats = m[1] === mintUrl ? wallet.balance() : new EcashWallet(m[1], store).balance();
    if (sats > 0 || m[1] === mintUrl) out.push({ mint: m[1], sats });
  }
  return out.sort((a, b) => b.sats - a.sats);
}

function refreshBalance() {
  const b = String(wallet.balance());
  $('balance').textContent = b;
  $('balance2').textContent = b;
  const test = /testnut|localhost|127\.0\.0\.1/.test(mintUrl);
  $('mintWarn').classList.toggle('hidden', !test);
  $('mintReal').classList.toggle('hidden', test);
  const others = mintBalances().filter((x) => x.mint !== mintUrl);
  $('otherMints').classList.toggle('hidden', !others.length);
  $('otherList').replaceChildren(...others.map((x) => {
    const use = el('button', { type: 'button', className: 'link', textContent: 'use this mint' });
    use.onclick = () => {
      ($('mintUrl') as HTMLInputElement).value = x.mint;
      setMint(x.mint);
    };
    return el('li', {}, el('span', { textContent: new URL(x.mint).host + new URL(x.mint).pathname.replace(/\/$/, '') }), el('span', { textContent: `${x.sats} sat` }), use);
  }));
  const other = others.reduce((s, x) => s + x.sats, 0);
  $('balance').title = other ? `${b} sat at ${new URL(mintUrl).host}, plus ${other} sat at other mints (open the wallet to switch)` : `${b} sat at ${new URL(mintUrl).host}`;
}

function setMint(url: string) {
  url = url.replace(/\/+$/, '');
  // the mint field also fires 'change' on blur; re-rendering then would swallow a click on the mint list
  if (url === mintUrl) return;
  mintUrl = url;
  localStorage.setItem('nutcast:mint', mintUrl);
  wallet = new EcashWallet(mintUrl, store);
  payer = walletPayer(wallet);
  // an invoice on screen belongs to the previous mint; that mint's unpaid top-ups wait until it is chosen again
  $('invoiceBox').classList.add('hidden');
  $('topupState').textContent = '';
  refreshBalance();
  if (wallet.pendingTopUps().length) pollTopUps();
}

function walletMsg(text: string, bad = false) {
  const m = $('walletMsg');
  m.textContent = text;
  m.className = 'small ' + (bad ? 'error' : 'ok');
}

$('walletBtn').onclick = () => {
  ($('mintUrl') as HTMLInputElement).value = mintUrl;
  refreshBalance();
  ($('walletDlg') as HTMLDialogElement).showModal();
};
$('mintUrl').onchange = (e) => setMint((e.target as HTMLInputElement).value || DEMO_MINT);

$('topupBtn').onclick = async () => {
  const amount = Number(($('topupAmt') as HTMLInputElement).value);
  if (!(amount > 0)) return walletMsg('Enter an amount in sats.', true);
  try {
    const t = await wallet.createTopUp(amount);
    $('invoiceBox').classList.remove('hidden');
    ($('invoice') as HTMLTextAreaElement).value = t.invoice;
    const qr = $('invQr') as HTMLAnchorElement;
    // the SVG is drawn by uqr from the invoice (paths only); the invoice comes from the mint
    qr.innerHTML = renderSVG(t.invoice.toUpperCase(), { border: 2 });
    qr.href = 'lightning:' + t.invoice;
    $('topupState').textContent = 'Waiting for payment…';
    pollTopUps();
  } catch (e) {
    walletMsg(String((e as Error).message ?? e), true);
  }
};
$('copyInv').onclick = () => navigator.clipboard?.writeText(($('invoice') as HTMLTextAreaElement).value);

let polling = false;
async function pollTopUps() {
  if (polling) return;
  polling = true;
  try {
    for (let i = 0; i < 120 && wallet.pendingTopUps().length; i++) {
      for (const t of wallet.pendingTopUps()) {
        try {
          const got = await wallet.claimTopUp(t);
          if (got) {
            $('topupState').textContent = `+${got} sat arrived.`;
            refreshBalance();
          }
        } catch {
          /* try again next round */
        }
      }
      await new Promise((r) => setTimeout(r, 2500));
    }
  } finally {
    polling = false;
  }
}

$('receiveBtn').onclick = async () => {
  const input = $('tokenIn') as HTMLInputElement;
  try {
    const got = await wallet.receive(input.value);
    input.value = '';
    walletMsg(`Received ${got} sat.`);
    refreshBalance();
  } catch (e) {
    walletMsg(String((e as Error).message ?? e), true);
  }
};

$('backupBtn').onclick = async () => {
  if (!wallet.balance()) return walletMsg('Nothing to back up yet.');
  if (!confirm('Move all ecash out of this browser into one token? Keep the token safe: whoever has it has the sats.')) return;
  try {
    const token = await wallet.exportAll('Nutcast backup');
    const out = $('backupOut') as HTMLTextAreaElement;
    out.classList.remove('hidden');
    out.value = token;
    walletMsg('This token is your ecash now. Paste it under “Receive” (here or in any Cashu wallet) to get it back.');
    refreshBalance();
  } catch (e) {
    walletMsg(String((e as Error).message ?? e), true);
  }
};

// ---------- feed ----------
let feed: Feed | undefined;
let episode: Episode | undefined;
let block: ValueBlock | undefined;

function showError(msg?: string) {
  const e = $('feedError');
  e.textContent = msg ?? '';
  e.classList.toggle('hidden', !msg);
}

function openFeed(xml: string) {
  try {
    feed = parseFeed(xml);
  } catch (e) {
    return showError((e as Error).message);
  }
  showError();
  $('show').classList.remove('hidden');
  $('showTitle').textContent = feed.title;
  $('showAuthor').textContent = feed.author ?? '';
  const cover = $('cover') as HTMLImageElement;
  cover.src = feed.image ?? '';
  cover.classList.toggle('hidden', !feed.image);
  const list = $('episodes');
  list.replaceChildren();
  feed.episodes.forEach((ep) => {
    const li = el('li', {}, el('button', { className: 'ep', textContent: ep.title, onclick: () => play(ep) }));
    if (ep.value !== feed!.value) li.append(el('span', { className: 'tag', textContent: 'own split', title: 'This episode has its own value split' }));
    list.append(li);
  });
  if (feed.episodes[0]) select(feed.episodes[0]);
}

async function loadUrl(url: string) {
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`The feed answered ${res.status}.`);
    openFeed(await res.text());
  } catch (e) {
    showError(`Could not fetch the feed (${(e as Error).message}). Many hosts block other sites from reading feeds; paste the RSS instead.`);
    $('pasteXml').classList.remove('hidden');
  }
}

$('feedForm').onsubmit = (e) => {
  e.preventDefault();
  const url = ($('feedUrl') as HTMLInputElement).value.trim();
  if (url) loadUrl(url);
};
$('demoBtn').onclick = () => loadUrl(new URL('demo.xml', document.baseURI).toString());
// Real shows whose feeds (and Lightning addresses) let a web page read them.
const FEATURED = [{ name: 'Nodesignal', url: 'https://serve.podhome.fm/rss/e8df0b13-47de-544a-99b7-ec7cbd960a16' }];
for (const f of FEATURED) {
  $('featured').append(el('button', { className: 'link', textContent: f.name, onclick: () => {
    ($('feedUrl') as HTMLInputElement).value = f.url;
    history.replaceState(null, '', '?feed=' + encodeURIComponent(f.url));
    loadUrl(f.url);
  } }));
}
$('pasteBtn').onclick = () => $('pasteXml').classList.toggle('hidden');
$('pasteXml').oninput = (e) => {
  const v = (e.target as HTMLTextAreaElement).value;
  if (v.includes('</rss>')) openFeed(v);
};

function select(ep: Episode) {
  episode = ep;
  block = chooseBlock(ep.value);
  $('epTitle').textContent = ep.title;
  const audio = $('audio') as HTMLAudioElement;
  if (ep.enclosureUrl && audio.src !== ep.enclosureUrl) audio.src = ep.enclosureUrl;
  // Feeds suggest anything from 5 to 21 000 sat/min; start at most at MAX_DEFAULT_RATE and let the listener raise it.
  if (block?.suggestedSatsPerMinute && !rateTouched) ($('rate') as HTMLInputElement).value = String(Math.min(MAX_DEFAULT_RATE, Math.max(1, Math.round(block.suggestedSatsPerMinute))));
  readOpts();
  renderSplit();
}

function play(ep: Episode) {
  select(ep);
  ($('audio') as HTMLAudioElement).play().catch(() => undefined);
}

function renderSplit() {
  const ul = $('split');
  ul.replaceChildren();
  if (!block) {
    ul.append(el('li', { className: 'muted', textContent: 'This show has no value split, so there is no one to stream to.' }));
    $('splitNote').textContent = '';
    return;
  }
  const pct = splitAmount(10000, block.recipients);
  block.recipients.forEach((r, i) => {
    const how = r.kind === 'paymentrequest' ? ['ecash', 'Paid with ecash directly (NUT-18): no Lightning fee'] : r.kind === 'lnaddress' ? ['lightning', 'Paid over Lightning through your mint (melt), in batches'] : ['skip', 'A keysend node: ecash cannot reach it. Its share is skipped, not given to others'];
    ul.append(
      el('li', { className: 'rcp ' + how[0], title: how[1] },
        el('span', { className: 'who', textContent: r.name + (r.fee ? ' (fee)' : '') }),
        el('span', { className: 'pct', textContent: (pct[i] / 100).toFixed(pct[i] % 100 ? 1 : 0) + '%' }),
        el('span', { className: 'via', textContent: how[0] === 'skip' ? 'not reachable' : how[0] })),
    );
  });
  const skipped = block.recipients.filter((r) => !payable(r)).length;
  $('splitNote').textContent = block.type === 'cashu' ? 'This show takes ecash directly.' : skipped ? `${skipped} recipient(s) only take keysend; ecash cannot reach them.` : 'Paid through Lightning addresses.';
}

// ---------- streaming ----------
let rateTouched = false;
const MAX_DEFAULT_RATE = 100;
const streamer = new Streamer({ satsPerMinute: 10, budgetSats: 300 });
function readOpts() {
  streamer.opts.satsPerMinute = Math.max(0, Number(($('rate') as HTMLInputElement).value) || 0);
  streamer.opts.budgetSats = Math.max(0, Number(($('budget') as HTMLInputElement).value) || 0);
  renderStats();
}
$('rate').oninput = () => {
  rateTouched = true;
  readOpts();
};
$('budget').oninput = readOpts;

let accrued = 0;
let last: number | undefined;
const audio = $('audio') as HTMLAudioElement;
audio.addEventListener('seeking', () => (last = undefined));
audio.addEventListener('pause', () => (last = undefined));
audio.addEventListener('timeupdate', () => {
  const t = audio.currentTime;
  const on = ($('streamOn') as HTMLInputElement).checked;
  if (on && block && !audio.paused && last !== undefined) {
    const dt = t - last;
    // only real listening: no seeks, no jumps; playback speed counts as media time
    if (dt > 0 && dt <= 2) accrued += streamer.accrue(dt, block) / 1000;
  }
  last = t;
  renderStats();
});

setInterval(async () => {
  if (!($('streamOn') as HTMLInputElement).checked || !feed) return;
  const done = await streamer.settle(payer, false, `Streamed from Nutcast: ${episode?.title ?? feed.title}`.slice(0, 120));
  if (done.length) {
    done.forEach(addHistory);
    refreshBalance();
  }
  renderStats();
}, 15000);

function renderStats() {
  $('stStreamed').textContent = accrued.toFixed(accrued < 10 ? 2 : 0);
  const paid = streamer.history.filter((h) => h.ok && h.kind === 'stream').reduce((s, h) => s + h.sats, 0);
  const fees = streamer.history.filter((h) => h.ok).reduce((s, h) => s + h.fee, 0);
  $('stPaid').textContent = String(paid);
  $('stFees').textContent = String(fees);
  $('stLeft').textContent = String(Math.floor(streamer.remainingSats()));
}

// ---------- boost ----------
$('boostBtn').onclick = async () => {
  if (!block) return;
  const sats = Math.floor(Number(($('boostAmt') as HTMLInputElement).value));
  if (!(sats > 0)) return;
  if (sats > wallet.balance()) {
    addHistory({ at: Date.now(), recipient: 'Boost', address: '', sats, fee: 0, ok: false, error: 'Not enough ecash: top up your wallet first.', kind: 'boost' });
    return;
  }
  const btn = $('boostBtn') as HTMLButtonElement;
  btn.disabled = true;
  try {
    const msg = ($('boostMsg') as HTMLInputElement).value.trim() || undefined;
    const { results, dropped } = await boost(payer, block, sats, msg);
    results.forEach(addHistory);
    dropped.forEach((r) => addHistory({ at: Date.now(), recipient: r.name, address: r.address, sats: 0, fee: 0, ok: false, error: 'keysend only: skipped', kind: 'boost' }));
  } finally {
    btn.disabled = false;
    refreshBalance();
  }
};

function addHistory(s: Settlement) {
  const li = el('li', { className: s.ok ? 'ok' : 'bad' },
    el('span', { textContent: new Date(s.at).toLocaleTimeString() }),
    el('span', { textContent: `${s.kind === 'boost' ? 'Boost' : 'Stream'} → ${s.recipient}` }),
    el('span', { textContent: s.ok ? `${s.sats} sat${s.fee ? ` + ${s.fee} fee` : ''}` : s.error ?? 'failed' }));
  $('history').prepend(li);
}

refreshBalance();
readOpts();
if (wallet.pendingTopUps().length) pollTopUps();
const qs = new URLSearchParams(location.search).get('feed');
if (qs) {
  ($('feedUrl') as HTMLInputElement).value = qs;
  loadUrl(qs);
}

// ---------- for podcasters ----------
$('creatorBtn').onclick = () => ($('creatorDlg') as HTMLDialogElement).showModal();
$('crMake').onclick = () => {
  const err = $('crErr');
  err.textContent = '';
  try {
    const raw = ($('crNpub') as HTMLInputElement).value.trim().replace(/^nostr:/, '');
    const d = nip19.decode(raw);
    const pubkey = d.type === 'npub' ? d.data : d.type === 'nprofile' ? d.data.pubkey : undefined;
    if (!pubkey) throw new Error('Enter an npub or nprofile.');
    const relays = ($('crRelays') as HTMLInputElement).value.split(/\s+/).filter((r) => /^wss?:\/\//.test(r));
    const mints = ($('crMints') as HTMLInputElement).value.split(/\s+/).filter((m) => /^https?:\/\//.test(m));
    const target = nip19.nprofileEncode({ pubkey, relays });
    const pr = new PaymentRequest([{ type: PaymentRequestTransportType.NOSTR, target, tags: [['n', '17']] }], undefined, undefined, 'sat', mints.length ? mints : undefined, 'Value4Value', false);
    const name = (($('crName') as HTMLInputElement).value.trim() || 'Host').replace(/[<>&"]/g, '');
    const out = $('crOut') as HTMLTextAreaElement;
    out.value = `<podcast:value type="cashu" method="nut18" suggested="0.00000010000">\n  <podcast:valueRecipient name="${name}" type="paymentrequest" address="${pr.toEncodedCreqA()}" split="100"/>\n</podcast:value>`;
    out.classList.remove('hidden');
    out.select();
  } catch (e) {
    err.textContent = (e as Error).message;
  }
};

// ---------- inbox: ecash paid to the podcaster's request ----------
let signer: Signer | undefined;
async function useSigner(sg: Signer, who: string) {
  signer = sg;
  const pk = await sg.getPublicKey();
  ($('crNpub') as HTMLInputElement).value = nip19.npubEncode(pk);
  $('inWho').textContent = who;
  ($('inCheck') as HTMLButtonElement).disabled = false;
}
$('inExt').onclick = async () => {
  try {
    await useSigner(extensionSigner((window as unknown as { nostr?: Parameters<typeof extensionSigner>[0] }).nostr), 'Using your Nostr extension. The key never leaves it.');
  } catch (e) {
    $('inWho').textContent = (e as Error).message;
  }
};
$('inLocal').onclick = async () => {
  let sk = localStorage.getItem('nutcast:inboxKey');
  if (!sk) localStorage.setItem('nutcast:inboxKey', (sk = newLocalKey()));
  await useSigner(localSigner(sk), 'Using a key kept in this browser (good for trying; clearing site data loses it, so take your sats out first).');
};
const doneKey = 'nutcast:inboxDone';
const done = new Set<string>(JSON.parse(localStorage.getItem(doneKey) ?? '[]'));
$('inCheck').onclick = async () => {
  if (!signer) return;
  const btn = $('inCheck') as HTMLButtonElement;
  btn.disabled = true;
  $('inState').textContent = 'Asking relays…';
  try {
    const relays = ($('crRelays') as HTMLInputElement).value.split(/\s+/).filter((r) => /^wss?:\/\//.test(r));
    const pays = await fetchPayments(signer, relays.length ? relays : undefined);
    let got = 0;
    $('inList').replaceChildren();
    for (const p of pays) {
      let status: string;
      let cls = 'ok';
      if (done.has(p.wrapId)) (status = 'received earlier'), (cls = 'old');
      else {
        try {
          // ecash is received at the mint it came from; each mint has its own balance here
          const w = p.mint === mintUrl ? wallet : new EcashWallet(p.mint, store);
          const n = await w.receive(p.token);
          got += p.mint === mintUrl ? n : 0;
          status = `+${n} sat` + (p.mint === mintUrl ? '' : ` at ${new URL(p.mint).host}`);
          done.add(p.wrapId);
        } catch (e) {
          const msg = (e as Error).message;
          // spent proofs were already claimed (by another wallet holding this key, or earlier here);
          // anything else (network, mint down) is worth another try
          if (/spent/i.test(msg)) (status = 'claimed elsewhere'), (cls = 'old'), done.add(p.wrapId);
          else (status = msg.slice(0, 80) + ' (will retry)'), (cls = 'bad');
        }
      }
      $('inList').append(el('li', { className: cls },
        el('span', { textContent: new Date(p.at * 1000).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }) }),
        el('span', { textContent: `${p.amount} sat${p.memo ? ' · ' + p.memo : ''}` }),
        el('span', { textContent: status })));
    }
    localStorage.setItem(doneKey, JSON.stringify([...done]));
    $('inState').textContent = pays.length ? `${pays.length} payment(s) found.` + (got ? ` ${got} sat added to your wallet.` : '') : 'No payments yet.';
    refreshBalance();
  } catch (e) {
    $('inState').textContent = (e as Error).message;
  } finally {
    btn.disabled = false;
  }
};

// For debugging from the console: nutcast.streamer, nutcast.wallet
Object.assign(window, { nutcast: { streamer, get wallet() { return wallet; } } });
