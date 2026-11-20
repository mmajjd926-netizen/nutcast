import { describe, expect, it } from 'vitest';
import { bolt11Msat, invoiceFor, lnAddressUrl } from '../src/core/lnurl';
import { boost, Streamer, type Payer } from '../src/core/stream';
import type { ValueBlock } from '../src/core/value';

const block: ValueBlock = {
  type: 'lightning',
  method: 'keysend',
  recipients: [
    { name: 'Host', kind: 'node', address: '02aa', split: 50, fee: false },
    { name: 'Cohost', kind: 'lnaddress', address: 'co@example.com', split: 30, fee: false },
    { name: 'Guest', kind: 'paymentrequest', address: 'creqAguest', split: 20, fee: false },
  ],
};

function fakePayer(fail = new Set<string>()) {
  const paid: Array<[string, number, string | undefined]> = [];
  const payer: Payer = {
    async payLnAddress(a, s, c) {
      if (fail.has(a)) throw new Error('route not found');
      paid.push([a, s, c]);
      return { fee: 1 };
    },
    async payRequest(r, s, m) {
      if (fail.has(r)) throw new Error('offline');
      paid.push([r, s, m]);
      return { fee: 0 };
    },
  };
  return { payer, paid };
}

describe('Streamer', () => {
  it('accrues by the split, drops unreachable shares, pays whole sats past thresholds', async () => {
    const st = new Streamer({ satsPerMinute: 10, budgetSats: 1000 });
    st.accrue(60, block); // 10 sats: 5 host (dropped), 3 cohost, 2 guest
    expect(st.droppedMsat).toBe(5000);
    expect(st.owedSats()).toBe(5);
    const { payer, paid } = fakePayer();
    await st.settle(payer);
    expect(paid).toEqual([['creqAguest', 2, undefined]]); // cohost waits for 21 sats
    for (let i = 0; i < 6; i++) st.accrue(60, block); // cohost now 21
    await st.settle(payer);
    expect(paid).toContainEqual(['co@example.com', 21, undefined]);
    expect(paid).toContainEqual(['creqAguest', 12, undefined]);
    expect(st.spentSats).toBe(2 + 12 + 21 + 1); // guest twice (2, then 12) + cohost + 1 fee
  });

  it('carries sub-sat remainders', async () => {
    const st = new Streamer({ satsPerMinute: 1, budgetSats: 100 });
    st.accrue(30, block); // 500 msat: guest gets 100 msat
    const { payer, paid } = fakePayer();
    await st.settle(payer, true);
    expect(paid).toEqual([]);
    for (let i = 0; i < 9; i++) st.accrue(30, block);
    await st.settle(payer);
    expect(paid).toEqual([['creqAguest', 1, undefined]]);
  });

  it('never accrues past the budget', () => {
    const st = new Streamer({ satsPerMinute: 100, budgetSats: 30 });
    st.accrue(600, block);
    expect(st.owedSats()).toBe(30); // host's half is dropped, not counted against the budget
    expect(st.droppedMsat).toBe(30000);
    expect(st.accrue(60, block)).toBe(0);
  });

  it('keeps what failed owed and reports it', async () => {
    const st = new Streamer({ satsPerMinute: 60, budgetSats: 1000 });
    st.accrue(60, block);
    const { payer } = fakePayer(new Set(['creqAguest']));
    const res = await st.settle(payer, true);
    const g = res.find((r) => r.address === 'creqAguest')!;
    expect(g.ok).toBe(false);
    expect(g.error).toBe('offline');
    expect(st.owedSats()).toBe(12);
  });
});

describe('boost', () => {
  it('splits and pays reachable recipients, lists the dropped ones', async () => {
    const { payer, paid } = fakePayer();
    const { results, dropped } = await boost(payer, block, 100, 'great show');
    expect(dropped.map((d) => d.name)).toEqual(['Host']);
    expect(paid).toEqual([
      ['co@example.com', 30, 'great show'],
      ['creqAguest', 20, 'great show'],
    ]);
    expect(results.every((r) => r.ok)).toBe(true);
  });
});

describe('lnurl', () => {
  it('builds the well-known URL', () => {
    expect(lnAddressUrl('Alice@Example.com')).toBe('https://example.com/.well-known/lnurlp/alice');
    expect(() => lnAddressUrl('nope')).toThrow();
  });
  it('reads bolt11 amounts', () => {
    expect(bolt11Msat('lnbc100n1p4sq722dqqpp5qy768t4ukdtympme7k6n46hyw7rpw6z0n909rh8zcjvtcy5t7j8q')).toBe(10000);
    expect(bolt11Msat('lnbc2500u1pvjluezpp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypq')).toBe(250000000);
    expect(bolt11Msat('lnbc1pvjluezpp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypq')).toBeUndefined();
  });
  it('asks for an invoice and checks its amount', async () => {
    const calls: string[] = [];
    const f = (async (u: string) => {
      calls.push(u);
      if (u.includes('.well-known')) return new Response(JSON.stringify({ tag: 'payRequest', callback: 'https://example.com/cb', minSendable: 1000, maxSendable: 1e9, commentAllowed: 5 }));
      const amt = new URL(u).searchParams.get('amount');
      return new Response(JSON.stringify({ pr: amt === '10000' ? 'lnbc100n1qqqq' : 'lnbc200n1qqqq' }));
    }) as unknown as typeof fetch;
    expect(await invoiceFor('a@example.com', 10, 'hello world', f)).toBe('lnbc100n1qqqq');
    expect(calls[1]).toBe('https://example.com/cb?amount=10000&comment=hello');
    await expect(invoiceFor('a@example.com', 11, undefined, f)).rejects.toThrow(/not 11/);
  });
});
