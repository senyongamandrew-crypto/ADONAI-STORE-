# Adonai Store — Storefront Banner Audit & Fixes

**Screen reviewed:** `https://ai-store.onrender.com/` — Chrome on Android, 720×1600 screenshot (`Screenshot_20261015_210852_Chrome.jpg`)
**Annotated version of your screenshot:** `design/storefront-audit-annotated.png`
**Status:** every item below is fixed in this branch. Live preview: `/` on this sandbox.

---

## The short answer

Nothing about the banner was *broken* — it was **unfinished at the edges**:

1. The headline filled the banner; the paragraph **dissolved into the photo** because the
   scrim was tuned for a wide desktop box, not for the box it actually rendered in.
2. The strip under the banner showed **four identical grey-green rectangles** — the
   fallback "banner" was repeating one photo with no framing and no label, so it read as
   four broken images.
3. Above the fold there was **nothing to tap** — no call to action, and the promise that
   makes people buy (delivery, pay-on-delivery, returns) lived two screens down.
4. The **filter wall**: 18 category chips across six rows before the first garment.
5. The **WhatsApp bubble sat on top of the merchandise**, covering the third card's name
   and price.
6. On the phone, product cards still carried **desktop furniture** (SKU, brand/size/colour,
   review line, measurements line, two stacked buttons) — the text block was taller than
   the photo.

Below: what each thing is, why it happened, and exactly what changed.

---

## 1. The banner paragraph washes out mid-sentence

**What you see:** *"Shop Adonai Store's modern hybrid collection: Brand-New Apparel with
factory tags and multiple …"* — then the sentence disappears into the wall/vase photo,
and `rail.` lands alone on an unreadable third line.

**Why it happened**

`.masthead` paints the editorial photo *behind* the copy with a left-to-right scrim
(`css/storefront.css`):

```css
background:
  linear-gradient(90deg, rgba(255,253,248,.97) 0%, rgba(255,253,248,.9) 40%,
                         rgba(255,253,248,.16) 78%, rgba(255,253,248,.03) 100%),
  url("../assets/storefront-editorial-bg.jpg") center / cover no-repeat;
```

Read the stops: **opaque to 40%, almost transparent by 78%**. On a 1180px+ desktop box that
is correct — the copy column ends around 40% and the photo breathes on the right. In your
screenshot the box is ~1000px wide and much shorter, so 78% of the width lands directly on
the paragraph. Every line of body copy is running under the photo.

**What changed**

* The copy now lives in `.masthead-inner`, which carries **its own cream scrim** that fades
  out *before* it reaches the photograph, so legibility no longer depends on how wide the
  banner happens to be. It applies from 701px up; below that the photo shifts to a soft
  bottom band (`background-position: 72% 66%`) so the copy sits on clean cream.
* The headline is capped at ~62% of the banner so picture and type no longer share a
  boundary.
* The paragraph was also too long for a hero: the first sentence now stands alone on
  phones, and the detail about factory tags / hand-inspected vintage is capped at a
  readable measure (`.lede-more`, hidden under 700px).
* The vertical `KAMPALA / CURATED DAILY` watermark is dropped below 900px — at that size it
  was grey-on-photo noise rather than a design element.

## 2. The strip under the banner looked like four broken images

**What you see:** four equal, empty-looking grey-green tiles in a row.

**Why it happened**

That is the **promotional rail's fallback state**, not a design. In `js/storefront.js`:

```js
brandFallback = featured.length === 0;
...
? repeatedItems.map((_, index) => brandPromotionCardHTML(index > 0)).join("")
```

When no live offer qualifies (no compare-at price, or an empty rail), the rail repeats
`assets/storefront-editorial-bg.jpg` to fill the marquee. The card is 280×74 with
`object-fit: cover`, so what you get is the **middle band of a photo of a hanging cloth** —
four times, identically. And `.promo-card--brand` had **no CSS rule at all**, so it also
lost the price chip that gives the real product tiles their meaning.

**What changed** (`.promo-card--brand`, `css/storefront.css` v3.12)

* The fallback tiles get a **framed ribbon treatment**: white ring, warm shadow, and
  `object-position` that **steps across the frame** (34% → 62% → 86%) so each tile shows a
  different part of the picture instead of four copies of one crop. It now reads as a photo
  ribbon rather than a failed load.
* Owner-uploaded artwork gets the same care: `object-position: center 42%` keeps the
  garment band in frame instead of the exact centre.
* **Uploaded creative whose bytes are missing no longer renders as an empty grey
  rectangle.** It degrades to the same icon placeholder the product tiles use — a broken
  shop is worse than a plain one.
* On phones the tiles grow from 68px to 96px tall and the price chip from 8px to 10.5px so
  a real offer is legible; a 728×90 HTML leaderboard gets the full phone width instead of
  being stamped down to 280px.

> If you want the strip to *always* carry a message, upload artwork in
> **Admin → Storefront promotion strip** (`storefront_promo_ids`, "Upload banner images or
> HTML"). The fallback is deliberately copy-free — the suite in
> `tests/storefront-promotions.test.js` enforces that the strip never invents a heading,
> a discount or a slogan — so *your* artwork is how you say something there.

## 3. Nothing to tap above the fold

There were no calls to action in the hero and no service promise until "From our store to
your door", roughly two screens down. That is a lot of trust to ask for, unseen.

**What changed**

* Two buttons in the banner: **Shop the live rail** (anchors to the catalog) and
  **Order on WhatsApp** (real `wa.me` link, pre-filled message, hidden automatically if the
  store has no published number).
* A **four-chip service strip** directly under the banner: same-day Kampala delivery ·
  pay on delivery available · 2-day returns · order or track on WhatsApp — each backed by
  what the site already does (delivery regions, `/return-policy`, the storefront's payment
  channels). No new claims.

## 4. The filter wall

`DEMOGRAPHIC / CATEGORY / INVENTORY` with **18 category chips** wrapped over six rows, and
the first product card started *below the fold* of that. Every chip was individually fine —
together they were a directory.

**What changed**

* Below 1100px the panel collapses behind one **"Refine the rail"** button. The chip rows
  scroll horizontally inside it, so nothing is out of reach; opened, the button doubles as a
  live result read-out: **"Showing 9 of 18"**.
* A **badge** shows how many filters are active, and a **Clear** button resets all of them
  (including search and the price slider).
* The rail heading now reports honestly: **"18 pieces on the rail right now · prices in
  UGX"**, or **"9 of 18 pieces match your filters"**.
* Desktop (>1100px) is unchanged: the full panel is still visible, with no toggle.

## 5. The WhatsApp bubble sat on the merchandise

In your screenshot the green FAB covers the third card's **name and price** — the two things
a shopper needs to decide.

**What changed**

* A compact **brand-green pill** instead of a large bubble: icon-only on phones, icon +
  "Order on WhatsApp" from 701px up, offset from the iOS home-indicator
  (`env(safe-area-inset-bottom)`).
* It **hides itself** while the cart drawer or the privacy banner owns the bottom of the
  screen (CSS + a `MutationObserver` on the banner), and it is never rendered without a
  published number.
* The footer and the last row of cards reserve room, so nothing important sits underneath it.

## 6. A desktop card on a phone

Each phone card carried: demographic + **SKU** row, name, brand/size/colour/condition line,
"New arrival · No reviews yet", "📏 Exact flat-lay measurements listed", price row,
**Add to Cart**, **Details & measurements** — a text block taller than the garment photo,
one card per screen.

**What changed** (≤640px)

* Two-up grid (`repeat(2, minmax(0,1fr))`) — the standard resale layout: browse 18 pieces in
  ~4 screens instead of 18.
* The card keeps what sells: **photo, name, price, discount, condition badge, Add to Cart**.
* Removed from the phone card only: the SKU code, the review line and the duplicate
  *Details & measurements* button — the **entire card is already the link** to the PDP where
  measurements, flaw notes, photos and delivery all live.
* Price stays ≥15px, tap targets ≥44px, badges shrink but stay readable.

## 7. Two smaller things that "won't be seen"

* **Anchor jumps landed under the header.** The header is sticky and 72px tall, so every
  in-page jump (including the promo cards' `#catalogDashboardRegion`) hid its own heading.
  Fixed with `[id] { scroll-margin-top: 88px; }`.
* **A CSS/JS change could be invisible for up to a year.** `css/`, `js/` and `assets/` are
  served `Cache-Control: public, max-age=31536000, immutable`, and the manual `?v=3.11` /
  `?v=4.5` query strings were the only cache-buster — easy to forget on a deploy. The server
  now **stamps every local css/js/asset URL in HTML with a fingerprint of the file it points
  at** (`version_asset_references()` in `serve.py`), for the storefront *and* the
  server-rendered product pages. Change a file → the URL changes → the shopper gets the new
  stylesheet. No manual step, ever.

---

## Files changed

| File | What |
|---|---|
| `index.html` | banner copy wrapper + CTAs, service strip, rail count, filter toggle/clear, WhatsApp order link |
| `css/storefront.css` | new **v3.12** layer: banner scrim + mobile crop, CTAs, trust strip, promo ribbon framing, collapsible filter panel, two-up mobile cards, anchor offsets, WhatsApp FAB |
| `js/storefront.js` | WhatsApp wiring for both entry points, FAB visibility, promo fallback crop + missing-artwork degradation, filter panel state, live counts, clear-filters |
| `serve.py` | automatic asset fingerprinting for HTML responses (storefront + PDP) |
| `design/storefront-audit-annotated.png` | your screenshot with the six findings marked |

## Verification

* `npm test` — full suites green, including `storefront-promotions` (the strip advertises
  only genuine catalog offers, keeps the copy-free fallback, never fabricates discounts) and
  `storefront-policies`.
* `python3 -m unittest test_render_postgres` — 30/30 OK (API, PDP render, sitemap, security).
* `python3 -m unittest discover -s tests` — 3 failures in `test_notifications`, **identical
  before and after these changes** (parallel SQLite worker isolation in this sandbox, not
  caused by this work; verified by stashing the diff and re-running).
* Headless DOM smoke run against the local server (jsdom): boot clean, 18 cards, filter
  toggle/badge/clear behaviour, promo fallback block, both WhatsApp links wired.
* Server responses checked for: fingerprinted asset URLs on `/` and `/product/<slug>`,
  Google Fonts and `manifest.json` untouched, `immutable` caching intact, gzip intact,
  `/`, `/pos`, `/admin`, `/terms-and-conditions`, `/sitemap.xml` all 200.

## Optional next steps (not done)

* **Cross-device check.** Offline here I can't load `fonts.googleapis.com`, so the live
  visual proof is limited to the DOM/logic level; a real phone check of the new banner
  (portrait + "Desktop site" mode) is worth 5 minutes.
* **Real photography in the banner.** The hero and the promo fallback both use
  `assets/storefront-editorial-bg.jpg` (a wall, a cloth and a vase). One clear photo of a
  styled outfit — or three — would make the banner sell clothes instead of atmosphere.
* **A single WhatsApp number.** The rail/footer link uses `settings.whatsapp`
  (`256758873398`) and the screenshot's FAB resolved to `+256 758893398`. Worth confirming
  which is live in **Admin → Store Settings**; the FAB and the banner button now follow that
  setting automatically.
* **The shop itself.** The demo rail shows "New arrival · No reviews yet" on every piece.
  Honest, but two or three real reviews on the top sellers would do more for conversion than
  any of the above.
