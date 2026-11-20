// Live test against the public test mint (fake Lightning: every invoice counts as paid).
// Run: NUTCAST_LIVE=1 npx vitest run test/wallet.live.test.ts
import { describe, expect, it } from 'vitest';
import { DEMO_MINT, EcashWallet, MemoryStore, type TopUp } from '../src/core/wallet';

async function claim(w: EcashWallet, t: TopUp): Promise<number> {
  for (let i = 0; i < 20; i++) {
    const got = await w.claimTopUp(t);
    if (got) return got;
    await new Promise((r) => setTimeout(r, 500));
  }
  return 0;
}

const live = process.env.NUTCAST_LIVE ? describe : describe.skip;

live('EcashWallet on testnut', () => {
  it('tops up, sends, receives and pays an invoice', async () => {
    const a = new EcashWallet(DEMO_MINT, new MemoryStore());
    const b = new EcashWallet(DEMO_MINT, new MemoryStore());
    const t = await a.createTopUp(100);
    expect(t.invoice).toMatch(/^ln/);
    expect(a.pendingTopUps()).toHaveLength(1);
    expect(await claim(a, t)).toBe(100);
    expect(a.balance()).toBe(100);
    expect(a.pendingTopUps()).toHaveLength(0);

    const token = await a.sendToken(30, 'thanks');
    expect(token).toMatch(/^cashu/);
    const got = await b.receive(token);
    expect(got).toBeGreaterThan(0);
    expect(got).toBeLessThanOrEqual(30);
    expect(a.balance()).toBeLessThanOrEqual(70);

    // An invoice from the same fake mint: melting pays it internally.
    const other = await b.createTopUp(10);
    const before = a.balance();
    const res = await a.payInvoice(other.invoice);
    expect(res.paid).toBe(true);
    expect(res.amount).toBe(10);
    expect(a.balance()).toBe(before - 10 - res.feePaid);
  });
});
