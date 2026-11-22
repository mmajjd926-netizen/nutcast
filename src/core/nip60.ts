// NIP-60 (Cashu wallets on Nostr), the parts a podcaster's inbox needs so Nutcast and any other
// NIP-60 wallet work on the same nutzaps:
// - kind 17375: the wallet, NIP-44 encrypted to yourself: [["privkey", hex], ["mint", url], …].
//   Its privkey is the key nutzaps are locked to (the pubkey in kind 10019).
//   If the podcaster already has one, Nutcast uses that key instead of making its own.
// - kind 7376: history. A redeemed nutzap gets an unencrypted ["e", <9321 id>, relay, "redeemed"] tag,
//   so wallets can tell which nutzaps are already claimed without asking the mint.
// - kind 7375: unspent proofs, encrypted. Redeemed nutzaps can be kept there instead of in this browser,
//   so the sats show up in the podcaster's other NIP-60 wallets.
import { serializeProofs, type Proof } from '@cashu/cashu-ts';
import { SimplePool, type Event, type EventTemplate } from 'nostr-tools';
import { FALLBACK_RELAYS } from './nostr';
import { nutzapPub } from './nutzap';

export interface Nip60Signer {
  getPublicKey(): Promise<string>;
  nip44Encrypt(peer: string, plaintext: string): Promise<string>;
  nip44Decrypt(peer: string, ciphertext: string): Promise<string>;
  signEvent(template: EventTemplate): Promise<Event>;
}

export interface Nip60Wallet {
  event: Event;
  privkey: string;
  /** Compressed pubkey of privkey ("02…"), the form kind 10019 and P2PK secrets use. */
  pub: string;
  mints: string[];
}

let pool: SimplePool | undefined;
const now = () => Math.floor(Date.now() / 1000);
const relaySet = (relays: string[]) => [...new Set([...relays, ...FALLBACK_RELAYS])];

/** Read a kind 17375 event (content already decrypted). */
export function parseWalletContent(plain: string): { privkey?: string; mints: string[] } {
  const tags = JSON.parse(plain);
  if (!Array.isArray(tags)) throw new Error('The wallet event content is not a tag list.');
  const privkey = tags.find((t) => Array.isArray(t) && t[0] === 'privkey')?.[1];
  if (privkey !== undefined && !/^[0-9a-f]{64}$/i.test(privkey)) throw new Error('The wallet privkey is not 32 bytes of hex.');
  const mints = tags.filter((t) => Array.isArray(t) && t[0] === 'mint' && typeof t[1] === 'string').map((t) => t[1].replace(/\/+$/, ''));
  return { privkey: privkey?.toLowerCase(), mints };
}

/** The newest kind 17375 of the signer, decrypted. undefined if no relay has one. */
export async function fetchWallet(signer: Nip60Signer, relays: string[] = []): Promise<Nip60Wallet | undefined> {
  const me = await signer.getPublicKey();
  pool ??= new SimplePool();
  const evs = await pool.querySync(relaySet(relays), { kinds: [17375], authors: [me] }, { maxWait: 5000 });
  const ev = evs.filter((e) => e.pubkey === me).sort((a, b) => b.created_at - a.created_at)[0];
  if (!ev) return undefined;
  const { privkey, mints } = parseWalletContent(await signer.nip44Decrypt(me, ev.content));
  if (!privkey) throw new Error('Your NIP-60 wallet event has no privkey, so it cannot redeem nutzaps.');
  return { event: ev, privkey, pub: nutzapPub(privkey), mints };
}

export async function walletTemplate(signer: Nip60Signer, privkey: string, mints: string[]): Promise<EventTemplate> {
  if (!mints.length) throw new Error('A NIP-60 wallet needs at least one mint.');
  const me = await signer.getPublicKey();
  const plain = JSON.stringify([['privkey', privkey], ...mints.map((m) => ['mint', m.replace(/\/+$/, '')])]);
  return { kind: 17375, created_at: now(), content: await signer.nip44Encrypt(me, plain), tags: [] };
}

/** Proofs as plain JSON with numeric amounts (cashu-ts 4 Amount objects would stringify as "21"). */
export function plainProofs(proofs: Proof[]): Record<string, unknown>[] {
  return serializeProofs(proofs).map((s) => JSON.parse(s));
}

export const proofsTotal = (proofs: Proof[]) => plainProofs(proofs).reduce((s, p) => s + Number(p.amount), 0);

/** Kind 7375 holding `proofs` from `mint`. */
export async function tokenTemplate(signer: Nip60Signer, mint: string, proofs: Proof[], unit = 'sat'): Promise<EventTemplate> {
  const me = await signer.getPublicKey();
  const plain = JSON.stringify({ mint: mint.replace(/\/+$/, ''), unit, proofs: plainProofs(proofs), del: [] });
  return { kind: 7375, created_at: now(), content: await signer.nip44Encrypt(me, plain), tags: [] };
}

/** Kind 7376 for one redeemed nutzap. The "redeemed" tags stay public on purpose (NIP-60/61). */
export async function redeemedTemplate(
  signer: Nip60Signer,
  z: { id: string; sender: string; amount: number },
  relay: string,
  createdToken?: string,
): Promise<EventTemplate> {
  const me = await signer.getPublicKey();
  const secret: string[][] = [['direction', 'in'], ['amount', String(z.amount)], ['unit', 'sat']];
  if (createdToken) secret.push(['e', createdToken, '', 'created']);
  return {
    kind: 7376,
    created_at: now(),
    content: await signer.nip44Encrypt(me, JSON.stringify(secret)),
    tags: [['e', z.id, relay, 'redeemed'], ['p', z.sender]],
  };
}

/** Ids of nutzaps (kind 9321) that `pubkey` marked redeemed in its kind 7376 history, from any wallet. */
export function redeemedIds(history: Event[], pubkey: string): Set<string> {
  const out = new Set<string>();
  for (const ev of history) {
    if (ev.kind !== 7376 || ev.pubkey !== pubkey) continue;
    for (const t of ev.tags) if (t[0] === 'e' && t[3] === 'redeemed' && /^[0-9a-f]{64}$/.test(t[1])) out.add(t[1]);
  }
  return out;
}

export async function fetchRedeemed(pubkey: string, relays: string[] = [], sinceDays = 60): Promise<Set<string>> {
  pool ??= new SimplePool();
  const evs = await pool.querySync(relaySet(relays), { kinds: [7376], authors: [pubkey], since: now() - sinceDays * 86400 }, { maxWait: 5000 });
  return redeemedIds(evs, pubkey);
}

/** Sign and publish; resolves with the event once at least one relay accepted it. */
export async function signAndPublish(signer: Nip60Signer, t: EventTemplate, relays: string[], timeoutMs = 8000): Promise<{ event: Event; relays: string[] }> {
  const event = await signer.signEvent(t);
  pool ??= new SimplePool();
  const rs = relaySet(relays);
  const res = await Promise.allSettled(
    pool.publish(rs, event).map((p, i) =>
      Promise.race([p.then(() => rs[i]), new Promise<string>((_, rej) => setTimeout(() => rej(new Error('timeout')), timeoutMs))]),
    ),
  );
  const ok = res.filter((r): r is PromiseFulfilledResult<string> => r.status === 'fulfilled').map((r) => r.value);
  if (!ok.length) throw new Error(`No relay accepted the kind ${t.kind} event.`);
  return { event, relays: ok };
}
