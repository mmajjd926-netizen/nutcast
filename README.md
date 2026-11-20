# Nutcast

**Value4Value for any podcast, from a Cashu wallet in your browser.**

Nutcast is a podcast player that reads a feed's Podcasting 2.0 value split (`<podcast:value>`) and lets
listeners stream sats per minute and send boosts with a message — paid from an ecash wallet that lives
in the page. No node, no channel, no account.

- **Lightning-address recipients** are paid through the mint (LNURL-pay → bolt11 → NUT-05 melt), batched so
  the mint's fee reserve stays small.
- **Cashu recipients** (proposed `<podcast:value type="cashu" method="nut18">` with NUT-18 payment requests)
  receive ecash directly: no Lightning fee per payment, so streaming can really settle every minute.
- **Keysend-only recipients** cannot be reached from ecash; their share is shown as skipped and never
  redistributed — the podcaster's split stands.

Built for [Nut November](https://nutnovember.org) 2026 (Value4Value track). Work in progress.

## Develop

```bash
npm install
npm test                                        # unit tests
NUTCAST_LIVE=1 npx vitest run test/wallet.live.test.ts   # against testnut.cashu.space (fake Lightning)
npm run dev
```

License: MIT
