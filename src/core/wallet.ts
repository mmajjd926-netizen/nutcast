// A small ecash wallet for one mint, on top of cashu-ts. State (proofs, pending quotes)
// lives in a Store so the browser can keep it in localStorage and tests in memory.
import {
  Amount,
  MintQuoteState,
  Wallet,
  decodePaymentRequest,
  deserializeProofs,
  getTokenMetadata,
  getEncodedToken,
  serializeProofs,
  type Proof,
} from '@cashu/cashu-ts';

export interface Store {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

export class MemoryStore implements Store {
  private m = new Map<string, string>();
  get(k: string) {
    return this.m.get(k) ?? null;
  }
  set(k: string, v: string) {
    this.m.set(k, v);
  }
}

export const DEMO_MINT = 'https://testnut.cashu.space';

export interface TopUp {
  quote: string;
  invoice: string;
  amount: number;
}

export interface MeltResult {
  paid: boolean;
  amount: number;
  feePaid: number; // reserve spent minus change returned
}

const n = (a: unknown): number => (a instanceof Amount ? a.toNumber() : Number(a));

export class EcashWallet {
  readonly mintUrl: string;
  private wallet: Wallet;
  private store: Store;
  private ready?: Promise<void>;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(mintUrl: string, store: Store) {
    this.mintUrl = mintUrl.replace(/\/+$/, '');
    this.wallet = new Wallet(this.mintUrl);
    this.store = store;
  }

  private key(k: string) {
    return `nutcast:${this.mintUrl}:${k}`;
  }

  load(): Promise<void> {
    return (this.ready ??= this.wallet.loadMint());
  }

  /** Every operation that touches proofs runs one at a time, so two settlements never spend the same proof. */
  private exclusive<T>(f: () => Promise<T>): Promise<T> {
    const run = this.queue.then(f, f);
    this.queue = run.catch(() => undefined);
    return run;
  }

  proofs(): Proof[] {
    const raw = this.store.get(this.key('proofs'));
    return raw ? deserializeProofs(JSON.parse(raw)) : [];
  }

  private save(proofs: Proof[]) {
    this.store.set(this.key('proofs'), JSON.stringify(serializeProofs(proofs)));
  }

  balance(): number {
    return this.proofs().reduce((s, p) => s + n(p.amount), 0);
  }

  // ---- top up over Lightning (NUT-04) ----
  async createTopUp(amount: number): Promise<TopUp> {
    await this.load();
    const q = await this.wallet.createMintQuoteBolt11(amount, 'Nutcast top-up');
    const t = { quote: q.quote, invoice: q.request, amount };
    const pending: TopUp[] = JSON.parse(this.store.get(this.key('topups')) ?? '[]');
    pending.push(t);
    this.store.set(this.key('topups'), JSON.stringify(pending));
    return t;
  }

  pendingTopUps(): TopUp[] {
    return JSON.parse(this.store.get(this.key('topups')) ?? '[]');
  }

  /** Mint the ecash of a paid top-up. Returns the amount added, or 0 if the invoice is not paid yet. */
  claimTopUp(t: TopUp): Promise<number> {
    return this.exclusive(async () => {
      await this.load();
      const q = await this.wallet.checkMintQuoteBolt11(t.quote);
      if (q.state === MintQuoteState.ISSUED) {
        this.dropTopUp(t.quote);
        return 0;
      }
      if (q.state !== MintQuoteState.PAID) return 0;
      const fresh = await this.wallet.mintProofsBolt11(t.amount, q);
      this.save([...this.proofs(), ...fresh]);
      this.dropTopUp(t.quote);
      return fresh.reduce((s, p) => s + n(p.amount), 0);
    });
  }

  private dropTopUp(quote: string) {
    this.store.set(this.key('topups'), JSON.stringify(this.pendingTopUps().filter((x) => x.quote !== quote)));
  }

  // ---- tokens ----
  receive(token: string): Promise<number> {
    return this.exclusive(async () => {
      await this.load();
      const decoded = getTokenMetadata(token.trim());
      if (decoded.mint.replace(/\/+$/, '') !== this.mintUrl) throw new Error(`This token is from ${decoded.mint}, not from ${this.mintUrl}.`);
      const fresh = await this.wallet.receive(token.trim());
      this.save([...this.proofs(), ...fresh]);
      return fresh.reduce((s, p) => s + n(p.amount), 0);
    });
  }

  /** Make a token worth `amount` to hand to someone (a backup, a gift). */
  sendToken(amount: number, memo?: string): Promise<string> {
    return this.exclusive(async () => {
      await this.load();
      const { keep, send } = await this.wallet.send(amount, this.proofs(), { includeFees: true });
      this.save(keep);
      return getEncodedToken({ mint: this.mintUrl, proofs: send, memo });
    });
  }

  // ---- pay a bolt11 invoice (NUT-05) ----
  async meltQuote(invoice: string) {
    await this.load();
    const q = await this.wallet.createMeltQuoteBolt11(invoice);
    return { quote: q, amount: n(q.amount), feeReserve: n(q.fee_reserve) };
  }

  payInvoice(invoice: string): Promise<MeltResult> {
    return this.exclusive(async () => {
      const { quote, amount, feeReserve } = await this.meltQuote(invoice);
      if (amount + feeReserve > this.balance()) throw new Error(`Not enough ecash: needs ${amount + feeReserve} sats including the fee reserve.`);
      const before = this.balance();
      const { keep, send } = await this.wallet.send(amount + feeReserve, this.proofs(), { includeFees: true });
      // Keep what we did not send before paying: if the melt throws, the sent proofs are
      // restored below; if the app dies mid-way, the proofs in `send` are the only exposure.
      this.save(keep);
      try {
        const res = await this.wallet.meltProofsBolt11(quote, send);
        const change = res.change ?? [];
        this.save([...this.proofs(), ...change]);
        const paid = String(res.quote.state).toUpperCase() === 'PAID';
        if (!paid) throw new Error(`The mint did not pay the invoice (state ${res.quote.state}).`);
        // Everything the wallet lost beyond the invoice: Lightning fee, unreturned reserve, input fees of any swap.
        return { paid, amount, feePaid: before - this.balance() - amount };
      } catch (e) {
        // The proofs may be unspent if the mint refused before paying: check and take back those.
        try {
          const states = await this.wallet.checkProofsStates(send);
          const unspent = send.filter((_, i) => String(states[i]?.state).toUpperCase() === 'UNSPENT');
          if (unspent.length) this.save([...this.proofs(), ...unspent]);
        } catch {
          /* keep the original error */
        }
        throw e;
      }
    });
  }

  // ---- pay a NUT-18 payment request with ecash directly ----
  /** Builds the payment for a request and returns the payload; the caller delivers it over the request's transport. */
  payRequestPayload(request: string, amount: number, memo?: string): Promise<{ body: string; amount: number }> {
    return this.exclusive(async () => {
      await this.load();
      const pr = decodePaymentRequest(request);
      const { keep, send } = await this.wallet.ops.sendToRequest(pr, this.proofs(), pr.amount ? undefined : amount).run();
      this.save(keep);
      const body = pr.encodePayload(this.mintUrl, send, memo ? { memo } : undefined);
      return { body, amount: send.reduce((s, p) => s + n(p.amount), 0) };
    });
  }

  /** Put proofs back (for example when delivering a payment failed and the token was never seen by anyone). */
  restore(proofs: Proof[]) {
    this.save([...this.proofs(), ...proofs]);
  }
}
