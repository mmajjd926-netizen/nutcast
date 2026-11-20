// Lightning address -> bolt11 invoice (LUD-16 + LUD-06, comment per LUD-12).

/** Amount of a bolt11 invoice in msat, read from its human-readable part; undefined if it has none. */
export function bolt11Msat(invoice: string): number | undefined {
  const m = invoice.toLowerCase().match(/^ln(?:bcrt|tbs|bc|tb|sb)(\d+)?([munp])?1[02-9ac-hj-np-z]+$/);
  if (!m) throw new Error('Not a bolt11 invoice');
  if (!m[1]) return undefined;
  const v = BigInt(m[1]);
  const per: Record<string, bigint> = { m: 100000000n, u: 100000n, n: 100n };
  if (!m[2]) return Number(v * 100000000000n);
  if (m[2] === 'p') {
    if (v % 10n) throw new Error('Invoice amount below a millisatoshi');
    return Number(v / 10n);
  }
  return Number(v * per[m[2]]);
}

export interface LnurlPayParams {
  callback: string;
  minSendable: number; // msat
  maxSendable: number; // msat
  commentAllowed: number;
}

type Fetch = typeof fetch;

export function lnAddressUrl(address: string): string {
  const m = address.trim().toLowerCase().match(/^([a-z0-9._+-]+)@([a-z0-9.-]+\.[a-z]{2,}|localhost(:\d+)?)$/);
  if (!m) throw new Error(`Not a Lightning address: ${address}`);
  const scheme = m[2].startsWith('localhost') ? 'http' : 'https';
  return `${scheme}://${m[2]}/.well-known/lnurlp/${m[1]}`;
}

export async function lnurlParams(address: string, f: Fetch = fetch): Promise<LnurlPayParams> {
  const res = await f(lnAddressUrl(address));
  if (!res.ok) throw new Error(`${address}: the Lightning address answered ${res.status}`);
  const j = await res.json();
  if (j.status === 'ERROR') throw new Error(`${address}: ${j.reason ?? 'error'}`);
  if (j.tag !== 'payRequest' || typeof j.callback !== 'string') throw new Error(`${address}: not an LNURL-pay endpoint`);
  return {
    callback: j.callback,
    minSendable: Number(j.minSendable ?? 1000),
    maxSendable: Number(j.maxSendable ?? 1e12),
    commentAllowed: Number(j.commentAllowed ?? 0),
  };
}

/** Ask the recipient's server for an invoice of exactly `sats`, and check it is for that amount. */
export async function invoiceFor(address: string, sats: number, comment?: string, f: Fetch = fetch): Promise<string> {
  const p = await lnurlParams(address, f);
  const msat = sats * 1000;
  if (msat < p.minSendable) throw new Error(`${address} accepts at least ${Math.ceil(p.minSendable / 1000)} sats`);
  if (msat > p.maxSendable) throw new Error(`${address} accepts at most ${Math.floor(p.maxSendable / 1000)} sats`);
  const u = new URL(p.callback);
  u.searchParams.set('amount', String(msat));
  if (comment && p.commentAllowed > 0) u.searchParams.set('comment', comment.slice(0, p.commentAllowed));
  const res = await f(u.toString());
  if (!res.ok) throw new Error(`${address}: the invoice request answered ${res.status}`);
  const j = await res.json();
  if (j.status === 'ERROR') throw new Error(`${address}: ${j.reason ?? 'error'}`);
  const pr: string = j.pr;
  if (typeof pr !== 'string' || !/^ln/i.test(pr)) throw new Error(`${address}: no invoice in the answer`);
  const got = bolt11Msat(pr);
  if (got !== undefined && got !== msat) throw new Error(`${address}: the invoice is for ${got / 1000} sats, not ${sats}`);
  return pr;
}
