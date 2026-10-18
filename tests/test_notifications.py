"""Durable bell feed regressions. All writes use an isolated temporary DB.

Run: .venv/bin/python -m unittest discover -s tests -p test_notifications.py -v
"""
import ast
import concurrent.futures
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock
from urllib.parse import parse_qs, urlsplit

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
_TEMP = tempfile.TemporaryDirectory(prefix="adonai-notification-tests-")
TEST_DATABASE_URL = "sqlite:///" + str(Path(_TEMP.name) / "notifications.db")
os.environ.update({
    "DATABASE_URL": TEST_DATABASE_URL, "ADONAI_REQUIRE_STAFF_AUTH": "0",
    "ADONAI_RATE_LIMIT_DISABLED": "1", "ADONAI_SEED_DEMO_CATALOG": "0",
    "ADONAI_SEED_DEMO_USERS": "0",
})
from database import get_db, SessionFactory
from db_init import init_db
from models import NotificationEvent, NotificationStreamTicket, Product, Order, PosAccessKey, PosAccessSession, StoreSetting
import api
import access_control
import notifications


class NotificationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not init_db():
            raise RuntimeError("Isolated notification schema failed to initialize")

    def setUp(self):
        with get_db() as session:
            session.query(NotificationEvent).delete()
            session.query(NotificationStreamTicket).delete()
            session.query(PosAccessSession).delete()
            session.query(PosAccessKey).delete()
            session.query(StoreSetting).filter_by(key=access_control.POLICY_KEY).delete()

    def request(self, method, path, body=None, headers=None):
        url = urlsplit(path)
        status, _, response = api.handle_api_request(method, url.path, parse_qs(url.query),
            json.dumps(body).encode() if body is not None else b"", headers=headers or {}, client_addr="127.0.0.1")
        return status, json.loads(response)

    def history(self, headers=None):
        status, data = self.request("GET", "/api/notifications?limit=100", headers=headers)
        self.assertEqual(status, 200, data)
        return data["notifications"]

    def product(self, stock=5):
        suffix = os.urandom(5).hex()
        status, data = self.request("POST", "/api/products", {
            "id": "NOTIF-PRD-" + suffix, "sku": "NOTIF-SKU-" + suffix,
            "barcode_id": "NOTIF-BAR-" + suffix, "name": "Notification test tee",
            "item_condition": "BRAND_NEW", "base_price": 40000,
            "total_transport_cost": 0, "cost_price": 10000, "in_stock_count": stock,
        })
        self.assertEqual(status, 201, data)
        return data["product"]

    def checkout(self, product, channel="pos", **extra):
        owner = "NOTIF-HOLD-" + os.urandom(5).hex()
        if channel == "pos":
            status, data = self.request("POST", "/api/inventory-locks/acquire", {
                "lock_owner": owner, "product_id": product["id"], "quantity": 1,
            })
            self.assertEqual(status, 200, data)
        return self.request("POST", "/api/orders", dict({
            "channel": channel, "lock_owner": owner, "delivery_type": "pickup",
            "items": [{"product_id": product["id"], "qty": 1}],
            "tender": {"type": "cash", "tendered": 40000},
            "customer_name": "Private customer name",
        }, **extra))

    def protect(self, areas):
        status, owner = self.request("POST", "/api/pos-access/admin", {"password": "Notification-Owner-Password-987!"})
        self.assertEqual(status, 200, owner)
        headers = {"X-Pos-Access": owner["session"]["token"]}
        status, result = self.request("PATCH", "/api/pos-access/policy", {"protected_areas": areas}, headers)
        self.assertEqual(status, 200, result)
        return headers

    def worker(self, code, **extra):
        env = dict(os.environ, DATABASE_URL=TEST_DATABASE_URL, **extra)
        result = subprocess.run([sys.executable, "-c", code], cwd=ROOT, env=env, capture_output=True, text=True, timeout=20)
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        return json.loads(result.stdout.strip().splitlines()[-1])

    def test_history_and_ticket_survive_a_different_process(self):
        event = notifications.broadcast_event("NEW_ORDER", "Checkout recorded", "UGX 40,000", {"order_id": "DURABLE-ORDER", "channel": "pos"})
        token = "A" * 43
        ticket = notifications.issue_stream_ticket({"id": "CASHIER", "name": "Operator", "role": "cashier", "_pos_access_tokens": token})
        found = self.worker("import json, os, notifications; print(json.dumps({'events': notifications.recent_events(), 'staff': notifications.redeem_stream_ticket(os.environ['TEST_STREAM_TICKET'])}))", TEST_STREAM_TICKET=ticket)
        self.assertEqual(found["events"][0]["id"], event["id"])
        self.assertEqual(found["staff"]["id"], "CASHIER")
        self.assertEqual(found["staff"]["_pos_access_token_hashes"], [notifications._digest(token)])
        self.assertNotIn(token, json.dumps(found["staff"]))
        self.assertIsNone(notifications.redeem_stream_ticket(ticket), "consumed on another worker")

    def test_ticket_is_atomic_single_use_and_expires(self):
        ticket = notifications.issue_stream_ticket({"id": "CASHIER"})
        with get_db() as session:
            row = session.query(NotificationStreamTicket).one()
            self.assertNotEqual(row.ticket_hash, ticket)
            self.assertNotIn(ticket, row.staff_json)
        with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
            results = list(pool.map(notifications.redeem_stream_ticket, [ticket] * 6))
        self.assertEqual(sum(result is not None for result in results), 1)
        expired = notifications.issue_stream_ticket({"id": "EXPIRED"})
        with get_db() as session:
            session.query(NotificationStreamTicket).filter_by(ticket_hash=notifications._digest(expired)).update({"expires_at": datetime.utcnow() - timedelta(seconds=1)})
        self.assertIsNone(notifications.redeem_stream_ticket(expired))
        self.assertIsNone(notifications.redeem_stream_ticket("short"))

    def test_stream_reads_events_from_other_workers(self):
        subscriber = notifications.subscribe()
        try:
            created = self.worker("import json, notifications; print(json.dumps(notifications.broadcast_event('LOW_STOCK', 'Low stock', 'One piece left', {'product_id': 'OTHER-WORKER'})))")
            frame = notifications.next_frame(subscriber, timeout=0.2)
            self.assertTrue(frame.startswith(b"data: "), frame)
            self.assertEqual(json.loads(frame[6:])["id"], created["id"])
            self.assertEqual(notifications.next_frame(subscriber, timeout=0.01), b": keep-alive\n\n")
        finally:
            notifications.unsubscribe(subscriber)

    def test_uncommitted_and_rolled_back_actions_never_publish(self):
        subscriber = notifications.subscribe()
        try:
            with self.assertRaisesRegex(RuntimeError, "roll back"):
                with get_db() as session:
                    event = notifications.broadcast_event("NEW_ORDER", "Not committed", "Never shown", {"order_id": "ROLLBACK-ORDER"}, session=session)
                    session.flush()
                    # A separate connection cannot see this event before commit.
                    with SessionFactory() as reader:
                        self.assertIsNone(reader.get(NotificationEvent, event["id"]))
                    raise RuntimeError("roll back")
            self.assertEqual(self.history(), [])
            self.assertEqual(notifications.next_frame(subscriber, timeout=0.01), b": keep-alive\n\n")
        finally:
            notifications.unsubscribe(subscriber)

    def test_checkout_and_low_stock_reach_history_exactly_once(self):
        product = self.product(stock=2)
        status, result = self.checkout(product)
        self.assertEqual(status, 201, result)
        order_id = result["order"]["id"]
        orders = [event for event in self.history() if event["type"] == "NEW_ORDER"]
        self.assertEqual(len(orders), 1)
        self.assertEqual(orders[0]["payload"]["order_id"], order_id)
        self.assertIn("40,000", orders[0]["message"])
        self.assertEqual(len([event for event in self.history() if event["type"] == "LOW_STOCK"]), 1)
        with get_db() as session:
            notifications.backfill_history(session)
        self.assertEqual(len([event for event in self.history() if event["type"] == "NEW_ORDER"]), 1, "restart must not duplicate a checkout")
        # Duplicate or invalid orders cannot produce successful-checkout alerts.
        before = {event["id"] for event in self.history()}
        status, _ = self.request("POST", "/api/orders", {"items": [], "channel": "pos", "lock_owner": "bad"})
        self.assertEqual(status, 400)
        self.assertEqual(before, {event["id"] for event in self.history()})

    def test_api_failure_after_recording_alert_rolls_back_checkout(self):
        product = self.product(stock=2)
        before = {event["id"] for event in self.history()}
        original = api.broadcast_event
        def fail_after_record(*args, **kwargs):
            original(*args, **kwargs)
            raise RuntimeError("Simulated checkout failure after alert insert")
        with mock.patch.object(api, "broadcast_event", side_effect=fail_after_record):
            status, _ = self.checkout(product)
        self.assertEqual(status, 500)
        self.assertEqual(before, {event["id"] for event in self.history()})
        with get_db() as session:
            self.assertEqual(session.get(Product, product["id"]).in_stock_count, 2)

    def test_intake_edit_archive_and_settings_events(self):
        product = self.product()
        self.assertEqual(self.history()[0]["type"], "STOCK_ADDED")
        status, result = self.request("PATCH", "/api/products/" + product["id"], {"name": "Updated notification tee"})
        self.assertEqual(status, 200, result)
        self.assertEqual(self.history()[0]["type"], "STOCK_UPDATED")
        before = len(self.history())
        status, _ = self.request("PATCH", "/api/products/" + product["id"], {"name": "Updated notification tee"})
        self.assertEqual(status, 200)
        self.assertEqual(len(self.history()), before, "unchanged product must not spam the bell")
        status, result = self.request("DELETE", "/api/products/" + product["id"], {"mode": "archive"})
        self.assertEqual(status, 200, result)
        self.assertEqual(self.history()[0]["type"], "STOCK_REMOVED")
        title = "Notification store " + os.urandom(4).hex()
        status, result = self.request("POST", "/api/settings", {"settings": {"store_name": title}})
        self.assertEqual(status, 200, result)
        self.assertEqual(self.history()[0]["type"], "SETTINGS_UPDATED")
        self.assertNotIn(title, json.dumps(self.history()[0]), "settings values are not in alert payloads")
        before = len(self.history())
        self.request("POST", "/api/settings", {"settings": {"store_name": title}})
        self.assertEqual(len(self.history()), before, "unchanged settings must not spam the bell")

    def test_deleted_catalog_id_can_be_reused_without_losing_intake_alert(self):
        product = self.product()
        status, result = self.request("DELETE", "/api/products/" + product["id"], {"mode": "permanent"})
        self.assertEqual(status, 200, result)
        status, result = self.request("POST", "/api/products", {
            "id": product["id"], "sku": product["sku"], "barcode_id": product["barcode_id"],
            "name": "New intake reusing an old catalog ID", "item_condition": "BRAND_NEW",
            "base_price": 50000, "total_transport_cost": 0, "in_stock_count": 1,
        })
        self.assertEqual(status, 201, result)
        intakes = [event for event in self.history() if event["type"] == "STOCK_ADDED"]
        self.assertEqual(len(intakes), 2)
        with get_db() as session:
            notifications.backfill_history(session)
        self.assertEqual(len([event for event in self.history() if event["type"] == "STOCK_ADDED" and event["payload"].get("product_id") == product["id"]]), 2)

    def test_web_order_notes_and_fulfillment_events(self):
        product = self.product()
        status, result = self.checkout(product, channel="web", delivery_notes="Private delivery note")
        self.assertEqual(status, 201, result)
        order_id = result["order"]["id"]
        self.assertTrue(any(event["type"] == "NEW_MESSAGE" for event in self.history()))
        status, result = self.request("PATCH", "/api/orders/" + order_id, {"fulfillment_status": "In Assembly"})
        self.assertEqual(status, 200, result)
        self.assertEqual(self.history()[0]["type"], "ORDER_UPDATED")
        before = len(self.history())
        self.request("PATCH", "/api/orders/" + order_id, {"fulfillment_status": "In Assembly"})
        self.assertEqual(len(self.history()), before)
        status, _ = self.request("PATCH", "/api/orders/" + order_id, {"fulfillment_status": "Unfulfilled"})
        self.assertEqual(status, 409)
        self.assertEqual(len(self.history()), before)

    def test_expense_create_edit_void_and_stock_lot_events(self):
        status, result = self.request("POST", "/api/finance/expenses", {"category": "Transport", "amount": 12000, "payment_method": "cash"})
        self.assertEqual(status, 201, result)
        expense_id = result["expense"]["id"]
        self.assertEqual(self.history()[0]["type"], "NEW_EXPENSE")
        status, result = self.request("PATCH", "/api/finance/expenses/" + expense_id, {"amount": 15000})
        self.assertEqual(status, 200, result)
        self.assertEqual(self.history()[0]["type"], "EXPENSE_UPDATED")
        status, result = self.request("POST", "/api/finance/expenses/" + expense_id + "/void", {"reason": "Test correction"})
        self.assertEqual(status, 200, result)
        self.assertEqual(self.history()[0]["type"], "EXPENSE_VOIDED")
        status, result = self.request("POST", "/api/finance/stock-lots", {
            "supplier": "Private supplier", "description": "Test bale", "acquisition_cost": 100000,
            "shipping_cost": 10000, "item_count": 10,
        })
        self.assertEqual(status, 201, result)
        self.assertEqual(self.history()[0]["type"], "STOCK_LOT_RECEIVED")

    def test_locked_checkout_still_alerts_without_private_details(self):
        product = self.product(stock=2)
        owner = self.protect(["orders", "stock", "finance", "settings"])
        status, result = self.checkout(product)  # cashier remains password-free
        self.assertEqual(status, 201, result)
        locked = self.history()
        self.assertTrue(any(event["type"] == "NEW_ORDER" for event in locked))
        self.assertTrue(all(event["protected"] for event in locked))
        self.assertTrue(all(event["payload"] == {} for event in locked))
        encoded = json.dumps(locked)
        self.assertNotIn("Private customer name", encoded)
        self.assertNotIn("40000", encoded)
        self.assertNotIn(result["order"]["id"], encoded)
        self.assertNotIn(product["id"], encoded)
        detailed = self.history(owner)
        self.assertEqual({event["id"] for event in detailed}, {event["id"] for event in locked})
        self.assertTrue(all(not event["protected"] for event in detailed))
        self.assertIn("Private customer name", json.dumps(detailed))
        self.assertEqual(self.request("GET", "/api/orders")[0], 403, "bell summaries must not unlock order history")

    def test_delivery_and_rider_events_are_orders_protected_in_history_and_stream(self):
        self.protect(["orders"])
        event_types = [
            "DELIVERY_ASSIGNED", "DELIVERY_PROGRESS", "RIDER_ADDED", "RIDER_UPDATED",
            "RIDER_STATUS_UPDATED", "RIDER_ARCHIVED", "RIDER_PAIRING_CODE_ISSUED",
            "RIDER_PHONE_PAIRED", "RIDER_PHONE_REVOKED", "RIDER_DUTY_STARTED", "RIDER_DUTY_STOPPED",
        ]
        for event_type in event_types:
            self.assertEqual(access_control.NOTIFICATION_AREAS.get(event_type), "orders")
            notifications.broadcast_event(event_type, "Private partner name", "Private phone +256700111222",
                                          {"rider_id": "RIDER-SECRET", "rider_name": "Private partner",
                                           "phone": "+256700111222", "order_id": "ORDER-SECRET"})
        locked = self.history()
        self.assertEqual({event["type"] for event in locked}, set(event_types))
        self.assertTrue(all(event["protected"] and event["area"] == "orders" and event["payload"] == {} for event in locked))
        hidden_json = json.dumps(locked)
        for secret in ["Private partner", "+256700111222", "RIDER-SECRET", "ORDER-SECRET"]:
            self.assertNotIn(secret, hidden_json)
        self.assertTrue(all(event["title"] == "New delivery activity" for event in locked))
        frame = ("data: " + json.dumps(notifications.broadcast_event(
            "RIDER_UPDATED", "Private partner name", "Private phone +256700111222",
            {"rider_id": "RIDER-SECRET", "phone": "+256700111222"})) + "\n\n").encode()
        hidden_frame = json.loads(access_control.filter_stream_frame(frame, {"id": "UNLOCKED-STAFF"})[6:])
        self.assertTrue(hidden_frame["protected"])
        self.assertEqual(hidden_frame["payload"], {})
        self.assertNotIn("+256700111222", json.dumps(hidden_frame))

    def test_stream_area_grants_are_kept_and_revocation_is_immediate(self):
        owner = self.protect(["orders"])
        event = notifications.broadcast_event("NEW_MESSAGE", "Private customer name", "Private note", {"order_id": "SECRET-ORDER", "message": "Private note"})
        ticket = notifications.issue_stream_ticket({"id": "OPERATOR", "_pos_access_tokens": owner["X-Pos-Access"]})
        staff = notifications.redeem_stream_ticket(ticket)
        frame = ("data: " + json.dumps(event) + "\n\n").encode()
        shown = json.loads(access_control.filter_stream_frame(frame, staff)[6:])
        self.assertEqual(shown["message"], "Private note")
        self.request("POST", "/api/pos-access/lock", {}, owner)
        hidden = json.loads(access_control.filter_stream_frame(frame, staff)[6:])
        self.assertTrue(hidden["protected"])
        self.assertEqual(hidden["payload"], {})
        self.assertNotIn("Private note", json.dumps(hidden))

    def test_backfill_is_idempotent_and_preserves_original_time(self):
        product = self.product()
        original_time = datetime.utcnow() - timedelta(days=14)
        with get_db() as session:
            session.get(Product, product["id"]).created_at = original_time
            session.query(NotificationEvent).delete()
        with get_db() as session:
            notifications.backfill_history(session)
        first = self.history()
        recovered = next(event for event in first if event["payload"].get("product_id") == product["id"])
        self.assertAlmostEqual(recovered["timestamp"], original_time.replace(tzinfo=timezone.utc).timestamp(), places=3)
        with get_db() as session:
            notifications.backfill_history(session)
        self.assertEqual({event["id"] for event in first}, {event["id"] for event in self.history()})

    def test_history_is_bounded_newest_first_and_protected_mode_still_authenticates(self):
        for index in range(105):
            notifications.broadcast_event("LOW_STOCK", "Stock alert", str(index))
        history = self.history()
        self.assertEqual(len(history), 100)
        self.assertEqual(history[0]["message"], "104")
        self.assertGreaterEqual(history[0]["timestamp"], history[-1]["timestamp"])
        self.assertEqual(len(self.request("GET", "/api/notifications?limit=3")[1]["notifications"]), 3)
        with mock.patch.dict(os.environ, {"ADONAI_REQUIRE_STAFF_AUTH": "1"}):
            self.assertEqual(self.request("GET", "/api/notifications")[0], 401)
            self.assertEqual(self.request("POST", "/api/notifications/ticket", {})[0], 401)

    def test_permanent_delete_removes_alerts_everywhere_and_backfill_never_restores_them(self):
        product = self.product()
        other = notifications.broadcast_event("LOW_STOCK", "Stock alert", "keep me")
        intake = next(event for event in self.history() if event["payload"].get("product_id") == product["id"])
        status, data = self.request("POST", "/api/notifications/delete", {"ids": [intake["id"], "notif_missing", 7]})
        self.assertEqual(status, 200, data)
        self.assertEqual(data["deleted"], 1)
        ids = {event["id"] for event in self.history()}
        self.assertNotIn(intake["id"], ids)
        self.assertIn(other["id"], ids, "only the selected alerts are deleted")
        with get_db() as session:
            self.assertIsNotNone(session.get(Product, product["id"]), "the product itself is never touched")
            row = session.get(NotificationEvent, intake["id"])
            self.assertIsNotNone(row.deleted_at, "kept as a tombstone")
            notifications.backfill_history(session)
        self.assertNotIn(intake["id"], {event["id"] for event in self.history()}, "redeploy backfill cannot resurrect it")
        # Deleting again is harmless; bad requests are rejected.
        self.assertEqual(self.request("POST", "/api/notifications/delete", {"ids": [intake["id"]]})[1]["deleted"], 0)
        self.assertEqual(self.request("POST", "/api/notifications/delete", {"ids": []})[0], 400)
        self.assertEqual(self.request("POST", "/api/notifications/delete", {"ids": ["x"] * 201})[0], 400)
        self.assertEqual(self.request("POST", "/api/notifications/delete", {})[0], 400)
        with mock.patch.dict(os.environ, {"ADONAI_REQUIRE_STAFF_AUTH": "1"}):
            self.assertEqual(self.request("POST", "/api/notifications/delete", {"ids": [other["id"]]})[0], 401)
        self.assertIn(other["id"], {event["id"] for event in self.history()})

    def test_every_business_broadcast_uses_its_existing_transaction(self):
        tree = ast.parse((ROOT / "api.py").read_text())
        calls = [node for node in ast.walk(tree) if isinstance(node, ast.Call)
            and isinstance(node.func, ast.Name) and node.func.id == "broadcast_event"]
        self.assertGreaterEqual(len(calls), 15)
        for call in calls:
            self.assertTrue(any(keyword.arg == "session" for keyword in call.keywords), f"unbound transaction on line {call.lineno}")


if __name__ == "__main__":
    unittest.main()
