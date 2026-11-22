// Streaming sats: accrue per listened second, settle in whole sats.
//
// Rules (borrowed from how good Podcasting 2.0 apps behave, e.g. Hopp's ADR 0005/0014):
// - accrue only while audio actually plays, at the listener's rate (sats per minute);
// - split each accrual to the millisat by the podcaster's value split;
// - a share no ecash route can reach (a keysend node) is dropped, never redistributed;
// - pay whole sats per recipient and carry the rest;
// - lnaddress recipients are paid through a mint melt, which costs a fee reserve, so they are
//   batched until a threshold; NUT-18 recipients get ecash directly and can be paid every minute;
// - never spend past the session budget.
import { payable, splitAmount, type ValueBlock, type ValueRecipient } from './value';

export interface Payer {
  /** Pay `sats` to a Lightning address; returns the fee the wallet paid on top. */
  payLnAddress(address: string, sats: number, comment?: string): Promise<{ fee: number }>;
  /** Pay `sats` of ecash to a NUT-18 payment request. */
  payRequest(request: string, sats: number, memo?: string): Promise<{ fee: number }>;
  /** Nutzap `sats` to a Nostr pubkey (NIP-61). Optional: a payer without it cannot reach nutzap recipients. */
  payNutzap?(pubkey: string, sats: number, comment?: string): Promise<{ fee: number }>;
}

export interface Settlement {
  at: number;
  recipient: string;
  address: string;
  sats: number;
  fee: number;
  ok: boolean;
  error?: string;
  kind: 'stream' | 'boost';
}

export interface StreamOptions {
  satsPerMinute: number;
  budgetSats: number;
  lnThresholdSats?: number; // default 21
  requestThresholdSats?: number; // default 1
  nutzapThresholdSats?: number; // default 10: each nutzap is a public Nostr event, so batch a little
}

const keyOf = (r: ValueRecipient) => `${r.kind}:${r.address}`;

export class Streamer {
  opts: Required<StreamOptions>;
  private owedMsat = new Map<string, number>();
  private recipients = new Map<string, ValueRecipient>();
  spentSats = 0; // paid out, including fees
  droppedMsat = 0; // shares nobody can be paid with ecash
  history: Settlement[] = [];
  private settling?: Promise<Settlement[]>;

  constructor(opts: StreamOptions) {
    this.opts = { lnThresholdSats: 21, requestThresholdSats: 1, nutzapThresholdSats: 10, ...opts };
  }

  /** Sats accrued and not yet paid. */
  owedSats(): number {
    let s = 0;
    for (const v of this.owedMsat.values()) s += v;
    return s / 1000;
  }

  /** What is left of the budget once everything owed is paid. */
  remainingSats(): number {
    return Math.max(0, this.opts.budgetSats - this.spentSats - this.owedSats());
  }

  /** Accrue for `seconds` of listening under `block`. Returns the msats accrued (after the budget cap). */
  accrue(seconds: number, block: ValueBlock): number {
    if (seconds <= 0 || this.opts.satsPerMinute <= 0) return 0;
    let msat = Math.floor((this.opts.satsPerMinute * 1000 * seconds) / 60);
    const room = Math.floor(this.remainingSats() * 1000);
    if (msat <= 0 || room <= 0) return 0;
    let parts = splitAmount(msat, block.recipients);
    // The budget caps what is really paid: shares nobody can be paid are not spending.
    const reach = parts.reduce((s, p, i) => s + (payable(block.recipients[i]) ? p : 0), 0);
    if (reach === 0) return 0;
    if (reach > room) {
      msat = Math.floor((msat * room) / reach);
      parts = splitAmount(msat, block.recipients);
      // rounding may still overshoot by a millisat or two: trim from the largest payable share
      let over = parts.reduce((s, p, i) => s + (payable(block.recipients[i]) ? p : 0), 0) - room;
      while (over > 0) {
        let j = -1;
        parts.forEach((p, i) => { if (payable(block.recipients[i]) && (j < 0 || p > parts[j])) j = i; });
        parts[j]--; msat--; over--;
      }
    }
    block.recipients.forEach((r, i) => {
      if (!payable(r)) {
        this.droppedMsat += parts[i];
        return;
      }
      const k = keyOf(r);
      this.recipients.set(k, r);
      this.owedMsat.set(k, (this.owedMsat.get(k) ?? 0) + parts[i]);
    });
    return msat;
  }

  /** Pay every recipient whose whole sats reached its threshold (or everyone, with `flush`). One settle at a time. */
  settle(payer: Payer, flush = false, comment?: string): Promise<Settlement[]> {
    return (this.settling ??= this.doSettle(payer, flush, comment).finally(() => (this.settling = undefined)));
  }

  private async doSettle(payer: Payer, flush: boolean, comment?: string): Promise<Settlement[]> {
    const out: Settlement[] = [];
    for (const [k, msat] of this.owedMsat) {
      const r = this.recipients.get(k)!;
      const sats = Math.floor(msat / 1000);
      const threshold = r.kind === 'lnaddress' ? this.opts.lnThresholdSats : r.kind === 'nutzap' ? this.opts.nutzapThresholdSats : this.opts.requestThresholdSats;
      if (sats < 1 || (!flush && sats < threshold)) continue;
      const s: Settlement = { at: Date.now(), recipient: r.name, address: r.address, sats, fee: 0, ok: false, kind: 'stream' };
      try {
        const { fee } = await payOne(payer, r, sats, comment);
        s.ok = true;
        s.fee = fee;
        this.owedMsat.set(k, (this.owedMsat.get(k) ?? 0) - sats * 1000);
        this.spentSats += sats + fee;
      } catch (e) {
        s.error = e instanceof Error ? e.message : String(e);
      }
      out.push(s);
      this.history.push(s);
    }
    return out;
  }
}

function payOne(payer: Payer, r: ValueRecipient, sats: number, comment?: string): Promise<{ fee: number }> {
  if (r.kind === 'lnaddress') return payer.payLnAddress(r.address, sats, comment);
  if (r.kind === 'nutzap') {
    if (!payer.payNutzap) return Promise.reject(new Error('This wallet cannot send nutzaps.'));
    return payer.payNutzap(r.address, sats, comment);
  }
  return payer.payRequest(r.address, sats, comment);
}

/** A one-off boost: split `sats` by the block and pay each reachable recipient now. */
export async function boost(payer: Payer, block: ValueBlock, sats: number, message?: string): Promise<{ results: Settlement[]; dropped: ValueRecipient[] }> {
  const parts = splitAmount(sats, block.recipients);
  const results: Settlement[] = [];
  const dropped: ValueRecipient[] = [];
  for (let i = 0; i < block.recipients.length; i++) {
    const r = block.recipients[i];
    if (!payable(r)) {
      dropped.push(r);
      continue;
    }
    if (parts[i] < 1) continue;
    const s: Settlement = { at: Date.now(), recipient: r.name, address: r.address, sats: parts[i], fee: 0, ok: false, kind: 'boost' };
    try {
      const { fee } = await payOne(payer, r, parts[i], message);
      s.ok = true;
      s.fee = fee;
    } catch (e) {
      s.error = e instanceof Error ? e.message : String(e);
    }
    results.push(s);
  }
  return { results, dropped };
}
