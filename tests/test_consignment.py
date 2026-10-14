"""Regression coverage for Source B dynamic consignment inventory.
Run: python -m unittest discover -s tests -p test_consignment.py -v
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
_TEMP = tempfile.TemporaryDirectory(prefix="adonai-consignment-tests-")
os.environ.update({
    "DATABASE_URL": "sqlite:///" + str(Path(_TEMP.name) / "consignment.db"),
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
    AccountingJournalEntry, AccountingJournalLine, ConsignmentPartner,
    ConsignmentPayout, Inventory, InventoryLock, LedgerEntry, NotificationEvent,
    Order, OrderItem, Product, ProductMedia, StoreSetting,
)
import access_control
import api


PHOTO = "data:image/jpeg;base64,YWJj"


class ConsignmentTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        assert init_db(), "Isolated consignment schema failed to initialize"

    def setUp(self):
        with get_db() as session:
            for model in (OrderItem, ConsignmentPayout, InventoryLock, Inventory, ProductMedia,
                          Order, Product, ConsignmentPartner, LedgerEntry,
                          AccountingJournalLine, AccountingJournalEntry, NotificationEvent):
                session.query(model).delete(synchronize_session=False)
            session.query(StoreSetting).filter_by(key=access_control.POLICY_KEY).delete()

    def raw(self, method, path, body=None, headers=None, query_params=None):
        encoded = json.dumps(body).encode("utf-8") if body is not None else b""
        return api.handle_api_request(method, path, query_params or {}, encoded, headers=headers or {}, client_addr="consignment-tests")

    def request(self, method, path, body=None, headers=None, query_params=None):
        result = self.raw(method, path, body, headers, query_params)
        try:
            data = json.loads(result[2])
        except (TypeError, json.JSONDecodeError):
            data = {}
        return result[0], data

    def create_partner(self, **extra):
        payload = {
            "name": "Kampala Vintage Supply", "phone": "+256700111222",
            "whatsapp": "+256700111222", "address": "Kampala Central",
            "payout_provider": "MTN MoMo", "payout_account_name": "Vintage Supply",
            "payout_account": "256700111222", "region": "Central",
            "supply_source": "Kampala bale market",
        }
        payload.update(extra)
        status, data = self.request("POST", "/api/consignment/partners", payload)
        self.assertEqual(status, 201, data)
        return data["partner"]

    def add_video(self, suffix="a", duration=18.0):
        asset_id = (suffix * 32)[:32]
        with get_db() as session:
            session.add(ProductMedia(
                id=asset_id, product_id=None, kind="video", mime_type="video/mp4",
                filename="garment.mp4", byte_length=10, width=480, height=640,
                duration=duration, data=b"test-video", uploaded_by="OPEN-TERMINAL",
            ))
        return asset_id

    def intake_consignment(self, partner_id, *, product_id=None, sku=None, video_id=None, **extra):
        body = {
            "id": product_id or "CONS-ITEM-1",
            "sku": sku or "CONS-SKU-1",
            "barcode_id": (sku or "CONS-SKU-1") + "-1OF1",
            "name": "Vintage denim jacket",
            "brand": "Curated",
            "demographic": "Women",
            "category": "Outerwear & Jackets",
            "size": "M",
            "inventory_source": "partner",
            "consignment_partner_id": partner_id,
            "item_condition": "PRE_LOVED",
            "quantity_type": "PRE_LOVED",
            "in_stock_count": 1,
            "cost_price": 0,
            "base_price": 50000,
            "total_transport_cost": 0,
            "image_url": PHOTO,
            "images": [PHOTO],
            "video_id": video_id or self.add_video(),
            "video_duration": 18,
        }
        body.update(extra)
        return self.request("POST", "/api/products", body)

    def test_partner_default_rate_intake_validation_and_ownership_protections(self):
        partner = self.create_partner()
        self.assertEqual(partner["default_commission_rate"], 5.0)
        status, choices = self.request("GET", "/api/consignment/partners/choices")
        self.assertEqual(status, 200)
        self.assertEqual([row["id"] for row in choices["partners"]], [partner["id"]])

        clip_id = self.add_video("b")
        status, missing_photo = self.request("POST", "/api/products", {
            "name": "No-photo item", "inventory_source": "partner",
            "consignment_partner_id": partner["id"], "base_price": 50000,
            "in_stock_count": 1, "video_id": clip_id,
        })
        self.assertEqual(status, 400)
        self.assertIn("photo", missing_photo["error"].lower())

        too_short = self.add_video("c", duration=14.99)
        status, invalid_video = self.intake_consignment(partner["id"], product_id="CONS-BAD-VIDEO", video_id=too_short)
        self.assertEqual(status, 400)
        self.assertIn("15 to 20", invalid_video["error"])

        status, created = self.intake_consignment(partner["id"], video_id=clip_id)
        self.assertEqual(status, 201, created)
        product = created["product"]
        self.assertTrue(product["is_consignment"])
        self.assertEqual(product["item_condition"], "PRE_LOVED")
        self.assertEqual(product["quantity_type"], "PRE_LOVED")
        self.assertEqual(product["in_stock_count"], 1)
        self.assertEqual(product["base_price"], 50000)
        self.assertEqual(product["total_transport_cost"], 0)
        self.assertEqual(product["cost_price"], 0)
        self.assertEqual(product["video"]["duration"], 18.0)

        for payload in (
            {"consignment_partner_id": "OTHER"},
            {"item_condition": "BRAND_NEW"},
            {"in_stock_count": 2},
            {"cost_price": 1000},
        ):
            status, error = self.request("PATCH", "/api/products/" + product["id"], payload)
            self.assertEqual(status, 400, (payload, error))
        status, error = self.request("DELETE", "/api/products/" + product["id"], {"mode": "permanent"})
        self.assertEqual(status, 409, error)

    def test_pos_sale_snapshots_commission_stock_and_idempotent_payout(self):
        partner = self.create_partner(default_commission_rate=5)
        status, created = self.intake_consignment(partner["id"])
        self.assertEqual(status, 201, created)
        product_id = created["product"]["id"]

        status, rate = self.request("PATCH", f"/api/consignment/products/{product_id}/commission", {"commission_rate": 12.5})
        self.assertEqual(status, 200, rate)
        self.assertEqual(rate["effective_commission_rate"], 12.5)

        owner = "REGISTER-CONS-1"
        status, acquired = self.request("POST", f"/api/inventory-locks/{product_id}/acquire", {
            "product_id": product_id, "lock_owner": owner, "quantity": 1,
        })
        self.assertEqual(status, 200, acquired)
        status, sale = self.request("POST", "/api/orders", {
            "id": "CONS-SALE-001", "channel": "pos", "lock_owner": owner,
            "items": [{"product_id": product_id, "qty": 1}],
            "tender": {"type": "cash", "tendered": 50000, "change": 0},
            "cashier": {"id": "CASHIER-1", "name": "Cashier"},
        })
        self.assertEqual(status, 201, sale)

        with get_db() as session:
            product = session.get(Product, product_id)
            order = session.get(Order, "CONS-SALE-001")
            item = session.query(OrderItem).filter_by(order_id=order.id).one()
            self.assertEqual(product.in_stock_count, 0)
            self.assertEqual(item.consignment_partner_id, partner["id"])
            self.assertEqual(item.partner_name_snapshot, partner["name"])
            self.assertEqual(float(item.commission_rate_snapshot), 12.5)
            self.assertEqual(item.consignment_gross_amount, 50000)
            self.assertEqual(item.consignment_commission_amount, 6250)
            self.assertEqual(item.partner_payable_amount, 43750)
            self.assertEqual(item.unit_cost, 0)
            entry = session.query(AccountingJournalEntry).filter_by(reference=order.id, source="pos_sale").one()
            lines = session.query(AccountingJournalLine).filter_by(journal_entry_id=entry.id).all()
            credits = {line.account_code: line.credit for line in lines if line.credit}
            self.assertEqual(credits["4200"], 6250)
            self.assertEqual(credits["2100"], 43750)
            self.assertNotIn("5000", {line.account_code for line in lines})

        # Later profile and rate edits never rewrite the captured sale split.
        self.request("PATCH", f"/api/consignment/products/{product_id}/commission", {"commission_rate": 1})
        self.request("PATCH", f"/api/consignment/partners/{partner['id']}", {"default_commission_rate": 30})
        with get_db() as session:
            item = session.query(OrderItem).filter_by(order_id="CONS-SALE-001").one()
            self.assertEqual(float(item.commission_rate_snapshot), 12.5)
            self.assertEqual(item.consignment_commission_amount, 6250)
            self.assertEqual(item.partner_payable_amount, 43750)

        payout = {"amount": 10000, "payment_method": "mobile_money", "idempotency_key": "payout-once"}
        status, first = self.request("POST", f"/api/consignment/partners/{partner['id']}/payouts", payout)
        self.assertEqual(status, 201, first)
        self.assertEqual(first["payable_balance"], 33750)
        status, replay = self.request("POST", f"/api/consignment/partners/{partner['id']}/payouts", payout)
        self.assertEqual(status, 200, replay)
        self.assertTrue(replay["idempotent_replay"])
        self.assertEqual(replay["payable_balance"], 33750)
        status, too_much = self.request("POST", f"/api/consignment/partners/{partner['id']}/payouts", {
            "amount": 40000, "payment_method": "cash", "idempotency_key": "too-much",
        })
        self.assertEqual(status, 409, too_much)

        status, detail = self.request("GET", f"/api/consignment/partners/{partner['id']}")
        self.assertEqual(status, 200, detail)
        self.assertTrue(detail["partner"]["active"])
        self.assertEqual(detail["metrics"]["submitted"], 1)
        self.assertEqual(detail["metrics"]["active_inventory"], 0)
        self.assertEqual(detail["metrics"]["gross_revenue"], 50000)
        self.assertEqual(detail["metrics"]["commission_earned"], 6250)
        self.assertEqual(detail["items"][0]["gross_revenue"], 50000)
        self.assertEqual(detail["items"][0]["commission_earned"], 6250)
        self.assertEqual(detail["metrics"]["payable_earned"], 43750)
        self.assertEqual(detail["metrics"]["payable_balance"], 33750)
        self.assertEqual(len(detail["payouts"]), 1)

        status, overview = self.request("GET", "/api/consignment/dashboard")
        self.assertEqual(status, 200, overview)
        self.assertEqual(overview["summary"]["active_partners"], 1)
        self.assertEqual(overview["summary"]["payouts_total"], 10000)
        self.assertEqual(overview["recent_payouts"][0]["partner_name"], partner["name"])
        filtered_status, filtered = self.request("GET", "/api/consignment/dashboard", query_params={"region": ["Northern"]})
        self.assertEqual(filtered_status, 200, filtered)
        self.assertEqual(filtered["summary"]["partners"], 0)
        self.assertEqual(filtered["recent_payouts"], [])

        status, finance = self.request("GET", "/api/finance/dashboard")
        self.assertEqual(status, 200, finance)
        self.assertEqual(finance["metrics"]["gross_profit"], 6250)
        self.assertEqual(finance["metrics"]["consignment_payables"], 43750)

        # Finance-locked staff can see the sale line, never its partner identity
        # or settlement amounts; cashier catalog still keeps the minimal badge.
        with get_db() as session:
            session.add(StoreSetting(key=access_control.POLICY_KEY, value=json.dumps(["finance"])))
        status, history = self.request("GET", "/api/orders")
        self.assertEqual(status, 200)
        sale_item = history["orders"][0]["items"][0]
        for private_key in ("consignment_partner_id", "partner_name_snapshot", "commission_rate_snapshot",
                            "consignment_gross_amount", "consignment_commission_amount", "partner_payable_amount"):
            self.assertNotIn(private_key, sale_item)
        status, catalog = self.request("GET", "/api/products/" + product_id)
        self.assertEqual(status, 200)
        self.assertTrue(catalog["product"]["is_consignment"])

    def test_mixed_partner_checkout_posts_partner_scoped_payable_lines(self):
        partner_a = self.create_partner(name="Partner A", default_commission_rate=5)
        partner_b = self.create_partner(name="Partner B", default_commission_rate=20, region="Eastern")
        status, item_a = self.intake_consignment(
            partner_a["id"], product_id="CONS-MIX-A", sku="CONS-MIX-SKU-A", video_id=self.add_video("d"))
        self.assertEqual(status, 201, item_a)
        status, item_b = self.intake_consignment(
            partner_b["id"], product_id="CONS-MIX-B", sku="CONS-MIX-SKU-B", video_id=self.add_video("e"))
        self.assertEqual(status, 201, item_b)
        product_a, product_b = item_a["product"]["id"], item_b["product"]["id"]
        owner = "REGISTER-MIXED-CONS"
        for product_id in (product_a, product_b):
            status, _ = self.request("POST", f"/api/inventory-locks/{product_id}/acquire", {
                "product_id": product_id, "lock_owner": owner, "quantity": 1,
            })
            self.assertEqual(status, 200)
        status, sale = self.request("POST", "/api/orders", {
            "id": "CONS-MIXED-SALE", "channel": "pos", "lock_owner": owner,
            "items": [{"product_id": product_a, "qty": 1}, {"product_id": product_b, "qty": 1}],
            "tender": {"type": "cash", "tendered": 100000, "change": 0},
        })
        self.assertEqual(status, 201, sale)
        with get_db() as session:
            entry = session.query(AccountingJournalEntry).filter_by(reference="CONS-MIXED-SALE", source="pos_sale").one()
            payable_lines = session.query(AccountingJournalLine).filter_by(
                journal_entry_id=entry.id, account_code="2100").all()
            by_memo = {line.memo: line.credit for line in payable_lines}
            self.assertEqual(len(payable_lines), 2)
            self.assertEqual(by_memo[f"Partner: Partner A ({partner_a['id']})"], 47500)
            self.assertEqual(by_memo[f"Partner: Partner B ({partner_b['id']})"], 40000)
            commission_lines = session.query(AccountingJournalLine).filter_by(
                journal_entry_id=entry.id, account_code="4200").all()
            self.assertEqual({line.memo: line.credit for line in commission_lines}, {
                f"Partner: Partner A ({partner_a['id']})": 2500,
                f"Partner: Partner B ({partner_b['id']})": 10000,
            })
        status, dashboard = self.request("GET", "/api/consignment/dashboard")
        self.assertEqual(status, 200, dashboard)
        self.assertEqual(dashboard["summary"]["payable_balance"], 87500)
        self.assertEqual(dashboard["summary"]["inventory_turnover_pct"], 100.0)
        status, eastern = self.request("GET", "/api/consignment/dashboard", query_params={"region": ["Eastern"]})
        self.assertEqual(status, 200, eastern)
        self.assertEqual([row["id"] for row in eastern["partners"]], [partner_b["id"]])
        self.assertEqual(eastern["summary"]["payable_balance"], 40000)

    def test_cancel_reversals_restore_consignment_stock_once(self):
        partner = self.create_partner()
        status, created = self.intake_consignment(partner["id"])
        self.assertEqual(status, 201, created)
        product_id = created["product"]["id"]
        status, sale = self.request("POST", "/api/orders", {
            "id": "CONS-CANCEL-001", "channel": "web", "delivery_type": "pickup",
            "items": [{"product_id": product_id, "qty": 1}],
        })
        self.assertEqual(status, 201, sale)
        status, cancelled = self.request("PATCH", "/api/orders/CONS-CANCEL-001", {"fulfillment_status": "Cancelled"})
        self.assertEqual(status, 200, cancelled)
        self.assertEqual(cancelled["stock_restored_units"], 1)
        status, replay = self.request("PATCH", "/api/orders/CONS-CANCEL-001", {"fulfillment_status": "Cancelled"})
        self.assertEqual(status, 200, replay)
        self.assertEqual(replay["stock_restored_units"], 0)
        with get_db() as session:
            self.assertEqual(session.get(Product, product_id).in_stock_count, 1)
            originals = session.query(AccountingJournalEntry).filter_by(reference="CONS-CANCEL-001", source="web_sale").count()
            reversals = session.query(AccountingJournalEntry).filter_by(source="consignment_cancellation_reversal").count()
            self.assertEqual(originals, 1)
            self.assertEqual(reversals, 1)
            self.assertEqual(session.query(ConsignmentPayout).count(), 0)

    def test_online_pending_reclassification_and_reversals_are_idempotent(self):
        partner = self.create_partner()
        now = datetime.utcnow()
        with get_db() as session:
            pending_order = Order(
                id="CONS-ONLINE-001", channel="web", status="unfulfilled",
                dispatch_status="Unfulfilled", subtotal=50000, total=50000,
                tender_type="flutterwave", payment_status="pending", created_at=now,
            )
            session.add(pending_order)
            session.flush()
            item = OrderItem(
                id="CONS-ONLINE-ITEM", order_id=pending_order.id, name="Online partner item",
                unit_price=50000, unit_cost=0, category="Outerwear", qty=1, line_total=50000,
                consignment_partner_id=partner["id"], partner_name_snapshot=partner["name"],
                commission_rate_snapshot=5, consignment_gross_amount=50000,
                consignment_commission_amount=2500, partner_payable_amount=47500,
            )
            session.add(item)
            session.flush()
            sale_lines = api.sale_journal_lines(50000, 0, "flutterwave", 0, 50000, 2500, 47500, consignment_pending=True)
            api.create_journal_entry(session, reference=pending_order.id, source="web_sale",
                description="Pending online consignment sale", occurred_at=now, staff={}, lines=sale_lines)
            session.flush()
            pending_lines = session.query(AccountingJournalLine).join(AccountingJournalEntry).filter(
                AccountingJournalEntry.reference == pending_order.id,
                AccountingJournalEntry.source == "web_sale",
            ).all()
            self.assertEqual(sum(line.credit for line in pending_lines if line.account_code == "2110"), 50000)

            pending_order.payment_status = "paid"
            posted = api.post_pending_consignment_settlement(session, pending_order, {"id": "WEB", "name": "Online"}, now)
            replay = api.post_pending_consignment_settlement(session, pending_order, {"id": "WEB", "name": "Online"}, now)
            self.assertEqual(posted.id, replay.id)
            settled = session.query(AccountingJournalLine).filter_by(journal_entry_id=posted.id).all()
            credits = {line.account_code: line.credit for line in settled if line.credit}
            self.assertEqual(credits["4200"], 2500)
            self.assertEqual(credits["2100"], 47500)
            first_reversals = api.reverse_consignment_order_journals(session, pending_order, reason="Test cancellation", occurred_at=now)
            second_reversals = api.reverse_consignment_order_journals(session, pending_order, reason="Retry cancellation", occurred_at=now)
            self.assertEqual(len(first_reversals), 2)
            self.assertEqual(second_reversals, [])
            self.assertEqual(session.query(AccountingJournalEntry).filter_by(
                source="consignment_cancellation_reversal").count(), 2)


if __name__ == "__main__":
    unittest.main()
