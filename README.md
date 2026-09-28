# ADONAI STORE — OPS Dashboard

Operations dashboard for the Adonai Store: orders, inventory, customers and payments — all in one place.

## Quick start

No build step needed. Serve the folder statically and open it in a browser:

```bash
# anywhere in this repo
python3 -m http.server 8080 --bind 0.0.0.0
# or: npx serve .
```

Then visit `http://localhost:8080`.

## Features

- **Overview** — revenue KPIs (today / 7 days), 14-day revenue chart, order pipeline, latest orders, low-stock alerts
- **Orders** — filter by status (pending → paid → shipped → delivered → cancelled), advance/cancel orders, create new orders
- **Inventory** — stock levels with reorder thresholds, restock, add/edit products
- **Customers** — order counts and lifetime value per customer
- **Payments** — mobile-money friendly log (MTN MoMo, Airtel Money, Cash, Card) with collection KPIs
- Global search, localStorage persistence (edits survive page refresh), responsive layout

Currency is formatted in **UGX** (Ugandan Shilling).

## Files

| File | Purpose |
| --- | --- |
| `index.html` | Dashboard shell |
| `styles.css` | Theme (dark, no dependencies) |
| `data.js` | Seed data — swap for live API calls when the store backend is ready |
| `app.js` | All dashboard logic |

## Next steps

- Wire `data.js` to the real Adonai Store backend (orders/inventory API)
- Add authentication for staff roles
