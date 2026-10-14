# Flutterwave Payments — Setup & Operations Guide

Adonai Store accepts **payment the moment an order is confirmed**. A shopper who
is not paying on delivery picks how they want to pay and goes straight to the
money:

* **Mobile money** — send the exact amount to the store's merchant line, then
  submit the transaction ID from the MoMo message.
* **Bank transfer** — send to the store account, then submit the reference.
* **Merchant pay code** — the system issues a code (`ADN-XXXXXX`) locked to that
  order and that exact amount, usable at any merchant point or by whoever is
  paying for the shopper.
* **Card** — Visa / Mastercard (and MoMo wallets) inside the Flutterwave popup.

**Pay on delivery/pickup** works exactly as before. PIN entry always stays with
the bank / mobile-money / merchant app or inside the Flutterwave popup — the
storefront never asks for a PIN, and a customer's submitted reference is only a
claim until staff confirm the money landed.

---

## 1. How it works

```
Shopper cart → [How would you like to pay?]
   Card · Mobile money · Bank transfer · Merchant pay code · Pay on delivery
                     │
1. Order created      → pieces reserved server-side, a per-order payment token
                        issued to that browser, and the pay window starts
2. Pay step shows what to pay:
     Card      → secure Flutterwave popup (approve with PIN / one-time code there)
     Mobile    → merchant number, exact amount, order reference
     Bank      → bank, account name/number, branch, reference
     Merchant  → system-issued ADN- pay code + step-by-step instructions
3. Shopper pays from their own phone/app, then submits the transaction ID
4. Staff confirm      → console → Fulfillment & Orders → the order shows
                        AWAITING CONFIRMATION until someone confirms it, with the
                        reference, against the bank / MoMo statement
                        (card settles automatically once the gateway verifies)
5. Order marked PAID  → POS/admin get a notification and the books update
6. If unpaid in time  → pieces automatically return to the rail, order cancelled
                        (30 min card, 180 min offline by default)
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
* The payment token is issued once, to the browser that placed the order, and
  stored server-side only as a SHA-256 hash — it authorises payment actions for
  that one order and nothing else.
* Shoppers who close the tab can come back: the pending payment (order, amount,
  channel, code) is restored on their next visit.

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
FLW_CURRENCY=UGX                        # charge currency
FLW_PAYMENT_TTL_MINUTES=30              # card pay window (stock hold)
ADONAI_OFFLINE_PAYMENT_TTL_MINUTES=180  # MoMo / bank / pay-code window (30–1440)
```

Redeploy. Checkout then offers **Card**, **Mobile money**, **Bank transfer**,
**Merchant pay code** and **Pay on delivery/pickup** — but only the channels the
store can actually honour, so a shopper can never be sent down a payment route
that would leave their money in limbo:

| Channel | Appears once you publish… |
|---|---|
| Card | `FLW_PUBLIC_KEY` + `FLW_SECRET_KEY` (or `FLW_MOCK_MODE=1` while testing) |
| Mobile money | Admin → Store Settings → **Mobile money merchant line** (name + number) |
| Bank transfer | Admin → Store Settings → **Bank account for transfers** (number required) |
| Merchant pay code | nothing to publish — always available |
| Pay on delivery | always available |

Cards and pay codes need no published details, so they are always offered.

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

**Card (test mode — dashboard toggle shows test keys):**
1. Set test keys in Render, add a product to the cart, choose **Card**.
2. In the popup use Flutterwave's test card `5531 8866 5214 2950`, CVV `564`,
   expiry any future date, PIN `3310`, OTP `12345`.
3. The cart view shows **Status: Paid ✔** and the POS/Admin gets the
   notification.
4. Try the MTN MoMo option with Flutterwave's test MSISDNs from their docs.

**Mobile money / bank / merchant pay code (no gateway needed):**
1. Publish the merchant line and/or bank account in Store Settings.
2. Add a product, choose the channel, confirm the order and note the pay-to
   details (or the `ADN-` code) shown on the pay step.
3. Press **I have paid — submit…** and paste any reference. The order moves to
   **AWAITING CONFIRMATION** — it does *not* become paid.
4. In the console open Fulfillment & Orders → the order. Confirm **Bank** only
   after entering the reference; **MoMo** and **Pay code** accept one too.
   The order turns **PAID** and the journal posts the right account.

**Nothing to check by hand?** `FLW_MOCK_MODE=1` simulates the card gateway
end-to-end; offline channels need no gateway at all.

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
| No Card option at checkout | `FLW_PUBLIC_KEY`/`FLW_SECRET_KEY` not set, or site not redeployed |
| No Mobile money / Bank option | The pay-to details are not published — Admin → Store Settings → Mobile money merchant line / Bank account for transfers |
| Customer says they paid but the order is not paid | Check Fulfillment & Orders: the order reads **AWAITING CONFIRMATION** until staff confirm the reference against the statement |
| Popup opens, card payment succeeds, order stays unpaid | Webhook not configured — but the browser verify should still settle it. Check Render logs for `Payment settle refused` (amount/currency mismatch) |
| Webhook returns 401 | `FLW_SECRET_HASH` in Render ≠ secret hash in the Flutterwave dashboard |
| Order cancelled & item back on sale | Shopper didn't pay within `FLW_PAYMENT_TTL_MINUTES` — normal behavior |
| Popup blocked by CSP in old deploys | The site now sends an updated Content-Security-Policy allowing `checkout.flutterwave.com`; hard-refresh (Ctrl+F5) |
