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
cart. Everything it renders comes from `/api/rider-account/*` and `/api/rider/*`
on the same server.

---

## Onboarding: four steps, in this order

A rider reaches the job inbox only after all of these:

1. **Sign in or create an account** with a mobile number and password.
   A new account grants no jobs by itself.
2. **Check in for today** with a selfie and a drawn signature, plus a consent
   tick. One check-in per rider per Kampala day.
3. **Link the phone** with the one-time App code from dispatch. The code links
   the account to the roster rider and issues the device session.
4. **Accept assigned deliveries with one tap.** Accepting is blocked until the
   rider has checked in today.

```
 Rider's phone                                     Dispatch (Admin Suite)
 ─────────────                                     ──────────────────────
 1 Sign in / create account  ─ phone + password
 2 Selfie + signature        ─ once per Kampala day
                                                   3 App code ──► (10 min, single use)
 3 Enter App code            ─ links account to rider profile
 4 Accept (one tap)          ─ blocked without today's check-in
 Collect → Arrive → Deliver  ─ recipient name required
```

**Phone numbers** are normalised to `2567XXXXXXXX` (`0772 123 456`,
`+256 772 123 456` and `256772123456` are the same account).

**Each roster rider can link to only one account, and each account to only one
rider profile.** An App code is single-use and expires after 10 minutes. The
device session is tied to the account that linked it. If a different rider
signs in on the same phone, the old device link is dropped.

**Riders who pair through the APK path** (`/api/rider/pair`, native GPS app)
have no rider account and are **not** gated by the check-in.

---

## The order flow once linked

```
 Dispatcher (Admin Suite → Delivery Partners & Dispatch)
   └─ prepares a PAID web delivery order and assigns it to a rider
        └─ POST /api/dispatch/orders/{id}/assign  →  DeliveryEvent "assigned"
             │
             ▼
 Adonai Delivery (this app, on the rider's phone)
   ├─ receives the job (12 s poll + visibility refresh)
   │    → banner, sound, vibration, optional system notification, tab badge
   ├─ ACCEPT  → stage "accepted"     (one tap; needs today's check-in)
   │            (or DECLINE → job returns to In Assembly)
   ├─ COLLECT → stage "collected"
   ├─ ARRIVE  → stage "arrived"
   ├─ DELIVER → stage "delivered"     (recipient name is mandatory)
   └─ REPORT A PROBLEM → stage "issue", visible on the dispatch board
```

Each stage is a durable `DeliveryEvent` row. When the rider confirms delivery
the order becomes `Completed` and the rider returns to `Available` if they have
no other active jobs. Declining is only allowed **before collection**. After
that the rider must call dispatch, because the parcel is already in their hands.

The rider app only ever shows the customer details of jobs assigned to that
specific rider.

---

## Screens

- **Sign in / Create account** — phone and password, with an advanced server
  address for dispatch-provided HTTPS addresses. Shows the three setup steps.
- **Check in** — selfie (front camera; compressed to a JPEG under 300 KB on the
  phone), a signature pad (PNG under 120 KB) and a consent checkbox. When it is
  opened from Jobs it can return to the inbox.
- **Connect** — the App code, a label for the phone, and the rider's name and
  check-in state. Connecting shows jobs; it never starts GPS.
- **Jobs** — the check-in banner (when today's check-in is missing), availability
  (`Available` / `On delivery` / `Offline`), the GPS duty switch, *Waiting for
  you* (new assignments with **Accept** / **Decline**) and *On the way*. Each
  card has call, WhatsApp, directions, parcel details and a five-step strip.
- **Active** — pins the current job with one large next-step button.
- **History** — completed deliveries, recipient names, and the delivery fees
  attached to those jobs (explicitly labelled an activity record, **not** a
  payout statement).
- **Profile** — rider identity, today's check-in state, device label, alert
  settings, install action, dispatch console link, "Replace this phone" (a new
  App code is then needed), and sign out.

A desktop-only side panel explains the flow and, in local demo mode, can push a
fresh order to the connected rider so the whole journey can be reviewed.

---

## API

Rider-account routes are public but bound to the account's own sign-in token.
Rider device routes are bound to the device token. Dispatch attendance routes
are staff-only (`/api/dispatch/*`).

| Route | Purpose |
| --- | --- |
| `POST /api/rider-account/signup` | Create an account (`name`, `phone`, `password` ≥ 8). Returns a 30-day sign-in token. Grants no jobs. |
| `POST /api/rider-account/login` | Sign in (`phone`, `password`). Rate limited with the other credential routes. |
| `GET /api/rider-account/me` | The account, linked rider (if any), and today's attendance. |
| `POST /api/rider-account/attendance` | Today's check-in: `consent: true`, `selfie` (`data:image/jpeg;base64,…`, ≤ 300 KB), `signature` (`data:image/png;base64,…`, ≤ 120 KB). Images are checked by their magic bytes. One record per account per Kampala day. |
| `POST /api/rider-account/connect` | Link the account to a roster rider with an App code. Requires today's check-in. Returns the device session. |
| `POST /api/rider-account/logout` | Ends the account session and revokes the linked device. |
| `POST /api/dispatch/riders/{id}/app-code` | Dispatcher issues the onboarding code. Job-inbox only; it cannot enable GPS. |
| `GET /api/dispatch/attendance` | Staff: today's check-ins with names, phones and image URLs. Images are never inlined. |
| `GET /api/dispatch/attendance/{id}/selfie` · `/signature` | Staff: the stored JPEG or PNG for today's record. |
| `POST /api/rider/connect` | **Retired.** Returns `410 CONNECT_MOVED` and points the rider to sign-in. |
| `GET /api/rider/me` | Rider, tracking state, assigned orders, `attendance_required`, `checked_in_today`, GPS-policy and demo flags. |
| `GET /api/rider/orders/{id}` | Parcel contents (names/quantities only, no costs or supplier data), payment state and the timeline. |
| `POST /api/rider/orders/{id}/progress` | `accepted → collected → arrived → delivered`, plus `issue`. `accepted` returns `409 ATTENDANCE_REQUIRED` without today's check-in. |
| `POST /api/rider/orders/{id}/decline` | Refuse a job with a reason; returns it to `In Assembly` for reassignment. |
| `POST /api/rider/status` | The rider changes their own availability. |
| `GET /api/rider/history` | Completed deliveries and the delivery fees on them. |
| `POST /api/rider/duty/start` · `/stop` · `POST /api/rider/location` | Consent-based GPS duty (unchanged). |
| `POST /api/rider/demo/order` | **Local preview only**, gated behind `ADONAI_DELIVERY_DEMO=1`. |

The native APK screen (`rider.html` → `js/rider-app.js`) is untouched. It still
requires the Java bridge for background GPS and ships inside the **POS APK**
under *Menu → Rider delivery app*. Adonai Delivery works in any modern browser
as an installable PWA **and** as its own Android APK (next section). The two
APKs are different applications: never send a rider `adonai-pos-v2.apk` when
they ask for Adonai Delivery.

---

## Installation (rider's phone)

There are two ways to install Adonai Delivery, plus one file to avoid:

| Download | What it actually is |
| --- | --- |
| **`adonai-delivery.apk`** | ✅ **This app.** Package `com.adonaithrift.delivery`, lime boda icon, opens straight into rider sign-in. No cashier register inside. |
| Browser install from `/delivery` | ✅ This app as a PWA (same screens, same account). |
| `adonai-pos-v2.apk` / `adonai-pos-v2.5.0-preview.apk` | ❌ **Adonai POS**, the cashier register (`com.adonaithrift.pos`). Branch builds are labelled *Adonai POS Preview*. If a download opens the shop register, it is this file — delete it from the rider's phone and download `adonai-delivery.apk` instead. |

### Option A — Android APK (`adonai-delivery.apk`)

1. Download `adonai-delivery.apk` from the latest
   [GitHub Release](https://github.com/senyongamandrew-crypto/ADONAI-STORE-/releases),
   the `adonai-delivery-apk` artifact of the APK workflow, the `apk-dist`
   branch, or `https://<your-store>/download/delivery-apk` when the server has
   the file in `dist/`. CI verifies the package id, label, signature and that
   the bundle contains **no POS/Admin pages** (`scripts/verify-delivery-apk.py`).
2. Open the file, allow *Install unknown apps* for your browser/Files if asked,
   and tap **Install**. Branch preview builds install as *Adonai Delivery
   Preview* (`com.adonaithrift.delivery.preview`) alongside the real app.
3. Continue at step 3 below. Inside the APK the app talks to the live store
   server by default; a different HTTPS address can be set under
   *Advanced · store server*. The GPS duty switch uses the phone's Location
   permission while the app is open (*screen-locked* background GPS remains the
   native pairing path inside the POS APK's *Rider delivery app* screen).

Build it locally with `npm run build:apk:delivery` (JDK 17 + Android SDK;
outputs `dist/adonai-delivery.apk`).

### Option B — Browser install (PWA)

1. Open `https://<your-store>/delivery` in Chrome/Android (or Safari on iOS).
2. Use the browser's **Install app / Add to Home screen** action. The app has
   its own `manifest-delivery.json` (`display: standalone`, its own lime boda
   icon set, shortcuts for Jobs / Active / History) and its own service worker
   scoped to `/delivery`.
3. Sign in, or create an account with your mobile number.
4. Take today's selfie and sign the box, then tick the consent box.
5. Ask the dispatcher for an App code (Admin Suite → Delivery Partners &
   Dispatch → **App code**), and enter it. Codes are single-use and expire in
   10 minutes.
6. New jobs arrive automatically. Tap the bell to allow system pop-ups; in-app
   banners, sound and vibration work without that permission.

The service worker caches only the app shell. **API responses are never
cached.** A delivery state always comes from the server. If the network drops,
a progress update is saved on the device and re-sent on the next successful
sync (the progress endpoint is idempotent for a repeated stage). Sign out on
shared phones.

---

## Privacy

- Attendance selfies and signatures are visible to dispatch staff only. They
  are stored once per rider per day, and the rider consents at check-in.
- Connecting shows jobs; it never reads location.
- GPS is a separate explicit duty with a consent checkbox, at most 12 hours,
  and a visible Stop action. Only the **latest** fix is stored: no route
  history, no phone serial, no IMEI.
- Simulated fixes used by the local demo are flagged `mock: true` and are
  labelled "simulated" on the dispatch map.
- A rider sees only orders whose `rider_id` is their own.
- The password is never stored on the phone. The sign-in token is kept in local
  storage and expires after 30 days. The server stores only its hash.
- Delivery fees shown in History are an activity record, not a wage statement.

---

## Local preview / demo

```bash
# 1. one-time (adds the rider, a demo sign-in, an orders-area password, 2 paid orders and a code)
.venv/bin/python scripts/demo_seed.py

# 2. rebuild the PWA icons if you change scripts/build-delivery-icons.py
.venv/bin/python scripts/build-delivery-icons.py

# 3. run the app
ALLOW_FRAME_EMBED=1 ADONAI_DELIVERY_DEMO=1 \
  .venv/bin/python serve.py 8000
```

Open `/delivery?demo=1`. The demo rider signs in with phone **`0772 555 010`**
and password **`rider-demo-1`**. The demo account is not pre-linked, so the
demo shows every step: sign in, check in, then the App code **`DEMORIDERS`**,
which links *Kato Brian*. The demo code lasts 60 minutes so a review is not cut short; production codes last 10 minutes. The orders-area password for the dispatch console is
**`adonai-demo-1`**. Re-run `scripts/demo_seed.py` to reset the demo: it
refreshes the consumed code, clears the demo's check-in and link, and rebuilds
the two demo orders.

Optional preview root switches in `serve.py` (never affect production):

- `ADONAI_PREVIEW_DELIVERY_ROOT=1` → `/` serves the rider app
- `ADONAI_PREVIEW_STATES_ROOT=1` → `/` serves the UI-states preview
- `ADONAI_PREVIEW_POS_ROOT=1` / `ADONAI_PREVIEW_RIDER_ROOT=1` → existing switches

**Do not set `ADONAI_DELIVERY_DEMO=1` in production.** It is the only flag that
enables the demo-order endpoint.

---

## Tests

```bash
node tests/delivery-app.test.js                # jsdom: the real HTML + app script
.venv/bin/python -m unittest tests/rider_accounts_test.py   # API, temporary SQLite
.venv/bin/python -m unittest tests/test_dispatch.py          # dispatch regressions
npm test                                       # the full Node suite
```

The jsdom suite drives the rider journey against an in-memory API that follows
the server's rules. It covers: separation from the storefront and cashier
scripts, manifest, worker and assets, sign-in with a wrong and a right password,
the password never being stored on the phone, check-in with selfie
compression, the 300 KB refusal, signature and consent, the App code (wrong and
right), literal customer text, one-tap accept, parcel details, new-order alerts,
decline, the delivery with mandatory recipient proof, history, rider-scoped
availability, consented GPS duty with honestly labelled simulated fixes, demo
orders, the daily check-in gate (a refused accept routes to check-in, and the
banner appears on later syncs), a new rider not inheriting a previous device
link, expired device sessions, sign-out, and offline update queuing.

The Python suite (`tests/rider_accounts_test.py`) covers: phone normalisation,
signup and hashed storage, sign-in, consent, JPEG and PNG validation and size
limits, one check-in per day, the App code gate (single use, expiry, the
retired `/api/rider/connect`), one account per roster rider, the accept gate
for account riders, APK riders not being gated, rider-scoped orders,
staff-only attendance images, session expiry and logout, and sign-in rate
limiting.
