// NIP-61 nutzaps: ecash locked to the recipient's P2PK key and published as a kind 9321 event.
// A show names its Nostr identity with <podcast:txt purpose="nostr">npub…</podcast:txt>; the npub's kind 10019
// says which mints it accepts, which key to lock to (this is NOT the Nostr key) and where to publish.
import { SimplePool, finalizeEvent, generateSecretKey, nip19, type Event } from 'nostr-tools';
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
export function nutzapEvent(info: NutzapInfo, mint: string, proofs: Proof[], comment = '', sk: Uint8Array = generateSecretKey()): Event {
  const tags: string[][] = proofs.map((p) => ['proof', JSON.stringify({ id: p.id, amount: Number(p.amount), secret: p.secret, C: p.C, ...(p.dleq ? { dleq: p.dleq } : {}) })]);
  tags.push(['u', mint], ['p', info.pubkey]);
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
  if (!ok.length) throw new Error('No relay of the show accepted the nutzap.');
  return ok;
}
