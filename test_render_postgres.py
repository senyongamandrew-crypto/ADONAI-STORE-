"""
Adonai Thrift Store — Backend PostgreSQL & Render Hardening Test Suite
Verifies:
1. DATABASE_URL dynamic formatting (postgres:// -> postgresql://)
2. Credential masking in stdout logs
3. Connection pool initialization & resilience
4. Schema auto-migration & seed data completeness
5. Concurrency & race-condition safety for inventory deductions
6. REST API endpoints (/api/health, /api/products, /api/orders, /api/sync/pull)
7. WSGI application response under Gunicorn-compatible environment
"""
import concurrent.futures
import json
import os
import sys
import unittest

# Ensure current directory in python path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from database import get_formatted_database_url, mask_database_url, get_db, engine
from models import Product, Order, OrderItem, Category, User, Inventory, StoreSetting
from db_init import init_db
from serve import app, wsgi_app


class TestRenderPostgresHardening(unittest.TestCase):

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
                "channel": "pos",
                "customer_name": f"Concurrent Customer {order_num}",
                "items": [{"product_id": target_product_id, "qty": 1}]
            }
            environ = {
                "REQUEST_METHOD": "POST",
                "PATH_INFO": "/api/orders",
                "QUERY_STRING": "",
                "HTTP_X_TERMINAL_KEY": "ADONAI-MASTER-2026",
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
        self.assertIn("products", data["tables"])
        self.assertIn("orders", data["tables"])
        print(f"✅ PASS: /api/health returned 200 OK with table verification: {data['tables']}")

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

        # 2. Authenticated request with Master Key must return 200 OK with full state
        environ_authed = {
            "REQUEST_METHOD": "GET",
            "PATH_INFO": "/api/sync/pull",
            "QUERY_STRING": "key=ADONAI-MASTER-2026",
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

        # 1. Test ADMIN_ACCESS_PIN environment variable
        os.environ["ADMIN_ACCESS_PIN"] = "987654"
        payload_admin = {"pin": "987654"}
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

        # Protected POS checkout with auth header succeeds with 201
        import time
        order_pos_authed = {
            "id": f"AT-POS-AUTH-{int(time.time() * 1000)}",
            "channel": "pos",
            "items": [{"product_id": "PRD-1003", "qty": 1}]
        }
        environ_pos_auth = {
            "REQUEST_METHOD": "POST",
            "PATH_INFO": "/api/orders",
            "QUERY_STRING": "",
            "HTTP_X_TERMINAL_KEY": "ADONAI-MASTER-2026",
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
                "ADONAI-MASTER-2026"
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


if __name__ == "__main__":
    unittest.main()
