import { describe, expect, it } from 'vitest';
import { chooseBlock, parseFeed, payable, splitAmount, type ValueRecipient } from '../src/core/value';

const FEED = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:podcast="https://podcastindex.org/namespace/1.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">
<channel>
  <title>Nut Radio</title>
  <itunes:author>Squirrel</itunes:author>
  <image><url>https://example.com/cover.png</url></image>
  <podcast:value type="lightning" method="keysend" suggested="0.00000005000">
    <podcast:valueRecipient name="Host" type="node" address="02d5c1bf8b940dc9cadca86d1b0a3c37fbe39cee4c7e839e33bef9174531d27f52" split="60"/>
    <podcast:valueRecipient name="Cohost" type="lnaddress" address="cohost@example.com" split="40"/>
    <podcast:valueRecipient name="App" type="node" address="03ae9f91a0cb8ff43840e3c322c4c61f019d8c1c3cea15a25cfc425ac605e61a4a" split="1" fee="true"/>
  </podcast:value>
  <podcast:value type="cashu" method="nut18">
    <podcast:valueRecipient name="Host" type="paymentrequest" address="creqAexample" split="100"/>
  </podcast:value>
  <item>
    <title>Episode 2</title>
    <guid>ep2</guid>
    <enclosure url="https://example.com/2.mp3" type="audio/mpeg" length="1"/>
    <itunes:duration>01:02:03</itunes:duration>
    <podcast:value type="lightning" method="lnaddress">
      <podcast:valueRecipient name="Guest" type="lnaddress" address="guest@example.com" split="50"/>
      <podcast:valueRecipient name="Host" type="lnaddress" address="host@example.com" split="50"/>
    </podcast:value>
  </item>
  <item>
    <title>Episode 1</title>
    <guid>ep1</guid>
    <enclosure url="https://example.com/1.mp3" type="audio/mpeg" length="1"/>
    <itunes:duration>754</itunes:duration>
  </item>
</channel>
</rss>`;

const r = (split: number, fee = false, kind: ValueRecipient['kind'] = 'lnaddress'): ValueRecipient => ({
  name: 'x', kind, address: 'x@y.z', split, fee,
});

describe('parseFeed', () => {
  const feed = parseFeed(FEED);
  it('reads the channel and its value blocks', () => {
    expect(feed.title).toBe('Nut Radio');
    expect(feed.image).toBe('https://example.com/cover.png');
    expect(feed.value).toHaveLength(2);
    const ln = feed.value[0];
    expect(ln.type).toBe('lightning');
    expect(ln.suggestedSatsPerMinute).toBe(5);
    expect(ln.recipients.map((x) => x.kind)).toEqual(['node', 'lnaddress', 'node']);
    expect(ln.recipients[2].fee).toBe(true);
  });
  it('lets an item override the channel value, and inherits otherwise', () => {
    expect(feed.episodes[0].value[0].recipients.map((x) => x.address)).toEqual(['guest@example.com', 'host@example.com']);
    expect(feed.episodes[1].value).toBe(feed.value);
  });
  it('reads durations in both forms', () => {
    expect(feed.episodes[0].durationSeconds).toBe(3723);
    expect(feed.episodes[1].durationSeconds).toBe(754);
  });
  it('prefers the cashu block', () => {
    expect(chooseBlock(feed.value)?.type).toBe('cashu');
    expect(chooseBlock(feed.episodes[0].value)?.type).toBe('lightning');
  });
  it('knows what ecash can pay', () => {
    expect(feed.value[0].recipients.map(payable)).toEqual([false, true, false]);
  });
  it('rejects garbage', () => {
    expect(() => parseFeed('not xml <')).toThrow();
  });
});

describe('splitAmount', () => {
  it('adds up exactly, largest remainder', () => {
    expect(splitAmount(21, [r(80), r(20)])).toEqual([17, 4]);
    expect(splitAmount(10, [r(1), r(1), r(1)])).toEqual([4, 3, 3]);
  });
  it('takes fee recipients off the top', () => {
    // 1% fee of 100 = 1, remaining 99 split 60/40
    const out = splitAmount(100, [r(60), r(40), r(1, true)]);
    expect(out.reduce((a, b) => a + b)).toBe(100);
    expect(out[2]).toBe(1);
    expect(out[0]).toBe(59); // 59.4
    expect(out[1]).toBe(40); // 39.6
  });
  it('works in msats', () => {
    const out = splitAmount(5000, [r(60), r(40), r(1, true)]);
    expect(out).toEqual([2970, 1980, 50]);
  });
  it('handles zero and only-fee lists', () => {
    expect(splitAmount(0, [r(1), r(2)])).toEqual([0, 0]);
    expect(splitAmount(7, [r(10, true)])).toEqual([7]);
  });
});
