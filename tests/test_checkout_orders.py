"""Checkout regressions for the order pipeline.

Locks in three guarantees:
  1. A customer's single confirmation places the order — pay-on-delivery needs
     nothing else and the order lands in the Fulfillment & Orders feed
     (/api/sync/pull + /api/orders) immediately.
  2. Pay-on-delivery orders are never auto-expired out of the queue.
  3. The delivery fee is ONE charge per order (the highest single-piece
     transport share), never multiplied per piece or per quantity — and the
     transport/sales journal split mirrors the charge so it always balances.

Run: python -m unittest discover -s tests -p test_checkout_orders.py -v
"""
from datetime import datetime
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
_TEMP = tempfile.TemporaryDirectory(prefix="adonai-checkout-tests-")
os.environ.update({
    "DATABASE_URL": "sqlite:///" + str(Path(_TEMP.name) / "checkout.db"),
    "ADONAI_REQUIRE_STAFF_AUTH": "0",
    "ADONAI_RATE_LIMIT_DISABLED": "1",
    "ADONAI_SEED_DEMO_CATALOG": "0",
    "ADONAI_SEED_DEMO_USERS": "0",
})
import database
database.IS_POSTGRES = False
from database import get_db
from db_init import init_db
from models import (
    AccountingJournalEntry, AccountingJournalLine, ConsignmentPayout,
    Inventory, InventoryLock, LedgerEntry, NotificationEvent,
    Order, OrderItem, Product, ProductMedia, StoreSetting,
)
import access_control
import api


# Pieces with real transport costs so the 50/50 allocation is exercised:
#   A: base 20000 + transport 6000 -> embedded 3000, checkout 3000, sells 23000
#   B: base 40000 + transport 10000 -> embedded 5000, checkout 5000, sells 45000
PIECES = [
    dict(id="FEE-ITEM-A", sku="FEE-A", barcode_id="FEE-A", name="Denim jacket",
         base_price=20000, total_transport_cost=6000, selling_price=23000),
    dict(id="FEE-ITEM-B", sku="FEE-B", barcode_id="FEE-B", name="Leather boots",
         base_price=40000, total_transport_cost=10000, selling_price=45000),
]


class CheckoutOrdersTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        assert init_db(), "Isolated checkout schema failed to initialize"

    def setUp(self):
        with get_db() as session:
            for model in (OrderItem, ConsignmentPayout, InventoryLock, Inventory, ProductMedia,
                          Order, Product, LedgerEntry,
                          AccountingJournalLine, AccountingJournalEntry, NotificationEvent):
                session.query(model).delete(synchronize_session=False)
            session.query(StoreSetting).filter_by(key=access_control.POLICY_KEY).delete()
            for piece in PIECES:
                session.add(Product(
                    id=piece["id"], sku=piece["sku"], barcode_id=piece["barcode_id"],
                    name=piece["name"], brand="Adonai", demographic="Men",
                    category="Jackets", size="M", item_condition="PRE_LOVED",
                    quantity_type="PRE_LOVED", base_price=piece["base_price"],
                    total_transport_cost=piece["total_transport_cost"],
                    selling_price=piece["selling_price"], in_stock_count=10,
                ))

    def raw(self, method, path, body=None, headers=None, query_params=None):
        encoded = json.dumps(body).encode("utf-8") if body is not None else b""
        return api.handle_api_request(method, path, query_params or {}, encoded, headers=headers or {}, client_addr="checkout-tests")

    def request(self, method, path, body=None, headers=None, query_params=None):
        result = self.raw(method, path, body, headers, query_params)
        try:
            data = json.loads(result[2])
        except (TypeError, json.JSONDecodeError):
            data = {}
        return result[0], data

    def place_web_order(self, order_id, items, *, delivery_type="boda", payment_method=None):
        body = {
            "id": order_id, "channel": "web",
            "items": [{"product_id": pid, "qty": qty} for pid, qty in items],
            "customer_name": "Test Shopper", "customer_phone": "0758873398",
            "delivery_type": delivery_type, "delivery_area": "Kampala Central / Nakasero",
            "delivery_address": "Plot 5 Salama Road",
        }
        if payment_method:
            body["payment_method"] = payment_method
            body["payer_account"] = "0758873398"
        return self.request("POST", "/api/orders", body)

    # ------------------------------------------------------------------ 1
    def test_one_delivery_fee_per_order_not_per_piece_or_quantity(self):
        # Two different pieces (qty 2 + qty 1): ONE fee — the higher single
        # piece share (B: 5000) — not a fee per piece (3000+5000) and not
        # multiplied by quantity (2x3000 + 5000).
        status, placed = self.place_web_order("FEE-ORDER-1", [("FEE-ITEM-A", 2), ("FEE-ITEM-B", 1)])
        self.assertEqual(status, 201, placed)
        order = placed["order"]
        self.assertEqual(order["subtotal"], 91000)
        self.assertEqual(order["delivery_fee"], 5000,
                         "multi-piece orders pay the highest single-piece fee once")
        self.assertEqual(order["total"], 96000)

        # Quantity never multiplies the fee: three of the same piece = one fee.
        status, qty_order = self.place_web_order("FEE-ORDER-2", [("FEE-ITEM-A", 3)])
        self.assertEqual(status, 201, qty_order)
        self.assertEqual(qty_order["order"]["delivery_fee"], 3000,
                         "3 identical pieces still pay one delivery fee")
        self.assertEqual(qty_order["order"]["total"], 23000 * 3 + 3000)

        # Store pickup is free.
        status, pickup = self.place_web_order("FEE-ORDER-3", [("FEE-ITEM-A", 1), ("FEE-ITEM-B", 1)],
                                              delivery_type="pickup")
        self.assertEqual(status, 201, pickup)
        self.assertEqual(pickup["order"]["delivery_fee"], 0)
        self.assertEqual(pickup["order"]["total"], 23000 + 45000)

    # ------------------------------------------------------------------ 2
    def test_journal_split_mirrors_the_single_fee_and_balances(self):
        status, placed = self.place_web_order("FEE-JRN-1", [("FEE-ITEM-A", 2), ("FEE-ITEM-B", 1)])
        self.assertEqual(status, 201, placed)
        with get_db() as session:
            entry = session.query(AccountingJournalEntry).filter_by(
                reference="FEE-JRN-1", source="web_sale").one()
            rows = session.query(AccountingJournalLine).filter_by(journal_entry_id=entry.id).all()
            lines = [(str(line.account_code), int(line.debit or 0), int(line.credit or 0)) for line in rows]
        debit = sum(line[1] for line in lines)
        credit = sum(line[2] for line in lines)
        self.assertEqual(debit, 96000)
        self.assertEqual(debit, credit, "the sale journal must balance")

        credits = {code: cr for code, _dr, cr in lines if cr}
        # Transport revenue = embedded halves actually in the prices
        # (2x3000 + 5000) + the one collected delivery fee (5000).
        self.assertEqual(credits.get("4100"), 11000 + 5000)
        # Product revenue = the base-price portion.
        self.assertEqual(credits.get("4000"), 20000 * 2 + 40000)

    # ------------------------------------------------------------------ 3
    def test_cod_confirmation_is_the_whole_order_and_never_expires(self):
        status, placed = self.place_web_order("FEE-COD-1", [("FEE-ITEM-A", 1)])
        self.assertEqual(status, 201, placed)
        order = placed["order"]
        self.assertEqual(order["status"], "unfulfilled")
        self.assertEqual(order["dispatch_status"], "Unfulfilled")
        self.assertEqual(placed.get("payment", {}).get("token", ""), "",
                         "pay-on-delivery carries no payment step after confirming")

        with get_db() as session:
            row = session.query(Order).filter_by(id="FEE-COD-1").one()
            self.assertEqual(row.payment_status, "unpaid")
            self.assertIsNone(row.payment_expires_at,
                              "pay-on-delivery orders must never carry a payment deadline")
            # The expiry sweep runs on every orders fetch: a COD order must
            # survive it untouched — no stock release, no cancellation.
            self.assertEqual(api.expire_stale_flutterwave_orders(session), 0)
            session.flush()
            session.refresh(row)
            self.assertEqual(row.status, "unfulfilled")

        # The order is in the very feed the Fulfillment & Orders panel reads.
        status, sync = self.request("POST", "/api/sync/pull", {"if_revision": ""})
        self.assertEqual(status, 200, sync)
        feed_ids = [sale.get("id") for sale in sync.get("sales", [])]
        self.assertIn("FEE-COD-1", feed_ids, "the panel sync feed must carry the new order")
        fed = next(sale for sale in sync["sales"] if sale["id"] == "FEE-COD-1")
        self.assertEqual(fed["dispatch_status"], "Unfulfilled")

        status, ledger = self.request("GET", "/api/orders")
        self.assertEqual(status, 200, ledger)
        self.assertIn("FEE-COD-1", [sale.get("id") for sale in ledger.get("orders", [])])

    # ------------------------------------------------------------------ 4
    def test_online_payment_orders_keep_their_reserve_window(self):
        status, placed = self.place_web_order("FEE-MOMO-1", [("FEE-ITEM-A", 1)], payment_method="momo")
        self.assertEqual(status, 201, placed)
        self.assertEqual(placed["order"]["payment"]["status"], "pending")
        self.assertTrue(placed.get("payment", {}).get("token"),
                        "collect-now channels still issue their per-order payment token")
        with get_db() as session:
            row = session.query(Order).filter_by(id="FEE-MOMO-1").one()
            self.assertIsNotNone(row.payment_expires_at)
            # Unpaid inside its window: the sweep must leave it alone.
            self.assertEqual(api.expire_stale_flutterwave_orders(session), 0)
            session.flush()
            session.refresh(row)
            self.assertEqual(row.status, "unfulfilled")


if __name__ == "__main__":
    unittest.main()
