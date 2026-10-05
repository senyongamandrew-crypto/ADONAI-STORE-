"""
Adonai Store — Backend PostgreSQL & Render Hardening Test Suite
Verifies:
1. DATABASE_URL dynamic formatting (postgres:// -> postgresql://)
2. Credential masking in stdout logs
3. Connection pool initialization & resilience
4. Schema auto-migration & seed data completeness
5. Concurrency & race-condition safety for inventory deductions
6. REST API endpoints (/api/health, /api/products, /api/orders, /api/sync/pull)
7. WSGI application response under Gunicorn-compatible environment
8. Balanced expenses, audited edit/void reversals, and manager dashboard security
9. Stock-lot landed costs, aging markdowns, and write-off loss accounting
10. POS scan holds blocking public checkout and being consumed atomically
"""
import concurrent.futures
from datetime import datetime, timedelta
import io
import json
import os
import sys
import unittest

# Ensure current directory in python path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

# Test harness security context: rate limiting is disabled for rapid-fire
# unit requests, and a dedicated master key is provided via the environment
# (the old hardcoded default key has been permanently retired).
os.environ.setdefault("ADONAI_RATE_LIMIT_DISABLED", "1")
TEST_MASTER_KEY = "TEST-MASTER-KEY-9271-SECURE"
os.environ.setdefault("ADMIN_ACCESS_PIN", TEST_MASTER_KEY)

from database import get_formatted_database_url, mask_database_url, get_db, engine
from models import (
    AccountingJournalEntry,
    ExpenseRecord,
    InventoryLock,
    Product,
    Order,
    OrderItem,
    Category,
    User,
    Inventory,
    StockLot,
    StoreSetting,
)
from db_init import init_db
from serve import app, wsgi_app


class TestRenderPostgresHardening(unittest.TestCase):

    def api_request(self, method, path, payload=None, terminal_key=None, query=""):
        raw = json.dumps(payload or {}).encode("utf-8") if payload is not None else b""
        environ = {
            "REQUEST_METHOD": method,
            "PATH_INFO": path,
            "QUERY_STRING": query,
            "CONTENT_LENGTH": str(len(raw)),
            "wsgi.input": io.BytesIO(raw),
        }
        if terminal_key:
            environ["HTTP_X_TERMINAL_KEY"] = terminal_key
        status = []
        response = wsgi_app(environ, lambda value, headers: status.append(value))
        decoded = b"".join(response).decode("utf-8")
        return status[0], json.loads(decoded) if decoded else {}

    def test_01_url_formatting(self):
        """Test legacy postgres:// prefix is automatically converted to postgresql://"""
        os.environ["DATABASE_URL"] = "postgres://ad_user:secret_render_pass_456@dpg-host.render.com:5432/ad_db"
        formatted, is_pg = get_formatted_database_url()
        self.assertTrue(is_pg)
        self.assertTrue(formatted.startswith("postgresql://"))
        self.assertFalse(formatted.startswith("postgres://"))

        # Test log masking
        masked = mask_database_url(formatted)
        self.assertNotIn("secret_render_pass_456", masked)
        self.assertIn("ad_user", masked)
        self.assertIn("*****", masked)
        print("✅ PASS: Dynamic DATABASE_URL formatting and password masking verified.")

    def test_02_database_initialization(self):
        """Test database table auto-creation and seeding."""
        # Use local SQLite for isolation in test
        if "DATABASE_URL" in os.environ:
            del os.environ["DATABASE_URL"]

        success = init_db()
        self.assertTrue(success, "Database auto-migration and init failed")
        self.assertTrue(init_db(), "Additive migration must be idempotent on a second startup")

        with get_db() as session:
            prods_count = session.query(Product).count()
            cats_count = session.query(Category).count()
            users_count = session.query(User).count()
            orders_count = session.query(Order).count()
            settings_count = session.query(StoreSetting).count()

            self.assertGreaterEqual(prods_count, 16, "Products must be seeded with at least 16 items")
            self.assertGreaterEqual(cats_count, 7, "Categories must be seeded")
            self.assertGreaterEqual(users_count, 4, "Users must be seeded")
            self.assertGreaterEqual(orders_count, 1, "Sample order must be seeded")
            self.assertGreaterEqual(settings_count, 5, "Settings must be seeded")

            print(f"✅ PASS: Schema verification & seed complete ({prods_count} products, {cats_count} categories, {users_count} users).")

    def test_03_concurrent_inventory_deduction(self):
        """Simulate high-concurrency order placement and verify atomic inventory safety."""
        target_product_id = "PRD-1005"  # White Oxford Button-Down

        # Reset stock to exactly 2 for isolated concurrency test
        with get_db() as session:
            prod = session.query(Product).filter_by(id=target_product_id).first()
            self.assertIsNotNone(prod)
            prod.in_stock_count = 2
            initial_stock = 2

        import time
        run_id = int(time.time() * 1000)

        def place_order(order_num):
            order_id = f"AT-CONC-{run_id}-{order_num}"
            payload = {
                "id": order_id,
                "channel": "web",
                "customer_name": f"Concurrent Customer {order_num}",
                "items": [{"product_id": target_product_id, "qty": 1}]
            }
            environ = {
                "REQUEST_METHOD": "POST",
                "PATH_INFO": "/api/orders",
                "QUERY_STRING": "",
                "HTTP_X_TERMINAL_KEY": TEST_MASTER_KEY,
                "CONTENT_LENGTH": str(len(json.dumps(payload))),
                "wsgi.input": io.BytesIO(json.dumps(payload).encode("utf-8"))
            }

            status_captured = []
            def start_response(status, headers):
                status_captured.append(status)

            resp = wsgi_app(environ, start_response)
            body = b"".join(resp).decode("utf-8")
            return status_captured[0], json.loads(body)

        import io
        # Try to place 5 orders concurrently for an item that has 2 in stock
        with concurrent.futures.ThreadPoolExecutor(max_workers=5) as executor:
            futures = [executor.submit(place_order, i) for i in range(1, 6)]
            results = [f.result() for f in futures]

        success_count = sum(1 for status, data in results if status.startswith("201"))
        conflict_count = sum(1 for status, data in results if status.startswith("409"))

        self.assertEqual(success_count, initial_stock, f"Only {initial_stock} orders should succeed based on stock")
        self.assertEqual(conflict_count, 5 - initial_stock, "Remaining concurrent requests must receive 409 Conflict")

        # Verify stock is now 0 and not negative
        with get_db() as session:
            prod = session.query(Product).filter_by(id=target_product_id).first()
            self.assertEqual(prod.in_stock_count, 0)

        print(f"✅ PASS: Atomic high-concurrency order placement verified ({success_count} succeeded, {conflict_count} prevented overselling).")

    def test_04_api_health_endpoint(self):
        """Test /api/health endpoint returns proper database stats."""
        import io
        environ = {
            "REQUEST_METHOD": "GET",
            "PATH_INFO": "/api/health",
            "QUERY_STRING": "",
            "wsgi.input": io.BytesIO(b"")
        }
        status_captured = []
        def start_response(status, headers):
            status_captured.append(status)

        resp = wsgi_app(environ, start_response)
        data = json.loads(b"".join(resp).decode("utf-8"))
        self.assertEqual(data["status"], "healthy")
        self.assertEqual(data["database"], "connected")
        # SECURITY: table names and pool internals must no longer be exposed.
        self.assertNotIn("tables", data)
        self.assertNotIn("pool", data)
        self.assertGreaterEqual(data.get("tables_count", 0), 2)
        print(f"✅ PASS: /api/health returned 200 OK without leaking schema details ({data['tables_count']} tables).")

    def test_05_api_sync_pull(self):
        """Test /api/sync/pull endpoint delivers complete sync payload for authenticated staff."""
        import io
        # 1. Unauthenticated request must return 401 Unauthorized
        environ_unauthed = {
            "REQUEST_METHOD": "GET",
            "PATH_INFO": "/api/sync/pull",
            "QUERY_STRING": "",
            "wsgi.input": io.BytesIO(b"")
        }
        status_captured = []
        resp_unauthed = wsgi_app(environ_unauthed, lambda s, h: status_captured.append(s))
        self.assertTrue(status_captured[0].startswith("401"))

        # 2. SECURITY: credentials in the URL query string must be REJECTED
        # (they leak into access logs, browser history, and Referer headers).
        environ_query_key = {
            "REQUEST_METHOD": "GET",
            "PATH_INFO": "/api/sync/pull",
            "QUERY_STRING": f"key={TEST_MASTER_KEY}",
            "wsgi.input": io.BytesIO(b"")
        }
        status_query = []
        wsgi_app(environ_query_key, lambda s, h: status_query.append(s))
        self.assertTrue(status_query[0].startswith("401"),
                        "Query-string credentials must no longer authenticate")

        # 3. Authenticated request with Master Key header must return 200 OK with full state
        environ_authed = {
            "REQUEST_METHOD": "GET",
            "PATH_INFO": "/api/sync/pull",
            "QUERY_STRING": "",
            "HTTP_X_TERMINAL_KEY": TEST_MASTER_KEY,
            "wsgi.input": io.BytesIO(b"")
        }
        status_captured_auth = []
        resp_authed = wsgi_app(environ_authed, lambda s, h: status_captured_auth.append(s))
        data = json.loads(b"".join(resp_authed).decode("utf-8"))
        self.assertTrue(status_captured_auth[0].startswith("200"))
        self.assertIn("products", data)
        self.assertIn("sales", data)
        self.assertIn("categories", data)
        self.assertIn("settings", data)
        self.assertGreaterEqual(len(data["products"]), 16)
        print(f"✅ PASS: /api/sync/pull payload generated with {len(data['products'])} products and secured by terminal auth.")

    def test_06_staff_and_admin_auth_verification(self):
        """Test Staff Terminal Key and Admin Access PIN verification via environment variables and database."""
        import io

        # 1. Test ADMIN_ACCESS_PIN environment variable (restored afterwards
        # so the suite-wide TEST_MASTER_KEY keeps working in later tests)
        original_admin_pin = os.environ.get("ADMIN_ACCESS_PIN")
        os.environ["ADMIN_ACCESS_PIN"] = "987654-TEST-ADMIN"
        self.addCleanup(lambda: os.environ.update({"ADMIN_ACCESS_PIN": original_admin_pin} if original_admin_pin else {}))
        payload_admin = {"pin": "987654-TEST-ADMIN"}
        environ_admin = {
            "REQUEST_METHOD": "POST",
            "PATH_INFO": "/api/auth/verify",
            "QUERY_STRING": "",
            "CONTENT_LENGTH": str(len(json.dumps(payload_admin))),
            "wsgi.input": io.BytesIO(json.dumps(payload_admin).encode("utf-8"))
        }
        status_cap = []
        resp = wsgi_app(environ_admin, lambda s, h: status_cap.append(s))
        data = json.loads(b"".join(resp).decode("utf-8"))
        self.assertTrue(data.get("ok"))
        self.assertIn("token", data)
        self.assertEqual(data["staff"]["role"], "admin")
        self.assertTrue(status_cap[0].startswith("200"))

        # 2. Test STAFF_TERMINAL_KEY environment variable
        os.environ["STAFF_TERMINAL_KEY"] = "ADONAI-POS-STAFF-KEY"
        payload_staff = {"terminal_key": "ADONAI-POS-STAFF-KEY"}
        environ_staff = {
            "REQUEST_METHOD": "POST",
            "PATH_INFO": "/api/auth/verify",
            "QUERY_STRING": "",
            "CONTENT_LENGTH": str(len(json.dumps(payload_staff))),
            "wsgi.input": io.BytesIO(json.dumps(payload_staff).encode("utf-8"))
        }
        status_cap = []
        resp = wsgi_app(environ_staff, lambda s, h: status_cap.append(s))
        data = json.loads(b"".join(resp).decode("utf-8"))
        self.assertTrue(data.get("ok"))
        self.assertIn("token", data)
        self.assertEqual(data["staff"]["role"], "cashier")
        self.assertTrue(status_cap[0].startswith("200"))

        # 3. Test Database Seed Staff PIN ('1234' for Mercer Admin)
        payload_db = {"pin": "1234"}
        environ_db = {
            "REQUEST_METHOD": "POST",
            "PATH_INFO": "/api/auth/verify",
            "QUERY_STRING": "",
            "CONTENT_LENGTH": str(len(json.dumps(payload_db))),
            "wsgi.input": io.BytesIO(json.dumps(payload_db).encode("utf-8"))
        }
        status_cap = []
        resp = wsgi_app(environ_db, lambda s, h: status_cap.append(s))
        data = json.loads(b"".join(resp).decode("utf-8"))
        self.assertTrue(data.get("ok"))
        self.assertIn("token", data)
        self.assertEqual(data["staff"]["id"], "STF-01")
        self.assertEqual(data["staff"]["role"], "admin")

        # 4. Test Invalid Key Rejection
        payload_invalid = {"pin": "invalid_wrong_key"}
        environ_invalid = {
            "REQUEST_METHOD": "POST",
            "PATH_INFO": "/api/auth/verify",
            "QUERY_STRING": "",
            "CONTENT_LENGTH": str(len(json.dumps(payload_invalid))),
            "wsgi.input": io.BytesIO(json.dumps(payload_invalid).encode("utf-8"))
        }
        status_cap = []
        resp = wsgi_app(environ_invalid, lambda s, h: status_cap.append(s))
        data = json.loads(b"".join(resp).decode("utf-8"))
        self.assertFalse(data.get("ok"))
        self.assertTrue(status_cap[0].startswith("401"))

        # 5. SECURITY: the retired hardcoded default master key must NEVER
        # authenticate again, even if an old database row still contains it.
        payload_retired = {"pin": "ADONAI-MASTER-2026"}
        environ_retired = {
            "REQUEST_METHOD": "POST",
            "PATH_INFO": "/api/auth/verify",
            "QUERY_STRING": "",
            "CONTENT_LENGTH": str(len(json.dumps(payload_retired))),
            "wsgi.input": io.BytesIO(json.dumps(payload_retired).encode("utf-8"))
        }
        status_cap = []
        resp = wsgi_app(environ_retired, lambda s, h: status_cap.append(s))
        data = json.loads(b"".join(resp).decode("utf-8"))
        self.assertFalse(data.get("ok"))
        self.assertTrue(status_cap[0].startswith("401"),
                        "Retired default master key must be rejected")

        print("✅ PASS: Staff Terminal Key & Admin PIN environment variable verification passed.")

    def test_07_dual_target_endpoint_security(self):
        """Test public storefront vs protected POS endpoints security separation."""
        import io
        import time

        # Ensure test products have stock for isolated test 7
        with get_db() as session:
            for pid in ("PRD-1002", "PRD-1003"):
                p = session.query(Product).filter_by(id=pid).first()
                if p:
                    p.in_stock_count = 5

        # Public storefront can read products without auth
        environ_public_prods = {
            "REQUEST_METHOD": "GET",
            "PATH_INFO": "/api/products",
            "QUERY_STRING": "",
            "wsgi.input": io.BytesIO(b"")
        }
        status_cap = []
        resp = wsgi_app(environ_public_prods, lambda s, h: status_cap.append(s))
        self.assertTrue(status_cap[0].startswith("200"))

        # Public web checkout succeeds without auth
        order_web = {
            "id": f"AT-WEB-{int(time.time() * 1000)}",
            "channel": "web",
            "customer_name": "Web Shopper",
            "items": [{"product_id": "PRD-1002", "qty": 1}]
        }
        environ_web_order = {
            "REQUEST_METHOD": "POST",
            "PATH_INFO": "/api/orders",
            "QUERY_STRING": "",
            "CONTENT_LENGTH": str(len(json.dumps(order_web))),
            "wsgi.input": io.BytesIO(json.dumps(order_web).encode("utf-8"))
        }
        status_cap = []
        resp = wsgi_app(environ_web_order, lambda s, h: status_cap.append(s))
        self.assertTrue(status_cap[0].startswith("201"))

        # Protected POS checkout without auth must fail with 401
        order_pos_unauthed = {
            "channel": "pos",
            "items": [{"product_id": "PRD-1003", "qty": 1}]
        }
        environ_pos_unauth = {
            "REQUEST_METHOD": "POST",
            "PATH_INFO": "/api/orders",
            "QUERY_STRING": "",
            "CONTENT_LENGTH": str(len(json.dumps(order_pos_unauthed))),
            "wsgi.input": io.BytesIO(json.dumps(order_pos_unauthed).encode("utf-8"))
        }
        status_cap = []
        resp = wsgi_app(environ_pos_unauth, lambda s, h: status_cap.append(s))
        self.assertTrue(status_cap[0].startswith("401"))

        # Protected POS checkout also requires a server-side scan hold.
        lock_owner = f"TEST-POS-{int(time.time() * 1000)}"
        lock_status, _ = self.api_request(
            "POST", "/api/inventory-locks/acquire",
            {"product_id": "PRD-1003", "lock_owner": lock_owner, "quantity": 1},
            TEST_MASTER_KEY,
        )
        self.assertTrue(lock_status.startswith("200"))
        order_pos_authed = {
            "id": f"AT-POS-AUTH-{int(time.time() * 1000)}",
            "channel": "pos",
            "lock_owner": lock_owner,
            "items": [{"product_id": "PRD-1003", "qty": 1}]
        }
        environ_pos_auth = {
            "REQUEST_METHOD": "POST",
            "PATH_INFO": "/api/orders",
            "QUERY_STRING": "",
            "HTTP_X_TERMINAL_KEY": TEST_MASTER_KEY,
            "CONTENT_LENGTH": str(len(json.dumps(order_pos_authed))),
            "wsgi.input": io.BytesIO(json.dumps(order_pos_authed).encode("utf-8"))
        }
        status_cap = []
        resp = wsgi_app(environ_pos_auth, lambda s, h: status_cap.append(s))
        self.assertTrue(status_cap[0].startswith("201"))
        print("✅ PASS: Dual-target security verified (public web order 201, POS unauthed 401, POS authed 201).")

    def test_08_live_store_settings_sync(self):
        """System Parameters persist centrally and public reads never expose keys."""
        import io

        with get_db() as session:
            original = {
                row.key: row.value
                for row in session.query(StoreSetting).filter(
                    StoreSetting.key.in_(["store_name", "base_delivery_fee"])
                ).all()
            }

        def request(method, path, payload=None, terminal_key=None):
            raw = json.dumps(payload or {}).encode("utf-8") if payload is not None else b""
            environ = {
                "REQUEST_METHOD": method,
                "PATH_INFO": path,
                "QUERY_STRING": "",
                "CONTENT_LENGTH": str(len(raw)),
                "wsgi.input": io.BytesIO(raw)
            }
            if terminal_key:
                environ["HTTP_X_TERMINAL_KEY"] = terminal_key
            captured = []
            response = wsgi_app(environ, lambda status, headers: captured.append(status))
            return captured[0], json.loads(b"".join(response).decode("utf-8"))

        try:
            status, public_before = request("GET", "/api/settings")
            self.assertTrue(status.startswith("200"))
            self.assertNotIn("master_key", public_before["settings"])
            self.assertNotIn("admin_key", public_before["settings"])

            status, denied = request("POST", "/api/settings", {
                "settings": {"store_name": "Unauthorized Name"}
            })
            self.assertTrue(status.startswith("403"))
            self.assertFalse(denied.get("ok"))

            live_name = "Adonai Live Sync Test"
            status, updated = request(
                "POST",
                "/api/settings",
                {"settings": {"store_name": live_name, "base_delivery_fee": 8500}},
                TEST_MASTER_KEY
            )
            self.assertTrue(status.startswith("200"))
            self.assertTrue(updated.get("ok"))
            self.assertEqual(updated["settings"]["store_name"], live_name)
            self.assertEqual(updated["settings"]["base_delivery_fee"], "8500")

            status, public_after = request("GET", "/api/settings")
            self.assertTrue(status.startswith("200"))
            self.assertEqual(public_after["settings"]["store_name"], live_name)
            self.assertEqual(public_after["settings"]["base_delivery_fee"], "8500")
            print("✅ PASS: System Parameters publish centrally and are publicly readable without exposing secrets.")
        finally:
            with get_db() as session:
                for key, value in original.items():
                    row = session.query(StoreSetting).filter_by(key=key).first()
                    if row:
                        row.value = value


    def test_09_expense_double_entry_edit_void_and_dashboard(self):
        """Expenses post atomically, preserve edit/void audit history, and feed reporting."""
        stamp = str(int(datetime.utcnow().timestamp() * 1000))
        status, posted = self.api_request(
            "POST", "/api/finance/expenses",
            {
                "category": "Packaging",
                "amount": 25000,
                "payment_method": "cash",
                "vendor": "Ledger Test Vendor",
                "receipt_reference": f"RCT-{stamp}",
                "occurred_at": datetime.now().strftime("%Y-%m-%dT%H:%M"),
            },
            TEST_MASTER_KEY,
        )
        self.assertTrue(status.startswith("201"), posted)
        expense_id = posted["expense"]["id"]

        with get_db() as session:
            expense = session.query(ExpenseRecord).filter_by(id=expense_id).first()
            self.assertIsNotNone(expense)
            journal = session.query(AccountingJournalEntry).filter_by(id=expense.journal_entry_id).first()
            self.assertEqual(sum(line.debit for line in journal.lines), 25000)
            self.assertEqual(sum(line.credit for line in journal.lines), 25000)

        status, corrected = self.api_request(
            "PUT", f"/api/finance/expenses/{expense_id}",
            {"category": "Packaging", "amount": 28000, "payment_method": "mobile_money", "vendor": "Corrected Vendor"},
            TEST_MASTER_KEY,
        )
        self.assertTrue(status.startswith("200"), corrected)
        self.assertEqual(corrected["expense"]["amount"], 28000)

        denied_status, _ = self.api_request(
            "GET", "/api/finance/dashboard", terminal_key="3456"
        )
        self.assertTrue(denied_status.startswith("403"), "Cashiers must not access the executive dashboard")
        status, dashboard = self.api_request(
            "GET", "/api/finance/dashboard", terminal_key=TEST_MASTER_KEY,
            query=f"date={datetime.now().strftime('%Y-%m-%d')}",
        )
        self.assertTrue(status.startswith("200"), dashboard)
        self.assertIn("gross_profit", dashboard["metrics"])
        self.assertGreaterEqual(dashboard["metrics"]["expenses"], 28000)

        status, voided = self.api_request(
            "POST", f"/api/finance/expenses/{expense_id}/void",
            {"reason": "Automated audit test"}, TEST_MASTER_KEY,
        )
        self.assertTrue(status.startswith("200"), voided)
        self.assertEqual(voided["expense"]["status"], "VOID")

        journal_status, audit = self.api_request(
            "GET", "/api/finance/journal", terminal_key=TEST_MASTER_KEY,
            query=f"search={expense_id}",
        )
        self.assertTrue(journal_status.startswith("200"), audit)
        self.assertGreaterEqual(len(audit["lines"]), 6)
        self.assertEqual(audit["totals"]["difference"], 0)

        with get_db() as session:
            entries = session.query(AccountingJournalEntry).filter(
                AccountingJournalEntry.reference.like(f"%{expense_id}%")
            ).all()
            self.assertGreaterEqual(len(entries), 3)
            for entry in entries:
                self.assertEqual(sum(line.debit for line in entry.lines), sum(line.credit for line in entry.lines))
        print("✅ PASS: Expense posting, audited edit/void reversals, and dashboard reporting verified.")

    def test_10_stock_lot_cost_aging_markdown_and_writeoff(self):
        """Landed unit costs flow into intake; aging actions sync prices and post losses."""
        stamp = str(int(datetime.utcnow().timestamp() * 1000))
        status, lot_data = self.api_request(
            "POST", "/api/finance/stock-lots",
            {
                "lot_code": f"TEST-BALE-{stamp}",
                "supplier": "Test Bale Supplier",
                "description": "Four-piece accounting test bale",
                "acquisition_cost": 100000,
                "shipping_cost": 20000,
                "item_count": 4,
                "payment_method": "bank",
            },
            TEST_MASTER_KEY,
        )
        self.assertTrue(status.startswith("201"), lot_data)
        lot = lot_data["stock_lot"]
        self.assertEqual(lot["unit_cost"], 30000)
        with get_db() as session:
            lot_journal = session.query(AccountingJournalEntry).filter_by(id=lot["journal_entry_id"]).first()
            self.assertEqual(sum(line.debit for line in lot_journal.lines), 120000)
            self.assertEqual(sum(line.credit for line in lot_journal.lines), 120000)

        product_id = f"PRD-FIN-{stamp}"
        status, product_data = self.api_request(
            "POST", "/api/products",
            {
                "id": product_id,
                "sku": f"SKU-FIN-{stamp}",
                "barcode_id": f"BAR-FIN-{stamp}",
                "name": "Aging Ledger Test Piece",
                "demographic": "Women",
                "category": "Dresses & Skirts",
                "condition": "Grade A — Excellent",
                "selling_price": 80000,
                "cost_price": 0,
                "in_stock_count": 2,
                "stock_lot_id": lot["id"],
            },
            TEST_MASTER_KEY,
        )
        self.assertTrue(status.startswith("201"), product_data)
        self.assertEqual(product_data["product"]["cost_price"], 30000)

        with get_db() as session:
            product = session.query(Product).filter_by(id=product_id).first()
            product.created_at = datetime.utcnow() - timedelta(days=100)

        status, aging = self.api_request(
            "GET", "/api/finance/aging", terminal_key=TEST_MASTER_KEY, query="days=90"
        )
        self.assertTrue(status.startswith("200"), aging)
        self.assertIn(product_id, [row["id"] for row in aging["products"]])

        status, markdown = self.api_request(
            "POST", f"/api/finance/aging/{product_id}/markdown",
            {"new_price": 60000, "reason": "90-day sell-through"}, TEST_MASTER_KEY,
        )
        self.assertTrue(status.startswith("200"), markdown)
        self.assertEqual(markdown["product"]["selling_price"], 60000)

        status, writeoff = self.api_request(
            "POST", f"/api/finance/aging/{product_id}/write-off",
            {"reason": "Damaged during automated test"}, TEST_MASTER_KEY,
        )
        self.assertTrue(status.startswith("200"), writeoff)
        self.assertEqual(writeoff["adjustment"]["loss_amount"], 60000)
        self.assertEqual(writeoff["product"]["inventory_status"], "WRITTEN_OFF")
        with get_db() as session:
            journal = session.query(AccountingJournalEntry).filter_by(
                id=writeoff["adjustment"]["journal_entry_id"]
            ).first()
            self.assertEqual(sum(line.debit for line in journal.lines), 60000)
            self.assertEqual(sum(line.credit for line in journal.lines), 60000)
            saved_lot = session.query(StockLot).filter_by(id=lot["id"]).first()
            self.assertEqual(saved_lot.allocated_count, 2)
        print("✅ PASS: Bale landed costs, aging, live markdown, and balanced write-off verified.")

    def test_11_pos_lock_blocks_storefront_and_is_consumed(self):
        """A scanned POS item is unavailable online until its hold is released or consumed."""
        product_id = "PRD-1004"
        owner = f"LOCK-TEST-{int(datetime.utcnow().timestamp() * 1000)}"
        with get_db() as session:
            product = session.query(Product).filter_by(id=product_id).first()
            product.in_stock_count = 1
            product.inventory_status = "AVAILABLE"
            session.query(InventoryLock).filter_by(product_id=product_id).delete()

        status, held = self.api_request(
            "POST", "/api/inventory-locks/acquire",
            {"product_id": product_id, "lock_owner": owner, "quantity": 1},
            TEST_MASTER_KEY,
        )
        self.assertTrue(status.startswith("200"), held)

        status, public_data = self.api_request("GET", "/api/products", query="availability=public")
        self.assertTrue(status.startswith("200"))
        public_product = next(row for row in public_data["products"] if row["id"] == product_id)
        self.assertEqual(public_product["in_stock_count"], 0)

        status, blocked = self.api_request(
            "POST", "/api/orders",
            {"channel": "web", "items": [{"product_id": product_id, "qty": 1}]},
        )
        self.assertTrue(status.startswith("409"), blocked)

        status, sold = self.api_request(
            "POST", "/api/orders",
            {
                "channel": "pos", "lock_owner": owner,
                "items": [{"product_id": product_id, "qty": 1}],
                "tender": {"type": "cash", "tendered": 95000},
            },
            TEST_MASTER_KEY,
        )
        self.assertTrue(status.startswith("201"), sold)
        with get_db() as session:
            product = session.query(Product).filter_by(id=product_id).first()
            self.assertEqual(product.in_stock_count, 0)
            self.assertEqual(session.query(InventoryLock).filter_by(lock_owner=owner).count(), 0)
            journal = session.query(AccountingJournalEntry).filter_by(
                reference=sold["order"]["id"], source="pos_sale"
            ).first()
            self.assertIsNotNone(journal)
            self.assertEqual(sum(line.debit for line in journal.lines), sum(line.credit for line in journal.lines))
        print("✅ PASS: POS scan hold blocked web checkout and was atomically consumed by the sale.")


if __name__ == "__main__":
    unittest.main()
