// Boost from the listener's own wallet: Nutcast holds no money at all.
//
// For each recipient of the split, Nutcast prepares something any wallet can pay:
// - a Lightning address -> a bolt11 invoice for exactly that share (LUD-06, the message as LUD-12 comment);
// - a NUT-18 payment request -> the same request with the share filled in as its amount.
// The listener scans or opens each one in the wallet they already use. Nutcast never sees
// a token or a preimage, so it cannot confirm the payment: the wallet can.
import { Amount, decodePaymentRequest } from '@cashu/cashu-ts';
import { invoiceFor } from './lnurl';
import { payable, splitAmount, type ValueBlock } from './value';

type Fetch = typeof fetch;

export interface Handoff {
  name: string;
  kind: 'lnaddress' | 'paymentrequest';
  address: string;
  sats: number;
  /** What the QR code carries: a bolt11 invoice or a creqA request. */
  code?: string;
  /** A link that opens a wallet: lightning:… or cashu:… */
  uri?: string;
  error?: string;
}

/** A NUT-18 request with its amount set (sat unit), ready for any Cashu wallet. */
export function requestWithAmount(creq: string, sats: number): string {
  const pr = decodePaymentRequest(creq);
  if (pr.unit && pr.unit !== 'sat') throw new Error(`the request asks for ${pr.unit}, not sat`);
  pr.unit = 'sat';
  pr.amount = Amount.from(sats);
  return pr.toEncodedCreqA();
}

export async function handoffBoost(block: ValueBlock, sats: number, message?: string, f: Fetch = fetch): Promise<{ items: Handoff[]; skipped: string[] }> {
  const parts = splitAmount(sats, block.recipients);
  const items: Handoff[] = [];
  const skipped: string[] = [];
  await Promise.all(
    block.recipients.map(async (r, i) => {
      if (!payable(r)) return void skipped.push(r.name);
      if (parts[i] < 1) return;
      const h: Handoff = { name: r.name, kind: r.kind as Handoff['kind'], address: r.address, sats: parts[i] };
      items[i] = h;
      try {
        if (r.kind === 'lnaddress') {
          h.code = await invoiceFor(r.address, parts[i], message, f);
          h.uri = 'lightning:' + h.code;
        } else {
          h.code = requestWithAmount(r.address, parts[i]);
          h.uri = 'cashu:' + h.code;
        }
      } catch (e) {
        h.error = e instanceof Error ? e.message : String(e);
      }
    }),
  );
  return { items: items.filter(Boolean), skipped };
}
