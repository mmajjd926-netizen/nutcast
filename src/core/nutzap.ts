// NIP-61 nutzaps: ecash locked to the recipient's P2PK key and published as a kind 9321 event.
// A show names its Nostr identity with <podcast:txt purpose="nostr">npub…</podcast:txt>; the npub's kind 10019
// says which mints it accepts, which key to lock to (this is NOT the Nostr key) and where to publish.
import { SimplePool, finalizeEvent, generateSecretKey, nip19, verifyEvent, type Event } from 'nostr-tools';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import type { Proof } from '@cashu/cashu-ts';
import { FALLBACK_RELAYS } from './nostr';

export interface NutzapInfo {
  /** The recipient's Nostr key (hex), for the `p` tag. */
  pubkey: string;
  /** The key the proofs are locked to (compressed, 66 hex). */
  p2pk: string;
  mints: string[];
  relays: string[];
}

const hex = /^[0-9a-f]+$/i;

/** NIP-61 lets the `pubkey` tag be x-only; Cashu needs a compressed point, so an x-only key gets the 02 prefix. */
export function lockKey(tag: string): string {
  const k = tag.trim().toLowerCase();
  if (k.length === 66 && hex.test(k) && (k.startsWith('02') || k.startsWith('03'))) return k;
  if (k.length === 64 && hex.test(k)) return '02' + k;
  throw new Error('The nutzap key in kind 10019 is not a public key.');
}

/** The x coordinate of a key given as 02…/03… or x-only: the part Schnorr signatures (NUT-11) check. */
export const xOnly = (pub: string) => pub.toLowerCase().slice(-64);

export const sameMint = (a: string, b: string) => a.replace(/\/+$/, '').toLowerCase() === b.replace(/\/+$/, '').toLowerCase();

/** Reads a kind 10019 event. Without a mint or a key there is nothing a payer can do, so that is an error. */
export function parseNutzapInfo(ev: Pick<Event, 'pubkey' | 'tags' | 'kind'>): NutzapInfo {
  if (ev.kind !== 10019) throw new Error('Not a nutzap info event (kind 10019).');
  const mints = ev.tags.filter((t) => t[0] === 'mint' && /^https:\/\//.test(t[1] ?? '')).map((t) => t[1].replace(/\/+$/, ''));
  const relays = ev.tags.filter((t) => t[0] === 'relay' && /^wss?:\/\//.test(t[1] ?? '')).map((t) => t[1]);
  const key = ev.tags.find((t) => t[0] === 'pubkey')?.[1];
  if (!mints.length) throw new Error('The show lists no mints for nutzaps.');
  if (!key) throw new Error('The show names no key to lock nutzaps to.');
  return { pubkey: ev.pubkey, p2pk: lockKey(key), mints, relays: relays.length ? relays : FALLBACK_RELAYS };
}

/** The npub (as hex) a feed names with <podcast:txt purpose="nostr">, if any. */
export function npubHex(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const d = nip19.decode(value.trim().replace(/^nostr:/, ''));
    if (d.type === 'npub') return d.data;
    if (d.type === 'nprofile') return d.data.pubkey;
  } catch {
    /* not a bech32 key */
  }
  return /^[0-9a-f]{64}$/i.test(value.trim()) ? value.trim().toLowerCase() : undefined;
}

let pool: SimplePool | undefined;

/** The newest kind 10019 of `pubkey`, or undefined if no relay has one. */
export async function fetchNutzapInfo(pubkey: string, relays: string[] = FALLBACK_RELAYS): Promise<NutzapInfo | undefined> {
  pool ??= new SimplePool();
  const evs = await pool.querySync([...new Set([...relays, ...FALLBACK_RELAYS])], { kinds: [10019], authors: [pubkey] }, { maxWait: 5000 });
  const ev = evs.sort((a, b) => b.created_at - a.created_at)[0];
  return ev ? parseNutzapInfo(ev) : undefined;
}

/**
 * The kind 9321 event for proofs already locked to `info.p2pk` at `mint`.
 * Proofs keep their DLEQ (NUT-12) so the recipient can check them without asking the mint.
 * Signed with a fresh key: the nutzap is public, and nothing ties two of them to one listener.
 */
/**
 * NIP-73 tags naming what the nutzap is for: the episode (`podcast:item:guid`) and the show (`podcast:guid`),
 * so a client can show the nutzaps an episode got, the way Podcasting 2.0 apps show boosts.
 */
export function podcastTags(showGuid?: string, itemGuid?: string): string[][] {
  const t: string[][] = [];
  if (itemGuid) t.push(['i', `podcast:item:guid:${itemGuid}`], ['k', 'podcast:item:guid']);
  if (showGuid) t.push(['i', `podcast:guid:${showGuid}`], ['k', 'podcast:guid']);
  return t;
}

export function nutzapEvent(info: NutzapInfo, mint: string, proofs: Proof[], comment = '', sk: Uint8Array = generateSecretKey(), extraTags: string[][] = []): Event {
  const tags: string[][] = proofs.map((p) => ['proof', JSON.stringify({ id: p.id, amount: Number(p.amount), secret: p.secret, C: p.C, ...(p.dleq ? { dleq: p.dleq } : {}) })]);
  tags.push(['u', mint], ['p', info.pubkey], ...extraTags);
  return finalizeEvent({ kind: 9321, created_at: Math.floor(Date.now() / 1000), content: comment, tags }, sk);
}

/** Publish to the recipient's relays; resolves with the relays that accepted it. */
export async function publishNutzap(info: NutzapInfo, ev: Event, timeoutMs = 8000): Promise<string[]> {
  pool ??= new SimplePool();
  const relays = info.relays;
  const results = await Promise.allSettled(
    pool.publish(relays, ev).map((p, i) =>
      Promise.race([p.then(() => relays[i]), new Promise<string>((_, rej) => setTimeout(() => rej(new Error('timeout')), timeoutMs))]),
    ),
  );
  const ok = results.filter((r): r is PromiseFulfilledResult<string> => r.status === 'fulfilled').map((r) => r.value);
  if (!ok.length) throw new Error('No relay accepted the event.');
  return ok;
}

// ---------- the receiving side: a podcaster who takes nutzaps ----------

/** A fresh key for nutzaps to be locked to. It is NOT the Nostr key: losing it loses the locked sats, so it stays apart. */
export function newNutzapKey(): { sk: string; pub: string } {
  const sk = generateSecretKey();
  const toHex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return { sk: toHex(sk), pub: toHex(secp256k1.getPublicKey(sk, true)) };
}

export function nutzapPub(skHex: string): string {
  const sk = Uint8Array.from(skHex.match(/../g)!.map((h) => parseInt(h, 16)));
  return [...secp256k1.getPublicKey(sk, true)].map((x) => x.toString(16).padStart(2, '0')).join('');
}

/** The kind 10019 a podcaster publishes so payers know where and how to send nutzaps. */
export function nutzapInfoTemplate(p2pk: string, mints: string[], relays: string[]) {
  if (!mints.length) throw new Error('Name at least one mint you accept.');
  return {
    kind: 10019,
    created_at: Math.floor(Date.now() / 1000),
    content: '',
    tags: [...relays.map((r) => ['relay', r]), ...mints.map((m) => ['mint', m.replace(/\/+$/, ''), 'sat']), ['pubkey', lockKey(p2pk)]],
  };
}

export interface IncomingNutzap {
  id: string;
  at: number;
  sender: string;
  mint: string;
  amount: number;
  comment: string;
  proofs: Proof[];
  /** The P2PK keys the proofs are locked to (normally one). */
  lockedTo: string[];
}

/** Read a kind 9321 event. Throws if it carries no proofs or no mint. */
export function parseNutzap(ev: Event): IncomingNutzap {
  if (ev.kind !== 9321) throw new Error('not a nutzap');
  if (!verifyEvent(ev)) throw new Error('bad signature');
  const mint = ev.tags.find((t) => t[0] === 'u')?.[1];
  if (!mint || !/^https?:\/\//.test(mint)) throw new Error('nutzap names no mint');
  const proofs = ev.tags.filter((t) => t[0] === 'proof').map((t) => JSON.parse(t[1]) as Proof);
  if (!proofs.length) throw new Error('nutzap carries no proofs');
  const lockedTo = new Set<string>();
  for (const p of proofs) {
    try {
      const s = JSON.parse(p.secret);
      if (Array.isArray(s) && s[0] === 'P2PK' && typeof s[1]?.data === 'string') lockedTo.add(s[1].data.toLowerCase());
    } catch {
      /* not a well-known secret: unlocked ecash */
    }
  }
  return {
    id: ev.id,
    at: ev.created_at,
    sender: ev.pubkey,
    mint: mint.replace(/\/+$/, ''),
    amount: proofs.reduce((s, p) => s + Number(p.amount), 0),
    comment: ev.content,
    proofs,
    lockedTo: [...lockedTo],
  };
}

/** Nutzaps addressed to `pubkey` (the podcaster's Nostr key) on `relays`, newest first. */
export async function fetchNutzaps(pubkey: string, relays: string[] = FALLBACK_RELAYS, sinceDays = 30): Promise<IncomingNutzap[]> {
  pool ??= new SimplePool();
  const since = Math.floor(Date.now() / 1000) - sinceDays * 86400;
  const evs = await pool.querySync([...new Set([...relays, ...FALLBACK_RELAYS])], { kinds: [9321], '#p': [pubkey], since }, { maxWait: 6000 });
  const seen = new Set<string>();
  const out: IncomingNutzap[] = [];
  for (const e of evs) {
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    try {
      out.push(parseNutzap(e));
    } catch {
      /* junk */
    }
  }
  return out.sort((a, b) => b.at - a.at);
}

/** Publish an already signed event (the podcaster's kind 10019) to `relays`. */
export async function publishSigned(ev: Event, relays: string[], timeoutMs = 8000): Promise<string[]> {
  return publishNutzap({ pubkey: ev.pubkey, p2pk: '', mints: [], relays }, ev, timeoutMs);
}
