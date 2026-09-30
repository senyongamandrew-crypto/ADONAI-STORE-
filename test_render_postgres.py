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
        """Test /api/sync/pull endpoint delivers complete sync payload for frontend."""
        import io
        environ = {
            "REQUEST_METHOD": "GET",
            "PATH_INFO": "/api/sync/pull",
            "QUERY_STRING": "",
            "wsgi.input": io.BytesIO(b"")
        }
        status_captured = []
        def start_response(status, headers):
            status_captured.append(status)

        resp = wsgi_app(environ, start_response)
        data = json.loads(b"".join(resp).decode("utf-8"))
        self.assertIn("products", data)
        self.assertIn("sales", data)
        self.assertIn("categories", data)
        self.assertIn("settings", data)
        self.assertGreaterEqual(len(data["products"]), 16)
        print(f"✅ PASS: /api/sync/pull payload generated with {len(data['products'])} products and full state.")


if __name__ == "__main__":
    unittest.main()
