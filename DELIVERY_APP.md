# Adonai Delivery — the rider partner application

Adonai Delivery is the **third application** in the Adonai system. It is a
standalone, installable app for the delivery partners (boda riders) who work
with the store. It is deliberately separate from the shopper's storefront and
from the cashier register / Admin Suite.

| Entity | Application | Entry point | Who uses it |
| --- | --- | --- | --- |
| 1 · Shopper | Storefront | `/` (`index.html`) | Customers browsing and paying |
| 2 · Staff | POS register + Admin Suite | `/pos`, `/admin` | Cashiers and dispatchers |
| **3 · Rider partner** | **Adonai Delivery** | **`/delivery` (`delivery.html`)** | **The rider who receives, accepts and delivers orders** |

The rider app has its **own manifest, icon set, service worker, sign-in,
screens and device session**. It does not load `app.js`, `storefront.js`,
`auth.js` or `db.js`, and it never reads the cashier's session or the shopper's
cart. Everything it renders comes from `/api/rider/*` on the same server.

---

## The flow the app implements

```
 Dispatcher (Admin Suite → Delivery Partners & Dispatch)
   └─ prepares a PAID web delivery order and assigns it to a rider
        └─ POST /api/dispatch/orders/{id}/assign  →  DeliveryEvent "assigned"
             │
             ▼
 Adonai Delivery (this app, on the rider's phone)
   ├─ receives the job (12 s poll + visibility refresh)
   │    → banner, sound, vibration, optional system notification, tab badge
   ├─ ACCEPT  → stage "accepted"     (or DECLINE → job returns to In Assembly)
   ├─ COLLECT → stage "collected"
   ├─ ARRIVE  → stage "arrived"
   ├─ DELIVER → stage "delivered"     (recipient name is mandatory)
   └─ REPORT A PROBLEM → stage "issue", visible on the dispatch board
```

Each stage is a durable `DeliveryEvent` row. When the rider confirms delivery
the order becomes `Completed` and the rider returns to `Available` if they have
no other active jobs. Declining is only allowed **before collection** — after
that the rider must call dispatch, because the parcel is already in their hands.

The customer-facing side is unchanged: the shopper orders on the storefront,
pays, and receives the parcel. The rider app only ever shows the customer
details of jobs assigned to that specific rider.

---

## Screens

- **Connect** — single-use code issued by dispatch, a label for the phone, and
  an optional server address. Connecting shows only jobs; it never starts GPS.
  A rejected/expired code is explained in plain language; repeat failures are
  rate limited by the server.
- **Jobs** — availability (`Available` / `On delivery` / `Offline`), the GPS
  duty switch, *Waiting for you* (new assignments with **Accept** / **Decline**)
  and *On the way* (accepted jobs). Each card has call, WhatsApp, directions,
  parcel details and a five-step progress strip.
- **Active** — pins the current job with one large next-step button.
- **History** — completed deliveries, recipient names, and the delivery fees
  attached to those jobs (explicitly labelled an activity record, **not** a
  payout statement).
- **Profile** — rider identity, device label, alert settings, install action,
  dispatch console link, privacy explanation and sign out.

A desktop-only side panel explains the flow and, in local demo mode, can push a
fresh order to the connected rider so the whole journey can be reviewed.

---

## API added for this app

All routes are device-scoped: the `Authorization: Bearer <device token>` header
identifies the rider, so one rider cannot read or mutate another rider's
customer data.

| Route | Purpose |
| --- | --- |
| `POST /api/dispatch/riders/{id}/app-code` | Dispatcher issues the onboarding code for this app. Job-inbox only — it cannot enable GPS. Works in a default store without the GPS privacy setup. |
| `POST /api/rider/connect` | Sign in the delivery app with a single-use pairing code. Unlike the native `/pair` route it does **not** require the GPS privacy policy, because connecting shares no location. |
| `GET /api/rider/me` | Rider, tracking state, assigned orders, GPS-policy and demo flags. |
| `GET /api/rider/orders/{id}` | Parcel contents (names/quantities only — no costs or supplier data), payment state and the delivery timeline. |
| `POST /api/rider/orders/{id}/progress` | `accepted → collected → arrived → delivered`, plus `issue`. |
| `POST /api/rider/orders/{id}/decline` | Refuse a job with a reason; returns it to `In Assembly` for reassignment. |
| `POST /api/rider/status` | Rider changes their own availability. |
| `GET /api/rider/history` | Completed deliveries and the delivery fees on them. |
| `POST /api/rider/duty/start` · `/stop` · `POST /api/rider/location` | Existing consent-based GPS duty (unchanged). |
| `POST /api/rider/demo/order` | **Local preview only**, gated behind `ADONAI_DELIVERY_DEMO=1`. Creates a paid demo order and assigns it through the same code path as the dispatch console. |

The native APK screen (`rider.html` → `js/rider-app.js`) is untouched. It still
requires the Java bridge for background GPS. Adonai Delivery is the **web/PWA
counterpart** that works in any modern browser and can be installed on a phone.

---

## Installation (rider's phone)

1. Open `https://<your-store>/delivery` in Chrome/Android (or Safari iOS).
2. Use the browser's **Install app / Add to Home screen** action. The app has
   its own `manifest-delivery.json` (`display: standalone`, its own lime boda
   icon set, shortcuts for Jobs / Active / History) and its own service worker
   scoped to `/delivery`.
3. Ask the dispatcher for a connection code: Admin Suite → Delivery Partners &
   Dispatch → **App code** (the Adonai Delivery path). The older **Pair phone**
   button is the GPS/Android path and only works once the Orders area is
   protected. Both codes are single-use, expire in 10 minutes, and work with
   `/delivery?…` — but only **App code** is guaranteed to work in a store that
   has not enabled live tracking.
4. Enter the code once. The device session lasts 30 days and lives only in this
   browser's local storage; **Sign out** on shared phones.
5. New jobs arrive automatically. Tap the bell to allow background system
   pop-ups; in-app banners, sound and vibration work without that permission.

The service worker caches only the app shell. **API responses are never
cached** — a delivery state always comes from the server. If the network drops,
a progress update is saved on the device and re-sent on the next successful
sync (the progress endpoint is idempotent for a repeated stage).

---

## Privacy

- Connecting shows jobs; it never reads location.
- GPS is a separate explicit duty with a consent checkbox, at most 12 hours,
  and a visible Stop action. Only the **latest** fix is stored — no route
  history, no phone serial, no IMEI.
- Simulated fixes used by the local demo are flagged `mock: true` and are
  labelled "simulated" on the dispatch map.
- A rider sees only orders whose `rider_id` is their own.
- Delivery fees shown in History are an activity record, not a wage statement.

---

## Local preview / demo

```bash
# 1. one-time (adds the rider, an orders-area password, 2 paid orders and a code)
.venv/bin/python scripts/demo_seed.py

# 2. rebuild the PWA icons if you change scripts/build-delivery-icons.py
.venv/bin/python scripts/build-delivery-icons.py

# 3. run the app
ALLOW_FRAME_EMBED=1 ADONAI_DELIVERY_DEMO=1 \
  .venv/bin/python serve.py 8000
```

Open `/delivery?demo=1`. Use code **`DEMORIDERS`** to sign in as *Kato Brian*.
The orders-area password for the dispatch console is **`adonai-demo-1`**.
Re-run `scripts/demo_seed.py` to reset the demo (it refreshes the consumed code
and rebuilds the two demo orders).

Optional preview root switches in `serve.py` (never affect production):

- `ADONAI_PREVIEW_DELIVERY_ROOT=1` → `/` serves the rider app
- `ADONAI_PREVIEW_STATES_ROOT=1` → `/` serves the UI-states preview
- `ADONAI_PREVIEW_POS_ROOT=1` / `ADONAI_PREVIEW_RIDER_ROOT=1` → existing switches

**Do not set `ADONAI_DELIVERY_DEMO=1` in production.** It is the only flag that
enables the demo-order endpoint.

---

## Tests

```bash
node tests/delivery-app.test.js    # or: npm test
```

The suite drives the real `delivery.html` + `js/delivery-app.js` against an
in-memory rider API and verifies: separation from storefront/cashier scripts,
manifest/worker/assets, connect failure and success, literal (non-injected)
customer text, parcel details, accept, new-order alerts, decline, the full
delivery with mandatory recipient proof, history, rider-scoped availability,
consent-gated GPS duty with honestly labelled simulated fixes, demo orders,
sign-out and offline update queuing.
