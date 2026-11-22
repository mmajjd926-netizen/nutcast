// Podcasting 2.0 value blocks: parsing and split math.
// Spec: https://github.com/Podcastindex-org/podcast-namespace/blob/main/docs/tags/value.md
//
// Nutcast reads two kinds of value block:
//   <podcast:value type="lightning" method="keysend|lnaddress"> … the existing standard
//   <podcast:value type="cashu" method="nut18">                 … proposed here: recipients
//        <podcast:valueRecipient type="paymentrequest" address="creqA…" split="…"/>
// A NUT-18 payment request recipient is paid with ecash directly, so there is no mint
// fee per payment and streaming can settle every minute.

// 'nutzap' is never read from a feed: Nutcast makes it for a show that takes NIP-61 nutzaps
// (address = the show's Nostr pubkey, hex), so streaming can go to the show's own Nostr wallet.
export type RecipientKind = 'node' | 'lnaddress' | 'paymentrequest' | 'nutzap' | 'unknown';

export interface ValueRecipient {
  name: string;
  kind: RecipientKind;
  address: string;
  split: number; // shares, or a percentage of the total when fee is true
  fee: boolean;
  customKey?: string;
  customValue?: string;
}

export interface ValueBlock {
  type: string; // "lightning", "cashu", …
  method: string; // "keysend", "lnaddress", "nut18", …
  suggestedSatsPerMinute?: number; // the spec gives BTC per minute; we convert
  recipients: ValueRecipient[];
}

export interface Episode {
  guid: string;
  title: string;
  enclosureUrl?: string;
  enclosureType?: string;
  pubDate?: string;
  image?: string;
  durationSeconds?: number;
  value: ValueBlock[]; // item level if present, else inherited from the channel
}

export interface Feed {
  title: string;
  author?: string;
  image?: string;
  link?: string;
  value: ValueBlock[]; // channel level
  episodes: Episode[];
  /** <podcast:txt purpose="nostr">: the show's Nostr identity (npub), used for NIP-61 nutzaps. */
  nostr?: string;
  /** <podcast:guid>: the show's global id, used for NIP-73 tags on nutzaps. */
  guid?: string;
}

const NS = 'https://podcastindex.org/namespace/1.0';

// Tags are matched by local name so feeds with an unusual prefix still parse.
function children(el: Element, local: string): Element[] {
  return Array.from(el.children).filter((c) => c.localName === local || c.tagName === local || c.tagName.endsWith(':' + local));
}
function child(el: Element, local: string): Element | undefined {
  return children(el, local)[0];
}
function text(el: Element | undefined): string | undefined {
  const t = el?.textContent?.trim();
  return t ? t : undefined;
}
function isPodcastNs(el: Element): boolean {
  return el.namespaceURI === NS || el.tagName.startsWith('podcast:') || el.prefix === 'podcast';
}

function kindOf(t: string | null): RecipientKind {
  switch ((t ?? '').toLowerCase()) {
    case 'node':
    case 'keysend':
      return 'node';
    case 'lnaddress':
      return 'lnaddress';
    case 'paymentrequest':
    case 'nut18':
    case 'cashu':
      return 'paymentrequest';
    default:
      return 'unknown';
  }
}

export function parseValueBlock(el: Element): ValueBlock | undefined {
  const type = (el.getAttribute('type') ?? '').toLowerCase();
  const method = (el.getAttribute('method') ?? '').toLowerCase();
  if (!type) return undefined;
  const suggested = Number(el.getAttribute('suggested'));
  const recipients: ValueRecipient[] = [];
  for (const r of children(el, 'valueRecipient')) {
    const split = Number(r.getAttribute('split'));
    const address = (r.getAttribute('address') ?? '').trim();
    if (!address || !Number.isFinite(split) || split <= 0) continue;
    recipients.push({
      name: r.getAttribute('name') ?? address,
      kind: kindOf(r.getAttribute('type')),
      address,
      split,
      fee: (r.getAttribute('fee') ?? '').toLowerCase() === 'true',
      customKey: r.getAttribute('customKey') ?? undefined,
      customValue: r.getAttribute('customValue') ?? undefined,
    });
  }
  if (!recipients.length) return undefined;
  return {
    type,
    method,
    // suggested is BTC per minute: 0.00000005000 = 5 sats/min
    suggestedSatsPerMinute: Number.isFinite(suggested) && suggested > 0 ? Math.round(suggested * 1e8 * 1000) / 1000 : undefined,
    recipients,
  };
}

function valueBlocks(el: Element): ValueBlock[] {
  return children(el, 'value')
    .filter(isPodcastNs)
    .map(parseValueBlock)
    .filter((b): b is ValueBlock => !!b);
}

function parseDuration(s?: string): number | undefined {
  if (!s) return undefined;
  if (/^\d+$/.test(s)) return Number(s);
  const parts = s.split(':').map(Number);
  if (parts.some((p) => !Number.isFinite(p))) return undefined;
  return parts.reduce((acc, p) => acc * 60 + p, 0);
}

export function parseFeed(xml: string): Feed {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const err = doc.getElementsByTagName('parsererror')[0];
  if (err) throw new Error('This is not valid RSS/XML.');
  const channel = doc.getElementsByTagName('channel')[0];
  if (!channel) throw new Error('No <channel> in this feed.');
  const chanValue = valueBlocks(channel);
  const chanImage = child(channel, 'image');
  const feed: Feed = {
    title: text(child(channel, 'title')) ?? 'Untitled feed',
    author: text(child(channel, 'author')),
    image: text(chanImage ? child(chanImage, 'url') : undefined) ?? channel.querySelector('image[href]')?.getAttribute('href') ?? undefined,
    link: text(child(channel, 'link')),
    value: chanValue,
    episodes: [],
    guid: text(children(channel, 'guid').find(isPodcastNs)),
    nostr: text(children(channel, 'txt').find((t) => isPodcastNs(t) && t.getAttribute('purpose')?.toLowerCase() === 'nostr')),
  };
  for (const item of children(channel, 'item')) {
    const enc = child(item, 'enclosure');
    const own = valueBlocks(item);
    const img = children(item, 'image').find((i) => i.getAttribute('href'))?.getAttribute('href') ?? undefined;
    feed.episodes.push({
      guid: text(child(item, 'guid')) ?? enc?.getAttribute('url') ?? text(child(item, 'title')) ?? String(feed.episodes.length),
      title: text(child(item, 'title')) ?? 'Untitled episode',
      enclosureUrl: enc?.getAttribute('url') ?? undefined,
      enclosureType: enc?.getAttribute('type') ?? undefined,
      pubDate: text(child(item, 'pubDate')),
      image: img,
      durationSeconds: parseDuration(text(child(item, 'duration'))),
      value: own.length ? own : chanValue,
    });
  }
  return feed;
}

/** Which recipients a Cashu wallet can reach, and how. */
export function payable(r: ValueRecipient): boolean {
  return r.kind === 'lnaddress' || r.kind === 'paymentrequest' || r.kind === 'nutzap';
}

/**
 * Choose the block to pay from: a cashu block (direct ecash, no mint fees) wins over
 * lightning; within lightning, only lnaddress recipients are reachable from ecash (melt).
 */
export function chooseBlock(blocks: ValueBlock[]): ValueBlock | undefined {
  return blocks.find((b) => b.type === 'cashu') ?? blocks.find((b) => b.type === 'lightning');
}

/**
 * Split an amount (in any integer unit: sats or msats) among recipients, per the spec:
 * fee recipients take their split as a percentage of the total first; everyone else
 * shares the remainder by their split shares. The result adds up to exactly `total`
 * (largest remainder method), so the listener pays what they chose.
 * Unpayable recipients are still given their share here; the caller decides what to do
 * with it (Nutcast drops it, it is never redistributed: the podcaster's split stands).
 */
export function splitAmount(total: number, recipients: ValueRecipient[]): number[] {
  if (!Number.isInteger(total) || total < 0) throw new Error('total must be a non-negative integer');
  if (!recipients.length) return [];
  const exact = new Array<number>(recipients.length).fill(0);
  const feePct = recipients.reduce((s, r) => s + (r.fee ? r.split : 0), 0);
  const feeShare = Math.min(feePct, 100) / 100;
  recipients.forEach((r, i) => {
    if (r.fee) exact[i] = (total * Math.min(r.split, 100)) / Math.max(feePct, 100);
  });
  const rest = total * (1 - feeShare);
  const shares = recipients.reduce((s, r) => s + (r.fee ? 0 : r.split), 0);
  recipients.forEach((r, i) => {
    if (!r.fee && shares > 0) exact[i] = (rest * r.split) / shares;
  });
  // If only fee recipients exist and they sum below 100%, scale them up to the total.
  const exactSum = exact.reduce((a, b) => a + b, 0);
  if (exactSum > 0 && Math.abs(exactSum - total) > 1e-9) for (let i = 0; i < exact.length; i++) exact[i] = (exact[i] * total) / exactSum;
  const floor = exact.map(Math.floor);
  let left = total - floor.reduce((a, b) => a + b, 0);
  const order = exact.map((x, i) => [x - Math.floor(x), i] as const).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (const [, i] of order) {
    if (left <= 0) break;
    floor[i]++;
    left--;
  }
  return floor;
}
