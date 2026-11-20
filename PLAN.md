# Nutcast — plan (NutNovember 2026, Value4Value track). Deadline: submit by 2026-11-27 23:59 UTC (CryptPad form).
Form: https://cryptpad.fr/form/#/2/form/view/McFeBybVH+Z77jojI0mBOqt7yLz3JyNKIC-p38AK9LA/ (project name, GitHub repo, contact, demo).
Prizes: golden 150k, hardest 100k, nuttiest 50k, design 50k, fresh 50k (first-timers), Value4Value 400k (Nodesignal). One prize per project.
Competitor note: evidence-ledger-agent/hopp branch cashu-boost (Cashu boosts inside Hopp, Kotlin). We do NOT touch Hopp; we are a web tool.

## What it is
Static web app (Vite + TS + @cashu/cashu-ts), GitHub Pages. Any Podcasting 2.0 feed -> listen, stream sats and boost from an in-browser Cashu wallet.
- Wallet: choose mint (default demo: testnut.cashu.space, fake LN), top up via bolt11 (NUT-04), paste token to receive, export token, balance, proofs in IndexedDB/localStorage.
- Value: parse <podcast:value> (channel + item, item overrides), <podcast:valueRecipient name type address split fee customKey customValue>.
  * type=lnaddress -> LNURL-pay (LUD-06/16, LUD-12 comment) -> melt (NUT-05). Batched: settle when owed >= threshold (default 21 sat) because melts cost fee reserve.
  * type=node / keysend -> unpayable from ecash: shown as skipped, NOT redistributed (same rule as Hopp ADR 0005).
  * proposed: type="cashu" address="creqA…" (NUT-18 payment request) -> send ecash directly (HTTP POST or Nostr NIP-17 transport). No mint fee -> true per-minute streaming.
- Streaming: rate sat/min, session budget, pause; accrual per recipient in msat, whole sats paid (largest remainder), remainder carried.
- Boost: amount + message; to cashu recipients the message goes in the NUT-18 memo; to lnaddress in LUD-12 comment.
- Creator page: make a NUT-18 payment request + the <podcast:valueRecipient type="cashu"> snippet for the RSS.
- Feeds: URL fetch (CORS permitting) or paste XML. Demo feed bundled.

## Order
1. core/value.ts (RSS parse + split math) + tests. 2. core/wallet.ts (cashu-ts: mint, receive, send, melt) + tests on testnut.
3. core/stream.ts (accrual/settlement) + tests. 4. UI. 5. NUT-18 transports. 6. README, demo, Pages, nostr post #NutNovember, submit.
