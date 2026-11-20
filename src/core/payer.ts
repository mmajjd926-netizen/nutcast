// The Payer the streamer uses: Lightning addresses through a melt, NUT-18 requests with ecash.
import { PaymentRequest, PaymentRequestTransportType, decodePaymentRequest } from '@cashu/cashu-ts';
import { invoiceFor } from './lnurl';
import { sendNip17 } from './nostr';
import type { Payer } from './stream';
import type { EcashWallet } from './wallet';

export function walletPayer(wallet: EcashWallet, f: typeof fetch = fetch): Payer {
  return {
    async payLnAddress(address, sats, comment) {
      const invoice = await invoiceFor(address, sats, comment, f);
      const res = await wallet.payInvoice(invoice);
      return { fee: res.feePaid };
    },
    async payRequest(request, sats, memo) {
      const pr = decodePaymentRequest(request);
      const post = pr.getTransport(PaymentRequestTransportType.POST);
      const nostr = pr.getTransport(PaymentRequestTransportType.NOSTR);
      if (!post && !nostr) throw new Error('This payment request names no transport Nutcast can use.');
      const before = wallet.balance();
      const { body, amount } = await wallet.payRequestPayload(request, sats, memo);
      let ok = false;
      try {
        if (post) {
          const res = await f(post.target, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
          ok = res.ok;
          if (!ok) throw new Error(`The recipient answered ${res.status}`);
        } else {
          await sendNip17(nostr!.target, body);
          ok = true;
        }
      } finally {
        if (!ok) {
          // Nobody took the token: put its proofs back into the wallet.
          wallet.restore(PaymentRequest.decodePayload(body).proofs);
        }
      }
      return { fee: Math.max(0, before - wallet.balance() - amount) };
    },
  };
}
