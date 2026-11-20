// NUT-18 Nostr transport: deliver the payment payload as a NIP-17 private message
// (a gift-wrapped kind 14) to the payee's key, on the relays named in its nprofile.
import { SimplePool, generateSecretKey, nip17, nip19 } from 'nostr-tools';

export const FALLBACK_RELAYS = ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.primal.net'];

export function nostrTarget(target: string): { pubkey: string; relays: string[] } {
  const d = nip19.decode(target.replace(/^nostr:/, ''));
  if (d.type === 'nprofile') return { pubkey: d.data.pubkey, relays: d.data.relays?.length ? d.data.relays : FALLBACK_RELAYS };
  if (d.type === 'npub') return { pubkey: d.data, relays: FALLBACK_RELAYS };
  throw new Error('The Nostr target is neither an npub nor an nprofile.');
}

let pool: SimplePool | undefined;

/** Send `payload` privately to `target`; resolves once at least one relay accepted it. */
export async function sendNip17(target: string, payload: string, timeoutMs = 8000): Promise<string[]> {
  const { pubkey, relays } = nostrTarget(target);
  // A fresh key per payment: the payee learns nothing linking two payments to one listener.
  const sk = generateSecretKey();
  const wrap = nip17.wrapEvent(sk, { publicKey: pubkey }, payload);
  pool ??= new SimplePool();
  const results = await Promise.allSettled(
    pool.publish(relays, wrap).map((p, i) =>
      Promise.race([p.then(() => relays[i]), new Promise<string>((_, rej) => setTimeout(() => rej(new Error('timeout')), timeoutMs))]),
    ),
  );
  const ok = results.filter((r): r is PromiseFulfilledResult<string> => r.status === 'fulfilled').map((r) => r.value);
  if (!ok.length) throw new Error('No relay accepted the payment message.');
  return ok;
}
