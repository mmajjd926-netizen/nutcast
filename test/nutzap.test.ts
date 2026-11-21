import { describe, expect, it } from 'vitest';
import { Wallet, getEncodedToken } from '@cashu/cashu-ts';
import { generateSecretKey, getPublicKey, verifyEvent } from 'nostr-tools';
import { lockKey, npubHex, nutzapEvent, parseNutzapInfo, sameMint } from '../src/core/nutzap';
import { parseFeed } from '../src/core/value';
import { DEMO_MINT, EcashWallet, MemoryStore } from '../src/core/wallet';

const NODESIGNAL_10019 = {
  kind: 10019,
  pubkey: '9bdb965a3757e233699b5aabd8fc55bc0c1f48e39c4d5acac6d37b2f48f2161e',
  tags: [
    ['relay', 'wss://relay.nostr.pub'],
    ['relay', 'wss://nos.lol'],
    ['mint', 'https://mint.macadamia.cash'],
    ['mint', 'https://mint.minibits.cash/Bitcoin/'],
    ['pubkey', '03e88b8f45f71c053bbd11bd43f3c8fb62b726db89f4298977c8e0422e5a728379'],
  ],
};

describe('nutzaps (NIP-61)', () => {
  it('reads kind 10019 and locks to its key, not to the Nostr key', () => {
    const info = parseNutzapInfo(NODESIGNAL_10019);
    expect(info.p2pk).toBe('03e88b8f45f71c053bbd11bd43f3c8fb62b726db89f4298977c8e0422e5a728379');
    expect(info.p2pk.slice(2)).not.toBe(info.pubkey);
    expect(info.mints).toEqual(['https://mint.macadamia.cash', 'https://mint.minibits.cash/Bitcoin']);
    expect(info.relays).toEqual(['wss://relay.nostr.pub', 'wss://nos.lol']);
    expect(sameMint('https://mint.minibits.cash/Bitcoin/', 'https://mint.minibits.cash/bitcoin')).toBe(true);
  });

  it('pads an x-only key with 02 and refuses junk', () => {
    expect(lockKey('a'.repeat(64))).toBe('02' + 'a'.repeat(64));
    expect(() => lockKey('04' + 'a'.repeat(64))).toThrow();
    expect(() => parseNutzapInfo({ ...NODESIGNAL_10019, tags: NODESIGNAL_10019.tags.filter((t) => t[0] !== 'mint') })).toThrow(/no mints/);
  });

  it('finds the show npub in the feed', () => {
    const xml = `<rss xmlns:podcast="https://podcastindex.org/namespace/1.0"><channel><title>T</title>
      <podcast:txt purpose="sovereigncast">https://pm.example</podcast:txt>
      <podcast:txt purpose="nostr">npub1n0devk3h2l3rx6vmt24a3lz4hsxp7j8rn3x44jkx6daj7j8jzc0q2u02cy</podcast:txt></channel></rss>`;
    const feed = parseFeed(xml);
    expect(npubHex(feed.nostr)).toBe(NODESIGNAL_10019.pubkey);
    expect(npubHex('not a key')).toBeUndefined();
  });

  it('builds a signed kind 9321 with one proof tag per proof, the mint and the recipient', () => {
    const info = parseNutzapInfo(NODESIGNAL_10019);
    const proofs = [{ id: '00ab', amount: 8, secret: 's1', C: '02cc', dleq: { e: 'e', s: 's', r: 'r' } }, { id: '00ab', amount: 2, secret: 's2', C: '02dd' }];
    const ev = nutzapEvent(info, 'https://mint.minibits.cash/Bitcoin', proofs as never, 'Great episode');
    expect(ev.kind).toBe(9321);
    expect(verifyEvent(ev)).toBe(true);
    expect(ev.content).toBe('Great episode');
    expect(ev.tags.filter((t) => t[0] === 'proof').map((t) => JSON.parse(t[1]).amount)).toEqual([8, 2]);
    expect(JSON.parse(ev.tags[0][1]).dleq).toEqual({ e: 'e', s: 's', r: 'r' });
    expect(ev.tags).toContainEqual(['u', 'https://mint.minibits.cash/Bitcoin']);
    expect(ev.tags).toContainEqual(['p', info.pubkey]);
  });
});

const live = process.env.NUTCAST_LIVE ? describe : describe.skip;
live('nutzap on testnut', () => {
  it('locks proofs to the recipient key; only that key redeems them', async () => {
    const a = new EcashWallet(DEMO_MINT, new MemoryStore());
    const t = await a.createTopUp(50);
    for (let i = 0; i < 20 && !(await a.claimTopUp(t)); i++) await new Promise((r) => setTimeout(r, 500));
    const sk = generateSecretKey();
    const p2pk = lockKey(getPublicKey(sk)); // x-only -> 02…, as a 10019 may publish it
    const proofs = await a.sendLocked(21, p2pk);
    expect(proofs.reduce((s, p) => s + Number(p.amount), 0)).toBeGreaterThanOrEqual(21);
    expect(JSON.parse(proofs[0].secret)[0]).toBe('P2PK');
    expect(JSON.parse(proofs[0].secret)[1].data).toBe(p2pk);
    expect(proofs.every((p) => p.dleq)).toBe(true);
    const token = getEncodedToken({ mint: DEMO_MINT, proofs });
    const w = new Wallet(DEMO_MINT);
    await w.loadMint();
    await expect(w.receive(token)).rejects.toThrow(); // no key, no money
    const got = await w.ops.receive(token).privkey(Buffer.from(sk).toString('hex')).run();
    expect(got.reduce((s, p) => s + Number(p.amount), 0)).toBeGreaterThan(0);
  });
});
