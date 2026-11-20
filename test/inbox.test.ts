import { describe, expect, it } from 'vitest';
import { generateSecretKey, getPublicKey, nip17 } from 'nostr-tools';
import { localSigner, newLocalKey, openWrap } from '../src/core/inbox';

const proofs = [
  { id: '009a1f293253e41e', amount: 16, secret: 's1', C: '02' + 'a'.repeat(64) },
  { id: '009a1f293253e41e', amount: 4, secret: 's2', C: '02' + 'b'.repeat(64) },
];

describe('inbox', () => {
  const skHex = newLocalKey();
  const signer = localSigner(skHex);

  it('opens a NUT-18 payment sent as a NIP-17 message', async () => {
    const pk = await signer.getPublicKey();
    const payer = generateSecretKey();
    const payload = JSON.stringify({ id: 'r1', memo: 'great show', mint: 'https://testnut.cashu.space/', unit: 'sat', proofs });
    const wrap = nip17.wrapEvent(payer, { publicKey: pk }, payload);
    const got = await openWrap(signer, wrap);
    expect(got.amount).toBe(20);
    expect(got.memo).toBe('great show');
    expect(got.mint).toBe('https://testnut.cashu.space');
    expect(got.sender).toBe(getPublicKey(payer));
    expect(got.token).toMatch(/^cashuB/);
  });

  it('skips chat messages and wraps for someone else', async () => {
    const pk = await signer.getPublicKey();
    const chat = nip17.wrapEvent(generateSecretKey(), { publicKey: pk }, 'hello there');
    await expect(openWrap(signer, chat)).rejects.toThrow();
    const other = nip17.wrapEvent(generateSecretKey(), { publicKey: getPublicKey(generateSecretKey()) }, JSON.stringify({ mint: 'https://m', proofs }));
    await expect(openWrap(signer, other)).rejects.toThrow();
  });
});
