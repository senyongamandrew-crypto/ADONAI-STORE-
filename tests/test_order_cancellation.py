"""Order-cancellation regressions for the Fulfillment & Orders panel.

Cancelling a customer's order from the panel must never fail: staff cancel
unwanted or wrongly-entered orders every day. Locks in:

  * cancelling unpaid, cash-paid, online-paid and consignment web orders all
    succeed and restore stock exactly once;
  * a retry after a cancel never double-restocks;
  * the server never answers the cancel with an Internal Server Error.

Run: python -m unittest discover -s tests -p test_order_cancellation.py -v
"""
import json
import os
from datetime import datetime, timedelta
from pathlib import Path
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
_TEMP = tempfile.TemporaryDirectory(prefix="adonai-cancel-tests-")
os.environ.update({
    "DATABASE_URL": "sqlite:///" + str(Path(_TEMP.name) / "cancel.db"),
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
    AccountingJournalEntry, AccountingJournalLine, ConsignmentPartner, ConsignmentPayout,
    Inventory, InventoryLock, LedgerEntry, NotificationEvent,
    Order, OrderItem, Product, ProductMedia, StoreSetting,
)
import access_control
import api

PHOTO = "data:image/jpeg;base64,YWJj"


class OrderCancellationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        assert init_db(), "Isolated cancellation schema failed to initialize"

    def setUp(self):
        with get_db() as session:
            for model in (OrderItem, ConsignmentPayout, InventoryLock, Inventory, ProductMedia,
                          Order, Product, ConsignmentPartner, LedgerEntry,
                          AccountingJournalLine, AccountingJournalEntry, NotificationEvent):
                session.query(model).delete(synchronize_session=False)
            session.query(StoreSetting).filter_by(key=access_control.POLICY_KEY).delete()
            session.add(Product(
                id="CAN-ITEM-1", sku="CAN-1", barcode_id="CAN-1",
                name="Step Aspire. Windbreaker Jacket", brand="Step Aspire",
                demographic="Men", category="Jackets", size="M",
                item_condition="BRAND_NEW", quantity_type="BRAND_NEW",
                base_price=25000, total_transport_cost=10000, selling_price=30000,
                in_stock_count=2,
            ))

    def raw(self, method, path, body=None, headers=None, query_params=None):
        encoded = json.dumps(body).encode("utf-8") if body is not None else b""
        return api.handle_api_request(method, path, query_params or {}, encoded, headers=headers or {}, client_addr="cancel-tests")

    def request(self, method, path, body=None, headers=None, query_params=None):
        result = self.raw(method, path, body, headers, query_params)
        try:
            data = json.loads(result[2])
        except (TypeError, json.JSONDecodeError):
            data = {}
        return result[0], data

    def place_web_order(self, order_id, *, payment_method=None, qty=1):
        body = {
            "id": order_id, "channel": "web",
            "items": [{"product_id": "CAN-ITEM-1", "qty": qty}],
            "customer_name": "Test Shopper", "customer_phone": "0758873398",
            "delivery_type": "boda", "delivery_area": "Bwaise / Kawempe / Kisaasi",
            "delivery_address": "Kawempe, off the main road",
        }
        if payment_method:
            body["payment_method"] = payment_method
            body["payer_account"] = "0758873398"
        status, data = self.request("POST", "/api/orders", body)
        self.assertEqual(status, 201, data)
        return data

    def cancel(self, order_id):
        return self.request("PATCH", f"/api/orders/{order_id}", {"fulfillment_status": "Cancelled"})

    def stock(self):
        with get_db() as session:
            return int(session.query(Product).filter_by(id="CAN-ITEM-1").one().in_stock_count or 0)

    # ------------------------------------------------------------------ 1
    def test_cancel_unpaid_cod_web_order_restores_stock(self):
        self.place_web_order("CAN-COD-1")
        self.assertEqual(self.stock(), 1)
        status, data = self.cancel("CAN-COD-1")
        self.assertEqual(status, 200, data)
        self.assertTrue(data.get("ok"), data)
        self.assertEqual(data["order"]["dispatch_status"], "Cancelled")
        self.assertEqual(data.get("stock_restored_units"), 1)
        self.assertEqual(self.stock(), 2)

    # ------------------------------------------------------------------ 2
    def test_cancel_cash_paid_web_order(self):
        # The screenshot case: a web order staff marked PAID via cash on
        # delivery, then cancelled as unwanted.
        placed = self.place_web_order("CAN-CASH-1")
        self.assertEqual(placed["order"]["payment"]["status"], "unpaid")
        status, paid = self.request("POST", "/api/orders/CAN-CASH-1/payment",
                                    {"paid": True, "payment_method": "cash"})
        self.assertEqual(status, 200, paid)
        self.assertEqual(paid.get("payment_status"), "paid")

        status, data = self.cancel("CAN-CASH-1")
        self.assertEqual(status, 200, data)
        self.assertEqual(data["order"]["dispatch_status"], "Cancelled")
        self.assertEqual(self.stock(), 2)

    # ------------------------------------------------------------------ 3
    def test_cancel_online_pending_order(self):
        placed = self.place_web_order("CAN-MOMO-1", payment_method="momo")
        self.assertEqual(placed["order"]["payment"]["status"], "pending")
        status, data = self.cancel("CAN-MOMO-1")
        self.assertEqual(status, 200, data)
        self.assertEqual(data["order"]["dispatch_status"], "Cancelled")
        self.assertEqual(self.stock(), 2)

    # ------------------------------------------------------------------ 4
    def test_cancel_confirmed_momo_order(self):
        self.place_web_order("CAN-MOMO-2", payment_method="momo")
        status, paid = self.request("POST", "/api/orders/CAN-MOMO-2/payment",
                                    {"paid": True, "payment_method": "mtn",
                                     "reference": "MM261122.1430.A12345"})
        self.assertEqual(status, 200, paid)
        self.assertEqual(paid.get("payment_status"), "paid")
        status, data = self.cancel("CAN-MOMO-2")
        self.assertEqual(status, 200, data)
        self.assertEqual(data["order"]["dispatch_status"], "Cancelled")
        self.assertEqual(self.stock(), 2)

    # ------------------------------------------------------------------ 5
    def test_cancel_from_in_assembly(self):
        self.place_web_order("CAN-ASM-1")
        status, moved = self.request("PATCH", "/api/orders/CAN-ASM-1",
                                     {"fulfillment_status": "In Assembly"})
        self.assertEqual(status, 200, moved)
        status, data = self.cancel("CAN-ASM-1")
        self.assertEqual(status, 200, data)
        self.assertEqual(self.stock(), 2)

    # ------------------------------------------------------------------ 6
    def test_cancel_retry_restores_stock_only_once(self):
        self.place_web_order("CAN-RETRY-1")
        status, first = self.cancel("CAN-RETRY-1")
        self.assertEqual(status, 200, first)
        self.assertEqual(self.stock(), 2)
        status, second = self.cancel("CAN-RETRY-1")
        self.assertIn(status, (200, 409), second)
        self.assertEqual(self.stock(), 2, "a retried cancel must never restore stock twice")

    # ------------------------------------------------------------------ 7
    def test_cancel_consignment_web_order(self):
        status, partner = self.request("POST", "/api/consignment/partners", {
            "name": "Kampala Vintage Supply", "phone": "+256700111222",
            "whatsapp": "+256700111222", "address": "Kampala Central",
            "payout_provider": "MTN MoMo", "payout_account_name": "Vintage Supply",
            "payout_account": "256700111222", "region": "Central",
            "supply_source": "Kampala bale market",
        })
        self.assertEqual(status, 201, partner)
        with get_db() as session:
            session.add(ProductMedia(
                id="c" * 32, product_id=None, kind="video", mime_type="video/mp4",
                filename="garment.mp4", byte_length=10, width=480, height=640,
                duration=18.0, data=b"test-video", uploaded_by="OPEN-TERMINAL",
            ))
        status, created = self.request("POST", "/api/products", {
            "id": "CAN-CONS-1", "sku": "CAN-CONS-SKU", "barcode_id": "CAN-CONS-SKU-1OF1",
            "name": "Vintage denim jacket", "brand": "Curated", "demographic": "Women",
            "category": "Outerwear & Jackets", "size": "M",
            "inventory_source": "partner", "consignment_partner_id": partner["partner"]["id"],
            "item_condition": "PRE_LOVED", "quantity_type": "PRE_LOVED",
            "in_stock_count": 1, "cost_price": 0, "base_price": 50000,
            "total_transport_cost": 0, "image_url": PHOTO, "images": [PHOTO],
            "video_id": "c" * 32, "video_duration": 18,
        })
        self.assertEqual(status, 201, created)

        status, placed = self.request("POST", "/api/orders", {
            "id": "CAN-CONS-ORDER", "channel": "web",
            "items": [{"product_id": "CAN-CONS-1", "qty": 1}],
            "customer_name": "Test Shopper", "customer_phone": "0758873398",
            "delivery_type": "boda", "delivery_area": "Kampala Central / Nakasero",
            "delivery_address": "Plot 5 Salama Road",
        })
        self.assertEqual(status, 201, placed)
        status, data = self.cancel("CAN-CONS-ORDER")
        self.assertEqual(status, 200, data)
        self.assertEqual(data["order"]["dispatch_status"], "Cancelled")

    # ------------------------------------------------------------------ 8
    def add_preloved(self, product_id, stock):
        with get_db() as session:
            session.add(Product(
                id=product_id, sku=product_id, barcode_id=product_id,
                name="Vintage windbreaker", brand="Step Aspire", demographic="Men",
                category="Jackets", size="M", item_condition="PRE_LOVED",
                quantity_type="PRE_LOVED", base_price=25000,
                total_transport_cost=10000, selling_price=30000,
                in_stock_count=stock,
            ))

    def test_cancel_preloved_multi_stock_order_never_500s(self):
        # The reported crash: a one-of-one pre-loved piece whose row still
        # carried more than one unit (legacy stock). The database refuses any
        # update that leaves a PRE_LOVED row above 1 unit, and the old restore
        # added the sold unit straight back — the cancel died with a bare 500
        # and staff could not remove the unwanted order at all.
        self.add_preloved("CAN-PRE-1", 2)
        status, placed = self.request("POST", "/api/orders", {
            "id": "CAN-PRE-ORDER", "channel": "web",
            "items": [{"product_id": "CAN-PRE-1", "qty": 1}],
            "customer_name": "Test Shopper", "customer_phone": "0758873398",
            "delivery_type": "boda", "delivery_area": "Bwaise / Kawempe / Kisaasi",
            "delivery_address": "Kawempe, off the main road",
        })
        self.assertEqual(status, 201, placed)
        status, data = self.cancel("CAN-PRE-ORDER")
        self.assertEqual(status, 200, f"{data} — cancel must never answer with an Internal Server Error")
        self.assertEqual(data["order"]["dispatch_status"], "Cancelled")
        with get_db() as session:
            count = int(session.query(Product).filter_by(id="CAN-PRE-1").one().in_stock_count or 0)
        self.assertLessEqual(count, 1, "a one-of-one piece must never be restored above 1 unit")

    def test_cancel_preloved_one_of_one_restores_the_piece(self):
        self.add_preloved("CAN-PRE-2", 1)
        status, placed = self.request("POST", "/api/orders", {
            "id": "CAN-PRE-ORDER-2", "channel": "web",
            "items": [{"product_id": "CAN-PRE-2", "qty": 1}],
            "customer_name": "Test Shopper", "customer_phone": "0758873398",
            "delivery_type": "pickup",
        })
        self.assertEqual(status, 201, placed)
        status, data = self.cancel("CAN-PRE-ORDER-2")
        self.assertEqual(status, 200, data)
        with get_db() as session:
            count = int(session.query(Product).filter_by(id="CAN-PRE-2").one().in_stock_count or 0)
        self.assertEqual(count, 1, "the one-of-one piece is back on the rack")

    def test_expiry_restore_respects_one_of_one(self):
        # The same landmine sat in expire_stale_flutterwave_orders, which runs
        # inside every orders fetch and every sync pull — a raise there takes
        # the whole Fulfillment & Orders feed down with it.
        self.add_preloved("CAN-PRE-3", 2)
        status, placed = self.request("POST", "/api/orders", {
            "id": "CAN-PRE-ORDER-3", "channel": "web",
            "items": [{"product_id": "CAN-PRE-3", "qty": 1}],
            "customer_name": "Test Shopper", "customer_phone": "0758873398",
            "delivery_type": "boda", "delivery_area": "Kampala Central / Nakasero",
            "delivery_address": "Plot 5 Salama Road",
            "payment_method": "momo", "payer_account": "0758873398",
        })
        self.assertEqual(status, 201, placed)
        with get_db() as session:
            expired = api.expire_stale_flutterwave_orders(
                session, now=datetime.utcnow() + timedelta(hours=4))
            self.assertEqual(expired, 1)
            session.flush()
            row = session.query(Order).filter_by(id="CAN-PRE-ORDER-3").one()
            self.assertEqual(row.status, "cancelled")
            count = int(session.query(Product).filter_by(id="CAN-PRE-3").one().in_stock_count or 0)
        self.assertLessEqual(count, 1, "expiry must never restore a one-of-one piece above 1 unit")


if __name__ == "__main__":
    unittest.main()
