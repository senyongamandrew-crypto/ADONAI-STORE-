# Storefront Load Performance — Findings & Fixes

**Scope:** the customer-facing storefront (`/`) — the page a shopper opens first.
**Branch:** `arena/0e1a5a5f-adonai-store`
**Measured on:** the seeded 18-piece demo catalog, first visit, cold cache.

---

## 1. Why the site felt slow

Three separate things were stacking up. None of them was a slow server — the
catalog API answered in ~10 ms locally. The cost was in the **bytes the
browser had to pull** and in **the rail having nothing to show while it waited**.

### 1.1 The photo-count dots pulled full-resolution photos

Each rail card shows a row of up to four 40×40 "angle" dots. Those dots were
pointed straight at the **original JPEG master**:

| Dot | File loaded | Size |
|-----|-------------|------|
| front | `p1001.jpg` | 414,971 B |
| back | `p1001-back.jpg` | 283,569 B |
| fabric | `p1001-fabric.jpg` | 198,739 B |
| flaw | `p1001-flaw.jpg` | 106,814 B |
| **one card** | | **≈ 1.0 MB** |

Four tiny dots on a single card cost about a megabyte — and the real card
photo next to them cost 28 KB. The dots were **35× heavier than the photo
they were decorating.**

### 1.2 Photos in the database were served at full size

Garment photos uploaded through the POS are stored in the database and
served from `/api/media/<id>`. That route had no responsive variants, so a
2–5 MB master was downloaded in full for every card that referenced it. The
bundled catalog photos had WebP derivatives; the uploaded ones did not.

### 1.3 Every card photo was lazy-loaded — including the ones on screen

`loading="lazy"` was applied to all card photos. A shopper who just opened
the site is looking at the first row, but those photos sat in the lazy queue
behind the whole catalog.

### 1.4 The rail was one giant HTML string, and it was empty while loading

`grid.innerHTML = list.map(cardHTML).join("")` built the entire catalog into
one string before anything could paint. And because the rail is drawn from a
live catalog, there was a window where `#productGrid` was simply **empty** —
an empty grid reads as a broken shop.

---

## 2. What was changed

| # | Fix | Where |
|---|-----|-------|
| 1 | The optimizer also writes a **96 px WebP derivative**; the manifest records it; the dots load it | `scripts/optimize-product-images.py`, `js/image-manifest.js`, `js/product-kit.js`, `js/storefront.js` |
| 2 | The **media API re-encodes a stored photo on demand** at `?w=<px>` and those photos carry a responsive `srcset` | `media.py`, `api.py`, `js/product-kit.js` |
| 3 | The **first four cards load eagerly**; the largest-content one asks for `fetchpriority="high"` | `js/storefront.js`, `js/product-kit.js` |
| 4 | The rail **renders in batches of 12**, so the first screenful paints immediately; a token abandons stale batches | `js/storefront.js` |
| 5 | The HTML **ships placeholder cards**, so the grid looks like a shop before any script runs | `index.html`, `css/storefront.css`, `js/db.js`, `js/storefront.js` |
| 6 | **API responses are gzipped** (they were not, unlike the static assets) | `serve.py` |
| 7 | The **public catalog no longer publishes internal costing** | `access_control.py`, `api.py` |

### Details worth knowing

- **Derivatives never upscale.** A photo narrower than the requested width is
  served as-is.
- **The originals stay the source of truth.** Derivatives are pure cache,
  keyed by asset id + width, with their own `ETag` and a 7-day
  `immutable` cache lifetime.
- **Access control is unchanged.** An unpublished draft photo still 404s with
  `?w=320` exactly as it does without it.
- **The placeholder cannot get stuck.** If the catalog never answers, an
  8-second timeout retires it and the rail is drawn from whatever is known.
- **Videos are never re-encoded.** The `?w=` hint applies to images only.

---

## 3. Two problems found while measuring

### 3.1 The public catalog was publishing cost price and staff notes

`sanitize_product` only stripped `cost_price`, `staff_notes`, `stock_lot_id`
and `lot_grade_id` when the operator had put the **Stock area behind a
password**. A store with no area passwords configured — the common case —
was serving its internal costing on the public product list.

The public channel now always drops the internal costing, staff and lot
fields (`sanitize_storefront_product`).

### 3.2 No API response was ever compressed

Static assets were gzipped; every `/api/` response was sent as plain text.
The catalog payload — the thing the rail waits on — was the worst affected.

---

## 4. Results

### First visit, demo catalog (18 pieces)

| | Before | After | Change |
|---|---|---|---|
| Document | 5.2 KB | 5.4 KB | — |
| Scripts + stylesheet | 76.8 KB | 79.6 KB | +2.8 KB |
| Catalog payload (gzip) | 4.8 KB | 4.8 KB | — |
| **Photos, desktop** | **1175.6 KB** | **204.9 KB** | **−83 %** |
| **Photos, phone** | **1451.5 KB** | **480.8 KB** | **−67 %** |
| **Total first visit (desktop)** | **1262.3 KB** | **294.7 KB** | **−77 %** |

The catalog payload was 29,872 bytes on the wire before the gzip fix and
4,985 bytes after — an 83 % reduction, on a payload that is re-fetched every
4 seconds while the storefront is open.

### The dots, measured directly

Four dots on one card: **1,004,093 bytes → 10,008 bytes (100× smaller).**

### A database-hosted photo (the production path)

| Request | Before | After |
|---|---|---|
| Card photo (320 px) | 58,054 B (master) | 2,488 B (WebP) |
| Photo dot (96 px) | 58,054 B (master) | 3,602 B (WebP) |

---

## 5. Guards

| Test | Covers |
|---|---|
| `tests/storefront-performance.test.js` (new, in `npm test`) | dots use the tiny derivative; first cards load eagerly; the rail paints in batches; the placeholder is present and cannot stick; media API photos carry a `srcset`; API responses are gzipped; the public payload hides internal costing |
| `tests/test_media_derivatives.py` (new, 11 cases) | derivative size and format; every supported width; no upscaling; the master is unchanged; per-derivative `ETag` and 304; private drafts stay 404; videos are untouched; the public catalog and product page publish no internal costing |
| `tests/perf-media-audit.js` | measures the image weight of a rendered rail |
| `tests/perf-storefront-load.js` | measures the whole first-visit cost |

The three `test_notifications` failures that appear in a full-suite run are
**pre-existing** — they fail identically on the unmodified code (a test
isolation issue between test modules, unrelated to this work).
