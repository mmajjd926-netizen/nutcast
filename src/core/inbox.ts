// The receiving side of NUT-18 over Nostr: find NIP-17 gift wraps addressed to the podcaster,
// open them (wrap -> seal -> rumor) and read the ecash payment inside.
// Decryption goes through a Signer, so the key can stay in a NIP-07 extension.
import { getEncodedToken, type Proof } from '@cashu/cashu-ts';
import { SimplePool, finalizeEvent, generateSecretKey, getPublicKey, nip44, verifyEvent, type Event, type EventTemplate } from 'nostr-tools';
import { FALLBACK_RELAYS } from './nostr';

export interface Signer {
  getPublicKey(): Promise<string>;
  nip44Decrypt(peer: string, ciphertext: string): Promise<string>;
  /** Used for NIP-60 events (encrypted to yourself). */
  nip44Encrypt(peer: string, plaintext: string): Promise<string>;
  signEvent(template: EventTemplate): Promise<Event>;
}

/** A key kept by the page itself (hex secret). */
export function localSigner(skHex: string): Signer {
  const sk = Uint8Array.from(skHex.match(/../g)!.map((h) => parseInt(h, 16)));
  return {
    getPublicKey: async () => getPublicKey(sk),
    nip44Decrypt: async (peer, ct) => nip44.v2.decrypt(ct, nip44.v2.utils.getConversationKey(sk, peer)),
    nip44Encrypt: async (peer, pt) => nip44.v2.encrypt(pt, nip44.v2.utils.getConversationKey(sk, peer)),
    signEvent: async (t) => finalizeEvent(t, sk),
  };
}

export function newLocalKey(): string {
  return [...generateSecretKey()].map((b) => b.toString(16).padStart(2, '0')).join('');
}

interface Nip07 {
  getPublicKey(): Promise<string>;
  nip44?: { decrypt(peer: string, ciphertext: string): Promise<string>; encrypt?(peer: string, plaintext: string): Promise<string> };
  signEvent?(t: EventTemplate): Promise<Event>;
}

/** A NIP-07 browser extension (Alby, nos2x, …). It must support nip44. */
export function extensionSigner(ext: Nip07 | undefined): Signer {
  if (!ext) throw new Error('No Nostr extension found in this browser.');
  if (!ext.nip44) throw new Error('Your Nostr extension cannot decrypt NIP-44 messages.');
  return {
    getPublicKey: () => ext.getPublicKey(),
    nip44Decrypt: (p, c) => ext.nip44!.decrypt(p, c),
    nip44Encrypt: async (p, t) => {
      if (!ext.nip44?.encrypt) throw new Error('Your Nostr extension cannot encrypt NIP-44 messages.');
      return ext.nip44.encrypt(p, t);
    },
    signEvent: async (t) => {
      if (!ext.signEvent) throw new Error('Your Nostr extension cannot sign events.');
      return ext.signEvent(t);
    },
  };
}

export interface IncomingPayment {
  wrapId: string;
  at: number; // seconds, from the rumor (the wrap's own time is randomised)
  sender: string; // the payer's per-payment key
  mint: string;
  unit: string;
  memo?: string;
  amount: number;
  proofs: Proof[];
  token: string; // cashuB… ready to receive
}

/** Open one gift wrap. Throws if it is not a valid NIP-17 message carrying a NUT-18 payload. */
export async function openWrap(signer: Signer, wrap: Event): Promise<IncomingPayment> {
  if (wrap.kind !== 1059) throw new Error('not a gift wrap');
  const seal = JSON.parse(await signer.nip44Decrypt(wrap.pubkey, wrap.content)) as Event;
  if (seal.kind !== 13 || !verifyEvent(seal)) throw new Error('bad seal');
  const rumor = JSON.parse(await signer.nip44Decrypt(seal.pubkey, seal.content));
  if (rumor.kind !== 14 || rumor.pubkey !== seal.pubkey) throw new Error('bad rumor');
  const p = JSON.parse(rumor.content);
  if (!p || typeof p.mint !== 'string' || !Array.isArray(p.proofs) || !p.proofs.length) throw new Error('not an ecash payment');
  const unit = typeof p.unit === 'string' ? p.unit : 'sat';
  const memo = typeof p.memo === 'string' ? p.memo : undefined;
  const proofs = p.proofs as Proof[];
  return {
    wrapId: wrap.id,
    at: Number(rumor.created_at) || wrap.created_at,
    sender: seal.pubkey,
    mint: p.mint.replace(/\/+$/, ''),
    unit,
    memo,
    amount: proofs.reduce((s, x) => s + Number(x.amount), 0),
    proofs,
    token: getEncodedToken({ mint: p.mint, proofs, unit, memo }),
  };
}

/** Fetch gift wraps for the signer's key from `relays` and open those that are ecash payments. */
export async function fetchPayments(signer: Signer, relays: string[] = FALLBACK_RELAYS, sinceDays = 14): Promise<IncomingPayment[]> {
  const pk = await signer.getPublicKey();
  const pool = new SimplePool();
  try {
    // NIP-59 randomises the wrap's created_at up to two days into the past, so look back a little further.
    const since = Math.floor(Date.now() / 1000) - (sinceDays + 2) * 86400;
    const events = await pool.querySync(relays, { kinds: [1059], '#p': [pk], since }, { maxWait: 6000 });
    const seen = new Set<string>();
    const out: IncomingPayment[] = [];
    for (const e of events) {
      if (seen.has(e.id)) continue;
      seen.add(e.id);
      try {
        out.push(await openWrap(signer, e));
      } catch {
        /* someone else's chat message, or junk: skip */
      }
    }
    return out.sort((a, b) => b.at - a.at);
  } finally {
    pool.close(relays);
  }
}
