// Interop with applesauce-wallet (hzrd149's NIP-60/61 library, used by noStrudel): each side reads the other's events.
// Offline: events are built and signed locally, nothing is published.
import { describe, expect, it } from 'vitest';
import { Amount } from '@cashu/cashu-ts';
import { generateSecretKey, getPublicKey, type Event } from 'nostr-tools';
import { PrivateKeySigner } from 'applesauce-signers';
import { WalletFactory, WalletHistoryFactory, WalletTokenFactory, NutzapFactory, NutzapInfoFactory } from 'applesauce-wallet/factories';
import {
  unlockWallet,
  unlockTokenContent,
  isValidWalletToken,
  isNutzapRedeemed,
  getHistoryRedeemed,
  getNutzapP2PKPubkey,
  getNutzapInfoP2PKPubkey,
  getNutzapInfoMints,
  isValidNutzap,
  getNutzapAmount,
  getNutzapMint,
  findMatchingPrivateKeyForNutzap,
} from 'applesauce-wallet/helpers';
import { localSigner } from '../src/core/inbox';
import { parseWalletContent, redeemedIds, redeemedTemplate, tokenTemplate, walletTemplate } from '../src/core/nip60';
import { newNutzapKey, nutzapEvent, nutzapInfoTemplate, nutzapPub, parseNutzap, parseNutzapInfo } from '../src/core/nutzap';

const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
const bytes = (h: string) => Uint8Array.from(h.match(/../g)!.map((x) => parseInt(x, 16)));
const MINT = 'https://mint.minibits.cash/Bitcoin';

function setup() {
  const sk = generateSecretKey();
  const ours = localSigner(hex(sk)); // the podcaster in Nutcast
  const theirs = new PrivateKeySigner(sk); // the same person in an applesauce wallet
  return { sk, pk: getPublicKey(sk), ours, theirs };
}
const sign = (ours: ReturnType<typeof localSigner>, t: Parameters<typeof ours.signEvent>[0]) => ours.signEvent(t);

// a P2PK-locked proof as a nutzap would carry (the signature C is not checked by either side here)
const lockedProof = (pub: string, amount: number) => ({
  id: '00ad268c4d1f5826',
  amount,
  secret: JSON.stringify(['P2PK', { nonce: hex(generateSecretKey()), data: pub, tags: [['sigflag', 'SIG_INPUTS']] }]),
  C: '02' + hex(generateSecretKey()),
});

describe('NIP-60 with applesauce-wallet', () => {
  it('Nutcast uses the nutzap key of a wallet applesauce made (kind 17375)', async () => {
    const { ours, theirs } = setup();
    const walletKey = generateSecretKey();
    const ev = (await WalletFactory.create([MINT, 'https://mint.macadamia.cash'], walletKey, ['wss://nos.lol']).sign(theirs)) as Event;
    const plain = await ours.nip44Decrypt(ev.pubkey, ev.content);
    const w = parseWalletContent(plain);
    expect(w.privkey).toBe(hex(walletKey));
    expect(w.mints).toEqual([MINT, 'https://mint.macadamia.cash']);
  });

  it('applesauce unlocks the wallet Nutcast saves', async () => {
    const { ours, theirs } = setup();
    const k = newNutzapKey();
    const ev = await sign(ours, await walletTemplate(ours, k.sk, [MINT + '/']));
    const w = await unlockWallet(ev, theirs);
    expect(hex(w.privateKey!)).toBe(k.sk);
    expect(w.mints).toEqual([MINT]);
  });

  it('applesauce reads the token event Nutcast keeps redeemed nutzaps in (kind 7375), and back', async () => {
    const { ours, theirs } = setup();
    const proofs = [{ id: '00ad268c4d1f5826', amount: 16, secret: 'a'.repeat(64), C: '02' + 'b'.repeat(64) }, { id: '00ad268c4d1f5826', amount: 4, secret: 'c'.repeat(64), C: '03' + 'd'.repeat(64) }];
    const ev = await sign(ours, await tokenTemplate(ours, MINT, proofs as never));
    expect(isValidWalletToken(ev)).toBe(true);
    const t = await unlockTokenContent(ev, theirs);
    expect(t.mint).toBe(MINT);
    expect(t.proofs.map((p) => [p.amount, p.secret])).toEqual(proofs.map((p) => [p.amount, p.secret]));
    // proofs straight from cashu-ts 4 carry Amount objects; the event must still hold numbers
    const fromMint = await sign(ours, await tokenTemplate(ours, MINT, [{ ...proofs[0], amount: Amount.from(16) }] as never));
    const raw = JSON.parse(await ours.nip44Decrypt(fromMint.pubkey, fromMint.content));
    expect(raw.proofs[0].amount).toBe(16);
    // the other way: an applesauce token event decrypts to the same shape Nutcast writes
    const back = (await WalletTokenFactory.create({ mint: MINT, proofs }).sign(theirs)) as Event;
    const plain = JSON.parse(await ours.nip44Decrypt(back.pubkey, back.content));
    expect(plain.mint).toBe(MINT);
    expect(plain.proofs.length).toBe(2);
  });

  it('a nutzap Nutcast marks redeemed (kind 7376) is redeemed for applesauce, and back', async () => {
    const { ours, theirs, pk } = setup();
    const zapId = hex(generateSecretKey());
    const sender = getPublicKey(generateSecretKey());
    const ev = await sign(ours, await redeemedTemplate(ours, { id: zapId, sender, amount: 21 }, 'wss://nos.lol'));
    expect(isNutzapRedeemed(zapId, [ev])).toBe(true);
    expect(getHistoryRedeemed(ev)).toEqual([zapId]);
    const other = hex(generateSecretKey());
    const theirsEv = (await WalletHistoryFactory.create({ direction: 'in', amount: 42, mint: MINT, created: [] }).redeemed([other]).sign(theirs)) as Event;
    expect(redeemedIds([theirsEv, ev], pk)).toEqual(new Set([other, zapId]));
  });

  it('kind 10019 and kind 9321 read the same both ways', async () => {
    const { ours, theirs, pk } = setup();
    const k = newNutzapKey();
    // Nutcast's 10019 -> applesauce
    const info = await sign(ours, nutzapInfoTemplate(k.pub, [MINT], ['wss://nos.lol']));
    expect(getNutzapInfoP2PKPubkey(info)).toBe(k.pub);
    expect(getNutzapInfoMints(info).map((m) => m.mint)).toEqual([MINT]);
    // applesauce's 10019 -> Nutcast
    const theirInfo = (await NutzapInfoFactory.create().setMints([{ url: MINT, units: ['sat'] }]).setRelays(['wss://nos.lol']).setPubkey(bytes(k.sk)).sign(theirs)) as Event;
    const parsed = parseNutzapInfo(theirInfo);
    expect(parsed.p2pk).toBe(nutzapPub(k.sk));
    expect(parsed.mints).toEqual([MINT]);
    // Nutcast's nutzap -> applesauce: it finds the lock key among the wallet's keys
    const proofs = [lockedProof(k.pub, 16), lockedProof(k.pub, 4)];
    const zap = nutzapEvent(parsed, MINT, proofs as never, 'great show');
    expect(isValidNutzap(zap)).toBe(true);
    expect(getNutzapAmount(zap)).toBe(20);
    expect(getNutzapMint(zap)).toBe(MINT);
    expect(getNutzapP2PKPubkey(zap)).toBe(k.pub);
    expect(hex(findMatchingPrivateKeyForNutzap(zap, [generateSecretKey(), bytes(k.sk)])!)).toBe(k.sk);
    // applesauce's nutzap -> Nutcast
    const theirZap = (await NutzapFactory.forProfile({ pubkey: pk, relays: [] }, { mint: MINT, proofs: proofs as never, unit: 'sat' }, 'from applesauce').sign(new PrivateKeySigner())) as Event;
    const z = parseNutzap(theirZap);
    expect(z.amount).toBe(20);
    expect(z.mint).toBe(MINT);
    expect(z.lockedTo).toEqual([k.pub]);
    expect(z.comment).toBe('from applesauce');
  });
});
