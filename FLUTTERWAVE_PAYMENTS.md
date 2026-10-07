# Flutterwave Payments — Setup & Operations Guide

Adonai Store now accepts **online payment at checkout** on the web storefront:
customers can pay immediately with **MTN Mobile Money, Airtel Money, Visa or
Mastercard** via the Flutterwave popup, or still choose **Pay on
delivery/pickup** exactly as before.

---

## 1. How it works

```
Shopper cart → [Pay now | Pay on delivery] toggle
                     │
        Pay now (Flutterwave)
                     │
1. Shopper enters email → required by Flutterwave for checkout receipts
2. Order created        → pieces reserved server-side, status "Awaiting payment"
3. Checkout opens       → shopper approves MTN MoMo / Airtel / card
4. Server verifies      → transaction re-checked with your SECRET key
   (browser response is never trusted on its own)
5. Order marked PAID    → POS/admin get a 💳 "Paid online" notification
6. Webhook backup       → Flutterwave also calls your server directly
                         (settles the order even if the shopper closed the tab)
7. If unpaid in 30 min  → pieces automatically return to the rail, order cancelled
```

Key properties:

* **Amounts always come from the server-side order** — a shopper can never
  change what they pay from the browser.
* Every payment attempt is re-verified with Flutterwave's API (status, amount,
  currency and reference must all match the order).
* Both the browser callback **and** the webhook settle the order **exactly
  once** (idempotent — safe for retries).
* Abandoned payments automatically release stock (important for 1-of-1
  thrift pieces) and drop out of the POS fulfillment queue.

Flutterwave securely renders the card and MTN/Airtel mobile-money steps; the
storefront must not collect or store card numbers itself. A store's separate
manual merchant-code deposit is not part of the Flutterwave popup. To support
that, configure the merchant code and add a distinct manual-payment / receipt
confirmation flow rather than presenting an unverified deposit as paid.

---

## 2. Configure your keys (Render)

You already have a Flutterwave account. Get the three values from
[https://dashboard.flutterwave.com](https://dashboard.flutterwave.com) →
**Settings → APIs** (note: the dashboard shows **test keys** and **live keys**
separately — use test keys while testing, live keys for real money).

In your **Render service → Environment** tab, add:

| Variable | Where to find it | Example |
|---|---|---|
| `FLW_PUBLIC_KEY` | Dashboard → Settings → APIs → Public Key | `FLWPUBK_TEST-377...-X` |
| `FLW_SECRET_KEY` | Dashboard → Settings → APIs → Secret Key | `FLWSECK_TEST-9b1...-X` |
| `FLW_SECRET_HASH` | **You invent this** (long random string) — also paste it into the webhook settings (step 3) | `8f7a...long-random...` |

The server also accepts the variables spelled `FLWPUBK` / `FLWPUBK_TEST` /
`FLWPUBK_LIVE` and `FLWSECK` / `FLWSECK_TEST` / `FLWSECK_LIVE`, and if you
pasted only the token body (for example `d7a8...-X` without the
`FLWPUBK_TEST-` prefix) it is reconstructed automatically from the variable
name. Standard names with the full prefixed key remain the cleanest setup.

Optional variables (defaults shown):

```bash
FLW_CURRENCY=UGX                 # charge currency
FLW_PAYMENT_TTL_MINUTES=30       # how long an unpaid order holds stock
```

Redeploy. Once both keys are present, the storefront shows **Pay now — Card & MoMo**
and selects it by default; the customer can still switch to **Pay on
delivery/pickup**. Pay-now checkout asks for an email address because
Flutterwave requires it for payment receipts. The email is sent to Flutterwave
for that checkout session and is not stored on the order. If the keys are
missing, the storefront clearly explains that online payment is unavailable
instead of silently hiding the option.

> ⚠️ Never commit `FLW_SECRET_KEY` or `FLW_SECRET_HASH` into git — set them
> only in the Render dashboard.

## 3. Configure the webhook (required)

The webhook is how Flutterwave tells your server a payment completed even if
the shopper closed their browser mid-payment.

1. Dashboard → **Settings → Webhooks**
2. **URL:** `https://adonai-store.onrender.com/api/payments/flutterwave/webhook`
   (use your real domain)
3. **Secret hash:** paste the exact same value you put in `FLW_SECRET_HASH`
4. Save.

Your server rejects any webhook that doesn't carry this hash
(`401 Invalid webhook signature`), then re-verifies the transaction with the
API anyway.

## 4. Test it

**Test mode** (dashboard toggle shows test keys):
1. Set test keys in Render, add a product to the cart, choose **Pay now**.
2. In the popup choose **Card** and use Flutterwave's test card
   `5531 8866 5214 2950`, CVV `564`, expiry any future date, PIN `3310`,
   OTP `12345`.
3. The cart view shows **Status: Paid ✔** and the POS/Admin gets the
   💳 notification.
4. Try the MTN MoMo option with Flutterwave's test MSISDNs from their docs.

**Local development without any keys:** run the server with
`FLW_MOCK_MODE=1` — the gateway is simulated end-to-end (popup is replaced by
an instant local approval through the same server verification path). Never
set this on Render.

## 5. Where the money & the books go

* Settlement: Flutterwave settles to the bank/mobile-money float linked to
  your dashboard account on its normal payout schedule.
* In the store ledger, online payments post the sale debit to
  **1020 Bank Account** (vs `1010 Mobile Money` for manual MoMo and
  `1000 Cash on Hand` for cash) so you can reconcile against Flutterwave
  payouts.
* Every attempt is recorded in the `payment_transactions` table (reference,
  amount, channel, Flutterwave transaction id) — visible to staff via the
  order's payment block.

## 6. Go-live checklist

- [ ] Live public/secret keys set in Render (`FLW_PUBLIC_KEY`, `FLW_SECRET_KEY`)
- [ ] `FLW_SECRET_HASH` set in Render **and** in the dashboard webhook settings
- [ ] Webhook URL points at your production domain
- [ ] One real-money test (your own MTN number, smallest priced item)
- [ ] Refund flow noted: refunds are issued from the Flutterwave dashboard → Transactions

## 7. Troubleshooting

| Symptom | Fix |
|---|---|
| Online payment unavailable message shown | Add `FLW_PUBLIC_KEY` and `FLW_SECRET_KEY` to the Render service environment, then redeploy |
| Checkout refuses to continue to Flutterwave | The shopper needs a valid email address; Flutterwave requires one for the payment session |
| Popup opens, payment succeeds, order stays "Awaiting payment" | Webhook not configured — but the browser verify should still settle it. Check Render logs for `Payment settle refused` (amount/currency mismatch) |
| Webhook returns 401 | `FLW_SECRET_HASH` in Render ≠ secret hash in the Flutterwave dashboard |
| Order cancelled & item back on sale | Shopper didn't pay within `FLW_PAYMENT_TTL_MINUTES` — normal behavior |
| Popup blocked by CSP in old deploys | The site now sends an updated Content-Security-Policy allowing `checkout.flutterwave.com`; hard-refresh (Ctrl+F5) |
