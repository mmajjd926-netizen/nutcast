import { describe, expect, it } from 'vitest';
import { PaymentRequest, PaymentRequestTransportType, decodePaymentRequest } from '@cashu/cashu-ts';
import { handoffBoost, requestWithAmount } from '../src/core/handoff';
import type { ValueBlock } from '../src/core/value';

const creq = new PaymentRequest([{ type: PaymentRequestTransportType.NOSTR, target: 'nprofile1qqsexample', tags: [['n', '17']] }], 'abc', undefined, 'sat', ['https://mint.example'], 'Value4Value', false).toEncodedCreqA();

describe('wallet handoff', () => {
  it('fills the amount into a NUT-18 request and keeps the rest', () => {
    const pr = decodePaymentRequest(requestWithAmount(creq, 42));
    expect(Number(pr.amount)).toBe(42);
    expect(pr.unit).toBe('sat');
    expect(pr.id).toBe('abc');
    expect(pr.mints).toEqual(['https://mint.example']);
    expect(pr.getTransport(PaymentRequestTransportType.NOSTR)?.target).toBe('nprofile1qqsexample');
  });

  it('prepares one payable item per recipient, split like a boost', async () => {
    const block: ValueBlock = {
      type: 'lightning', method: 'lnaddress', recipients: [
        { name: 'Host', kind: 'lnaddress', address: 'host@example.com', split: 80, fee: false },
        { name: 'Cashu guest', kind: 'paymentrequest', address: creq, split: 15, fee: false },
        { name: 'Node', kind: 'node', address: '02ab', split: 5, fee: false },
      ],
    } as unknown as ValueBlock;
    const f = (async (u: string) => ({
      ok: true, status: 200,
      json: async () => (u.includes('/.well-known/') ? { tag: 'payRequest', callback: 'https://example.com/cb', minSendable: 1000, maxSendable: 1e9, commentAllowed: 100 } : { pr: 'lnbc800n1qqqq' }),
    })) as unknown as typeof fetch;
    const { items, skipped } = await handoffBoost(block, 100, 'hi', f);
    expect(skipped).toEqual(['Node']);
    expect(items.map((i) => [i.name, i.sats])).toEqual([['Host', 80], ['Cashu guest', 15]]);
    expect(items[0].uri).toBe('lightning:lnbc800n1qqqq');
    expect(Number(decodePaymentRequest(items[1].code!).amount)).toBe(15);
    expect(items[1].uri!.startsWith('cashu:creqA')).toBe(true);
  });
});
