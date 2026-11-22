import { PaymentRequest, PaymentRequestTransportType } from '@cashu/cashu-ts';
import { nip19 } from 'nostr-tools';
import { renderSVG } from 'uqr';
import { walletPayer } from './core/payer';
import { boost, Streamer, type Payer, type Settlement } from './core/stream';
import { handoffBoost } from './core/handoff';
import { chooseBlock, parseFeed, payable, splitAmount, type Episode, type Feed, type ValueBlock } from './core/value';
import { DEMO_MINT, EcashWallet, type Store } from './core/wallet';
import { fetchNutzapInfo, fetchNutzaps, newNutzapKey, npubHex, nutzapEvent, nutzapInfoTemplate, podcastTags, publishNutzap, publishSigned, sameMint, xOnly, type NutzapInfo } from './core/nutzap';
import type { Event as NostrEvent } from 'nostr-tools';
import { extensionSigner, fetchPayments, localSigner, newLocalKey, type Signer } from './core/inbox';
import { fetchRedeemed, fetchWallet, redeemedTemplate, proofsTotal, signAndPublish, tokenTemplate, walletTemplate, type Nip60Wallet } from './core/nip60';

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
let nz: NutzapInfo | undefined; // the open show's NIP-61 settings, if it takes nutzaps
let payer = withNutzaps(walletPayer(wallet));

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
  payer = withNutzaps(walletPayer(wallet));
  // an invoice on screen belongs to the previous mint; that mint's unpaid top-ups wait until it is chosen again
  $('invoiceBox').classList.add('hidden');
  $('topupState').textContent = '';
  refreshBalance();
  nzExplain();
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
  loadNutzap(feed);
}

// ---------- NIP-61 nutzaps to the show's npub (<podcast:txt purpose="nostr">) ----------
async function loadNutzap(f: Feed) {
  nz = undefined;
  $('nzRow').classList.add('hidden');
  $('streamNzRow').classList.add('hidden');
  const pk = npubHex(f.nostr);
  if (!pk) return;
  try {
    const info = await fetchNutzapInfo(pk);
    if (!info || feed !== f) return;
    nz = info;
    $('nzRow').classList.remove('hidden');
    nzExplain();
  } catch (e) {
    console.warn('nutzap info', e);
  }
}
function nzExplain() {
  if (!nz) return;
  const ok = nz.mints.some((m) => sameMint(m, mintUrl));
  ($('nzBtn') as HTMLButtonElement).disabled = !ok;
  $('streamNzRow').classList.remove('hidden');
  ($('streamNz') as HTMLInputElement).disabled = !ok;
  if (!ok) ($('streamNz') as HTMLInputElement).checked = false;
  $('streamNzNote').textContent = ok ? '' : `(needs ecash from ${nz.mints.map((m) => new URL(m).host).join(', ')})`;
  $('nzState').textContent = ok
    ? `Paid from your wallet at ${new URL(mintUrl).host}, the boost amount and message above.`
    : `The show accepts ecash from ${nz.mints.map((m) => new URL(m).host).join(', ')}. Your wallet is at ${new URL(mintUrl).host}; switch to one of those mints to nutzap.`;
}
/** Lock `sats` to the show's key and publish the nutzap, tagged with the show and episode (NIP-73). */
async function sendNutzap(info: NutzapInfo, sats: number, comment: string): Promise<{ fee: number; id: string; relays: number }> {
  const before = wallet.balance();
  const proofs = await wallet.sendLocked(sats, info.p2pk);
  const ev = nutzapEvent(info, mintUrl, proofs, comment, undefined, podcastTags(feed?.guid, episode?.guid));
  const fee = Math.max(0, before - wallet.balance() - sats);
  try {
    const ok = await publishNutzap(info, ev);
    return { fee, id: ev.id, relays: ok.length };
  } catch {
    // the ecash is locked to the show already: keep the event and send it again, never pay twice
    const pending = JSON.parse(localStorage.getItem(NZ_PENDING) ?? '[]');
    pending.push({ info, ev });
    localStorage.setItem(NZ_PENDING, JSON.stringify(pending));
    return { fee, id: ev.id, relays: 0 };
  }
}

/** The streamer's payer, plus nutzaps to the open show. */
function withNutzaps(p: Payer): Payer {
  return {
    ...p,
    async payNutzap(pubkey, sats, comment) {
      if (!nz || nz.pubkey !== pubkey) throw new Error('The show\'s nutzap settings are not loaded.');
      const r = await sendNutzap(nz, sats, comment ?? '');
      return { fee: r.fee };
    },
  };
}

// Locked proofs cannot come back to us, so an event no relay took is kept and sent again later.
const NZ_PENDING = 'nutcast:nutzapsPending';
async function retryNutzaps() {
  const pending: { info: NutzapInfo; ev: NostrEvent }[] = JSON.parse(localStorage.getItem(NZ_PENDING) ?? '[]');
  if (!pending.length) return;
  const left = [];
  for (const p of pending) {
    try {
      await publishNutzap(p.info, p.ev);
    } catch {
      left.push(p);
    }
  }
  localStorage.setItem(NZ_PENDING, JSON.stringify(left));
}
$('nzBtn').onclick = async () => {
  if (!nz || !feed) return;
  const info = nz;
  const sats = Math.floor(Number(($('boostAmt') as HTMLInputElement).value));
  if (!(sats > 0)) return;
  const msg = ($('boostMsg') as HTMLInputElement).value.trim();
  const who = `${feed.title} (nutzap)`;
  if (sats > wallet.balance()) {
    addHistory({ at: Date.now(), recipient: who, address: '', sats, fee: 0, ok: false, error: 'Not enough ecash: top up your wallet first.', kind: 'boost' });
    return;
  }
  const btn = $('nzBtn') as HTMLButtonElement;
  btn.disabled = true;
  $('nzState').textContent = 'Locking ecash to the show\'s key…';
  try {
    const r = await sendNutzap(info, sats, msg);
    if (r.relays) {
      addHistory({ at: Date.now(), recipient: who, address: info.relays[0] ?? '', sats, fee: r.fee, ok: true, kind: 'boost' });
      $('nzState').textContent = `Sent: nutzap ${r.id.slice(0, 8)}… accepted by ${r.relays} relay(s).`;
    } else {
      addHistory({ at: Date.now(), recipient: who, address: '', sats, fee: r.fee, ok: false, error: 'no relay took it yet; Nutcast will send it again', kind: 'boost' });
      $('nzState').textContent = 'No relay accepted the event yet.';
    }
  } catch (e) {
    addHistory({ at: Date.now(), recipient: who, address: '', sats, fee: 0, ok: false, error: (e as Error).message, kind: 'boost' });
    $('nzState').textContent = (e as Error).message;
  } finally {
    btn.disabled = !info.mints.some((m) => sameMint(m, mintUrl));
    refreshBalance();
  }
};
retryNutzaps();

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

/** What streaming pays: the episode's value split, or the show's Nostr wallet when the listener chose nutzaps. */
function streamBlock(b: ValueBlock): ValueBlock {
  const on = ($('streamNz') as HTMLInputElement).checked && nz && nz.mints.some((m) => sameMint(m, mintUrl));
  if (!on || !nz || !feed) return b;
  return { type: 'cashu', method: 'nutzap', recipients: [{ name: `${feed.title} (nutzap)`, kind: 'nutzap', address: nz.pubkey, split: 100, fee: false }] };
}

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
    if (dt > 0 && dt <= 2) accrued += streamer.accrue(dt, streamBlock(block)) / 1000;
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

// Boost from the listener's own wallet: one QR per recipient, nothing held here.
$('handoffBtn').onclick = async () => {
  if (!block) return;
  const sats = Math.floor(Number(($('boostAmt') as HTMLInputElement).value));
  if (!(sats > 0)) return;
  const box = $('handoff');
  box.classList.remove('hidden');
  box.replaceChildren(el('p', { className: 'small muted', textContent: 'Preparing…' }));
  const msg = ($('boostMsg') as HTMLInputElement).value.trim() || undefined;
  const { items, skipped } = await handoffBoost(block, sats, msg);
  box.replaceChildren(
    ...items.map((h) => {
      const card = el('div', { className: 'item' }, el('b', { textContent: `${h.sats} sat → ${h.name}` }),
        el('div', { className: 'small muted', textContent: h.kind === 'lnaddress' ? 'Lightning invoice' : 'Cashu ecash request (NUT-18)' }));
      if (h.error || !h.code) {
        card.append(el('div', { className: 'small err', textContent: h.error ?? 'nothing to pay' }));
        return card;
      }
      const qr = el('a', { className: 'qr', href: h.uri, title: 'Open in your wallet' });
      // uqr draws paths only, from a code we built (invoice from the recipient's server, checked for its amount)
      qr.innerHTML = renderSVG(h.kind === 'lnaddress' ? h.code.toUpperCase() : h.code, { border: 2 });
      const copy = el('button', { type: 'button', className: 'link', textContent: 'Copy' });
      copy.onclick = () => navigator.clipboard?.writeText(h.code!).then(() => (copy.textContent = 'Copied'));
      card.append(qr, copy);
      return card;
    }),
    ...(skipped.length ? [el('p', { className: 'small muted', textContent: `Keysend only, skipped: ${skipped.join(', ')}` })] : []),
    el('p', { className: 'small muted', textContent: 'Your wallet confirms each payment; this page cannot see them. The message rides along with Lightning invoices.' }),
  );
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
  ($('nzAccept') as HTMLButtonElement).disabled = false;
  showNutzapSetup(pk);
}

// ---------- nutzaps to the podcaster: our kind 10019 and the key nutzaps are locked to ----------
const NZ_KEY = 'nutcast:nutzapKey';
const nzKey = (): { sk: string; pub: string } | undefined => JSON.parse(localStorage.getItem(NZ_KEY) ?? 'null') ?? undefined;
const inRelays = () => ($('crRelays') as HTMLInputElement).value.split(/\s+/).filter((r) => /^wss?:\/\//.test(r));
let myNz: NutzapInfo | undefined;
let nip60: Nip60Wallet | undefined;
const host = (m: string) => new URL(m).host;
async function showNutzapSetup(pk: string) {
  const st = $('nzAcceptState');
  st.textContent = 'Looking for your kind 10019 and NIP-60 wallet…';
  nip60 = undefined;
  let note = '';
  const [info, w] = await Promise.allSettled([fetchNutzapInfo(pk, inRelays()), signer ? fetchWallet(signer, inRelays()) : Promise.resolve(undefined)]);
  if (w.status === 'fulfilled') nip60 = w.value;
  else note = ` (Your NIP-60 wallet could not be read: ${(w.reason as Error).message})`;
  ($('nzToNostr') as HTMLInputElement).checked = !!nip60;
  if (info.status === 'rejected') {
    myNz = undefined;
    st.textContent = `Your kind 10019 is unreadable (${(info.reason as Error).message}).` + note;
    return;
  }
  myNz = info.value;
  const k = nzKey();
  const at = myNz ? myNz.mints.map(host).join(', ') : '';
  if (!myNz) st.textContent = 'You do not accept nutzaps yet.' + (nip60 ? ' You have a NIP-60 wallet: nutzaps will be locked to its key, so that wallet and Nutcast can both redeem them.' : '');
  else if (nip60 && xOnly(myNz.p2pk) === xOnly(nip60.pub)) st.textContent = `You accept nutzaps at ${at}, locked to your NIP-60 wallet key. Nutcast redeems them too and marks them redeemed (kind 7376) for your other wallets.`;
  else if (k && xOnly(myNz.p2pk) === xOnly(k.pub)) st.textContent = `You accept nutzaps at ${at}, locked to the key kept here.` + (nip60 ? ' Your NIP-60 wallet uses another key; publish again to switch to it.' : '');
  else st.textContent = `You accept nutzaps already, locked to a key another wallet holds (${myNz.p2pk.slice(0, 10)}…). Redeem them there, or publish again to have new ones come here.`;
  st.textContent += note;
}
$('nzAccept').onclick = async () => {
  if (!signer) return;
  const st = $('nzAcceptState');
  const btn = $('nzAccept') as HTMLButtonElement;
  const k = nzKey();
  const current = nip60?.pub ?? k?.pub;
  if (myNz && (!current || xOnly(myNz.p2pk) !== xOnly(current)) && !confirm('Your current kind 10019 locks nutzaps to a key held by another wallet. Replace it? Nutzaps already sent stay redeemable there.')) return;
  btn.disabled = true;
  try {
    const typed = ($('crMints') as HTMLInputElement).value.split(/\s+/).filter((m) => /^https:\/\//.test(m));
    const mints = typed.length ? typed : nip60?.mints.length ? nip60.mints : [mintUrl];
    const relays = inRelays().length ? inRelays() : ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.primal.net'];
    let pub: string;
    let made = '';
    if (nip60) pub = nip60.pub;
    else {
      const key = k ?? newNutzapKey();
      if (!k) localStorage.setItem(NZ_KEY, JSON.stringify(key));
      pub = key.pub;
      // No NIP-60 wallet yet: save the key as one (kind 17375), so any NIP-60 wallet you sign into can redeem these nutzaps too.
      // (Only when none was found: kind 17375 is replaceable, and overwriting a wallet would orphan its key.)
      try {
        const r = await signAndPublish(signer, await walletTemplate(signer, key.sk, mints), relays);
        nip60 = { event: r.event, privkey: key.sk, pub: key.pub, mints };
        made = ' The key is also saved as your NIP-60 wallet (kind 17375, encrypted to you), so Nostr wallets that speak NIP-60 can redeem these nutzaps too.';
      } catch (e) {
        made = ` The NIP-60 wallet was not saved (${(e as Error).message}); the key stays in this browser.`;
      }
    }
    const ev = await signer.signEvent(nutzapInfoTemplate(pub, mints, relays));
    const ok = await publishSigned(ev, relays);
    st.textContent = `Published (accepted by ${ok.length} relay(s)). Nutzaps from ${mints.map(host).join(', ')} now come here.` + made;
    myNz = { pubkey: ev.pubkey, p2pk: pub, mints, relays };
  } catch (e) {
    st.textContent = (e as Error).message;
  } finally {
    btn.disabled = false;
  }
};
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
    // nutzaps: public kind 9321 events tagged with our Nostr key, ecash locked to our 10019 key
    const me = await signer.getPublicKey();
    const zaps = await fetchNutzaps(me, relays.length ? relays : undefined).catch(() => []);
    // keys that can unlock nutzaps: the one kept here and the NIP-60 wallet's
    // by x coordinate: wallets publish the same key as 02… or 03… (applesauce always writes 02), and Schnorr ignores the parity
    const keys = new Map<string, string>();
    const k = nzKey();
    if (k) keys.set(xOnly(k.pub), k.sk);
    if (nip60) keys.set(xOnly(nip60.pub), nip60.privkey);
    // nutzaps another NIP-60 wallet (or Nutcast earlier) already marked redeemed
    const redeemed = zaps.length ? await fetchRedeemed(me, relays).catch(() => new Set<string>()) : new Set<string>();
    const toNostr = ($('nzToNostr') as HTMLInputElement).checked;
    const pubRelays = relays.length ? relays : ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.primal.net'];
    for (const z of zaps) {
      let status: string;
      let cls = 'ok';
      const lock = z.lockedTo.map(xOnly).find((p) => keys.has(p));
      if (done.has(z.id)) (status = 'received earlier'), (cls = 'old');
      else if (redeemed.has(z.id)) (status = 'redeemed by your Nostr wallet'), (cls = 'old'), done.add(z.id);
      else if (!lock) (status = 'locked to another key'), (cls = 'old');
      else {
        try {
          const w = z.mint === mintUrl ? wallet : new EcashWallet(z.mint, store);
          let created: string | undefined;
          if (toNostr) {
            const fresh = await w.redeemLocked(z.proofs, keys.get(lock)!);
            const n = proofsTotal(fresh);
            try {
              created = (await signAndPublish(signer, await tokenTemplate(signer, z.mint, fresh), pubRelays)).event.id;
              status = `+${n} sat to your Nostr wallet (NIP-60)`;
            } catch {
              // relays refused the token event: keep the sats here rather than lose them
              w.restore(fresh);
              got += z.mint === mintUrl ? n : 0;
              status = `+${n} sat (kept here: relays refused the NIP-60 token)`;
            }
          } else {
            const n = await w.receiveLocked(z.proofs, keys.get(lock)!);
            got += z.mint === mintUrl ? n : 0;
            status = `+${n} sat` + (z.mint === mintUrl ? '' : ` at ${host(z.mint)}`);
          }
          done.add(z.id);
          // tell the other NIP-60 wallets this nutzap is claimed (best effort)
          if (toNostr || lock === nip60?.pub) signAndPublish(signer, await redeemedTemplate(signer, z, pubRelays[0], created), pubRelays).catch(() => undefined);
        } catch (e) {
          const msg = (e as Error).message;
          if (/spent/i.test(msg)) (status = 'claimed elsewhere'), (cls = 'old'), done.add(z.id);
          else (status = msg.slice(0, 80) + ' (will retry)'), (cls = 'bad');
        }
      }
      $('inList').append(el('li', { className: cls },
        el('span', { textContent: new Date(z.at * 1000).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }) }),
        el('span', { textContent: `${z.amount} sat nutzap${z.comment ? ' · ' + z.comment : ''}` }),
        el('span', { textContent: status })));
    }
    // newest first across both kinds
    const items = [...$('inList').children].map((li, i) => ({ li, at: i < pays.length ? pays[i].at : zaps[i - pays.length].at }));
    $('inList').replaceChildren(...items.sort((a, b) => b.at - a.at).map((x) => x.li));
    localStorage.setItem(doneKey, JSON.stringify([...done]));
    const total = pays.length + zaps.length;
    $('inState').textContent = total ? `${pays.length} payment(s), ${zaps.length} nutzap(s) found.` + (got ? ` ${got} sat added to your wallet.` : '') : 'No payments yet.';
    refreshBalance();
  } catch (e) {
    $('inState').textContent = (e as Error).message;
  } finally {
    btn.disabled = false;
  }
};

// For debugging from the console: nutcast.streamer, nutcast.wallet
Object.assign(window, { nutcast: { streamer, get wallet() { return wallet; } } });
