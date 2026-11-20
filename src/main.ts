import { PaymentRequest, PaymentRequestTransportType } from '@cashu/cashu-ts';
import { nip19 } from 'nostr-tools';
import { walletPayer } from './core/payer';
import { boost, Streamer, type Settlement } from './core/stream';
import { chooseBlock, parseFeed, payable, splitAmount, type Episode, type Feed, type ValueBlock } from './core/value';
import { DEMO_MINT, EcashWallet, type Store } from './core/wallet';

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

function refreshBalance() {
  const b = String(wallet.balance());
  $('balance').textContent = b;
  $('balance2').textContent = b;
  $('mintWarn').classList.toggle('hidden', !/testnut|localhost|127\.0\.0\.1/.test(mintUrl));
}

function setMint(url: string) {
  mintUrl = url.replace(/\/+$/, '');
  localStorage.setItem('nutcast:mint', mintUrl);
  wallet = new EcashWallet(mintUrl, store);
  payer = walletPayer(wallet);
  refreshBalance();
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
  if (block?.suggestedSatsPerMinute && !rateTouched) ($('rate') as HTMLInputElement).value = String(Math.max(1, Math.round(block.suggestedSatsPerMinute)));
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
