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
11. Product Detail Page contract: slugs, flat-lay measurements, flaw
    disclosure and server-rendered SEO markup on /product/<slug>
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
from db_init import (
    PRODUCT_POLICY_CONSTRAINTS,
    _dual_inventory_backfill_statements,
    init_db,
)
from serve import app, wsgi_app


class TestRenderPostgresHardening(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        """Guarantee a migrated, seeded schema for every test.

        Tests used to inherit the schema from whichever test happened to run
        first (alphabetical ordering), so running a single test by name hit
        "no such table: products". init_db() is idempotent, so calling it here
        is free and makes each test independently runnable.
        """
        os.environ.pop("DATABASE_URL", None)
        if not init_db():
            raise RuntimeError("Test schema bootstrap failed — see the init_db log above.")

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

    def test_02b_postgres_enum_backfill_uses_explicit_casts(self):
        """Native PostgreSQL enum migrations must not rely on implicit casts."""
        statements = _dual_inventory_backfill_statements(
            postgres=True,
            item_condition_is_enum=True,
            quantity_type_is_enum=True,
        )
        item_backfill, invalid_quantity_backfill, mismatched_quantity_backfill = statements

        self.assertIn("THEN 'BRAND_NEW'::item_condition_enum", item_backfill)
        self.assertIn("ELSE 'PRE_LOVED'::item_condition_enum", item_backfill)
        self.assertIn("item_condition::text NOT IN", item_backfill)
        self.assertIn("SET quantity_type = item_condition::text::quantity_type_enum", invalid_quantity_backfill)
        self.assertIn("SET quantity_type = item_condition::text::quantity_type_enum", mismatched_quantity_backfill)
        self.assertIn("quantity_type::text = 'PRE_LOVED'", mismatched_quantity_backfill)

        legacy_statements = _dual_inventory_backfill_statements(
            postgres=True,
            item_condition_is_enum=False,
            quantity_type_is_enum=False,
        )
        self.assertNotIn("::item_condition_enum", legacy_statements[0])
        self.assertIn("SET quantity_type = item_condition::text", legacy_statements[1])
        print("✅ PASS: PostgreSQL enum backfill uses safe, explicit casts.")

    def test_02c_policy_constraints_are_redeploy_safe(self):
        """Guard constraints must be added by name-check, never by error-swallowing.

        REGRESSION: `ALTER TABLE ... ADD CONSTRAINT` has no IF NOT EXISTS form.
        The old code ran all three blindly and ignored errors containing
        "already exists" — but on PostgreSQL the swallowed DuplicateObject had
        already poisoned the transaction, so the *next* statement died with
        "current transaction is aborted, commands ignored until end of
        transaction block" and every redeploy rolled back the migration and
        the seeding with it.
        """
        import inspect as py_inspect

        import db_init

        names = [name for name, _aliases, _definition in PRODUCT_POLICY_CONSTRAINTS]
        self.assertEqual(len(names), len(set(names)), "Constraint names must be unique")
        for name, aliases, definition in PRODUCT_POLICY_CONSTRAINTS:
            self.assertTrue(name.startswith("ck_products_"), name)
            self.assertTrue(definition.startswith("CHECK ("), name)
            self.assertIn("NOT VALID", definition, f"{name} must not rewrite live rows")
            self.assertNotIn(name, aliases)

        source = py_inspect.getsource(db_init.apply_additive_schema_migrations)
        self.assertIn("_postgres_constraint_names(connection", source)

        # Every write in the migration must go through the savepoint helper,
        # so one failure can never poison the surrounding transaction. The
        # helper's own `connection.execute` is the one legitimate call site —
        # it already sits inside `with connection.begin_nested()`.
        import ast
        import textwrap

        tree = ast.parse(textwrap.dedent(source))
        helper = next(
            node for node in ast.walk(tree)
            if isinstance(node, ast.FunctionDef) and node.name == "run_isolated"
        )
        helper_lines = range(helper.lineno, (helper.end_lineno or helper.lineno) + 1)
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call):
                continue
            func = node.func
            if (
                isinstance(func, ast.Attribute)
                and func.attr == "execute"
                and isinstance(func.value, ast.Name)
                and func.value.id == "connection"
                and node.lineno not in helper_lines
            ):
                self.fail(
                    "Un-isolated connection.execute() at line "
                    f"{node.lineno} of apply_additive_schema_migrations — route it "
                    "through run_isolated() so a failure cannot abort the transaction."
                )

        # No code path may decide "this error is harmless" by substring-matching
        # the driver's message: by the time PostgreSQL reports "already exists"
        # the transaction is already unusable. Only real string literals are
        # inspected here, so explanatory comments stay allowed.
        import io as _io
        import tokenize

        literals = [
            token.string
            for token in tokenize.generate_tokens(_io.StringIO(source).readline)
            if token.type == tokenize.STRING and not token.string.lstrip("rbfu").startswith(('"""', "'''"))
        ]
        for literal in literals:
            self.assertNotIn(
                "already exists", literal.lower(),
                "Swallowing 'already exists' leaves the PostgreSQL transaction aborted; "
                "check pg_constraint up front instead.",
            )

        # The explicit SQL migration must stay in sync: any constraint it
        # installs for the same rule has to be listed as an alias, otherwise a
        # psql-migrated database ends up with two copies of the same CHECK.
        migration_sql = open(
            os.path.join(os.path.dirname(os.path.abspath(__file__)),
                         "migrations", "20261003_dual_inventory.sql")
        ).read()
        declared = {name for name, _a, _d in PRODUCT_POLICY_CONSTRAINTS}
        for name, aliases, _definition in PRODUCT_POLICY_CONSTRAINTS:
            declared.update(aliases)
        for token in migration_sql.split():
            if token.startswith("ck_products_"):
                self.assertIn(
                    token.strip(","), declared,
                    f"{token} exists in the SQL migration but db_init does not know it — "
                    "add it to PRODUCT_POLICY_CONSTRAINTS aliases.",
                )
        print(f"✅ PASS: {len(names)} policy constraints are idempotent and savepoint-isolated.")

    def test_02d_seed_catalog_obeys_preloved_single_quantity(self):
        """PRE_LOVED stock is one-of-a-kind — seeds must never ship quantity 2.

        REGRESSION: three seeded pre-loved rows carried quantity 2, which the
        API rejects (`api.py`), ck_products_stock_policy rejects, and the
        dual-inventory trigger rejects. On a fresh PostgreSQL database that
        aborted the entire seeding transaction, leaving the live store with no
        categories, settings or riders at all.
        """
        with get_db() as session:
            seeded = session.query(Product).filter(Product.id.like("PRD-10%")).all()
            self.assertGreaterEqual(len(seeded), 16)
            offenders = []
            brand_new = 0
            for product in seeded:
                condition = getattr(product.item_condition, "value", product.item_condition)
                quantity_type = getattr(product.quantity_type, "value", product.quantity_type)
                self.assertEqual(
                    condition, quantity_type,
                    f"{product.id}: quantity_type must mirror item_condition",
                )
                if condition == "PRE_LOVED" and product.in_stock_count not in (0, 1):
                    offenders.append(f"{product.id} ({product.name}) qty={product.in_stock_count}")
                if condition == "BRAND_NEW":
                    brand_new += 1
            self.assertEqual(offenders, [], "PRE_LOVED seeds must hold quantity 0 or 1: " + "; ".join(offenders))
            self.assertGreaterEqual(brand_new, 2, "Seed must prove the BRAND_NEW stream too")
        print(f"✅ PASS: Seed catalog honours the dual-inventory quantity policy ({brand_new} brand-new lines).")

    def test_02e_init_db_is_idempotent_across_redeploys(self):
        """Every redeploy re-runs init_db(); it must stay green and keep seeds."""
        with get_db() as session:
            before = session.query(Category).count()
        for attempt in (1, 2):
            self.assertTrue(init_db(), f"init_db() must succeed on redeploy #{attempt}")
        with get_db() as session:
            after = session.query(Category).count()
            self.assertEqual(before, after, "Re-running init_db must not duplicate seed rows")
            self.assertGreaterEqual(after, 7, "Seed categories must survive redeploys")
        print("✅ PASS: init_db() is idempotent across repeated redeploys.")

    def test_03_concurrent_inventory_deduction(self):
        """Simulate high-concurrency order placement and verify atomic inventory safety."""
        # Must be a BRAND_NEW line: PRE_LOVED pieces are one-of-a-kind, so
        # ck_products_stock_policy on PostgreSQL rejects the quantity-2 reset
        # below. Using a factory row keeps this test valid on both backends.
        target_product_id = "PRD-1017"  # Essential Cotton Crew Tee (BRAND_NEW)

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

    def html_request(self, path, query=""):
        """Fetch a server-rendered HTML route through the WSGI app."""
        environ = {
            "REQUEST_METHOD": "GET",
            "PATH_INFO": path,
            "QUERY_STRING": query,
            "CONTENT_LENGTH": "0",
            "wsgi.input": io.BytesIO(b""),
            "HTTP_HOST": "ai-store.onrender.com",
        }
        status = []
        headers = []

        def start_response(value, header_list):
            status.append(value)
            headers.extend(header_list)

        body = b"".join(wsgi_app(environ, start_response))
        return status[0], dict(headers), body.decode("utf-8", "replace")

    def test_12_pdp_fields_persist_and_resolve_by_slug(self):
        """Measurements, fabric, care and flaw disclosure survive a round trip."""
        payload = {
            "name": "Stone Washed Denim Shirt",
            "brand": "Wrangler",
            "color": "Stone",
            "demographic": "Men",
            "category": "Tops & Shirts",
            "size": "L",
            "condition": "Grade B — Good",
            "sku": "ADN-MEN-7781",
            "cost_price": 14000,
            "selling_price": 42000,
            "compare_price": 85000,
            "in_stock_count": 1,
            "fabric": "100% Cotton denim · 8oz",
            "care_notes": "Machine wash cold. Hang dry.",
            "measurements": {"shoulder": 18.5, "chest": 22, "sleeve": 25, "length": 30,
                             "notes": "Measured flat and buttoned."},
            "flaw_notes": "Fray on the left cuff and a faint mark under the collar.",
            "flaw_photo_index": 2,
            "image_url": "assets/products/p1005.jpg",
        }
        status, created = self.api_request("POST", "/api/products", payload, TEST_MASTER_KEY)
        self.assertTrue(status.startswith("201"), created)
        product = created["product"]
        slug = product["slug"]
        self.assertEqual(slug, "stone-washed-denim-shirt-adn-men-7781")

        # The PDP fetches by slug; id, sku and barcode must keep working too.
        for identifier in (slug, product["id"], product["sku"], product["barcode_id"]):
            status, data = self.api_request("GET", f"/api/products/{identifier}")
            self.assertTrue(status.startswith("200"), f"{identifier} -> {data}")
            fetched = data["product"]
            self.assertEqual(fetched["id"], product["id"])
            self.assertEqual(fetched["fabric"], payload["fabric"])
            self.assertEqual(fetched["care_notes"], payload["care_notes"])
            self.assertEqual(fetched["flaw_notes"], payload["flaw_notes"])
            self.assertEqual(fetched["flaw_photo_index"], 2)
            self.assertAlmostEqual(fetched["measurements"]["chest"], 22.0)
            self.assertEqual(fetched["measurements"]["notes"], "Measured flat and buttoned.")
            # One-of-one stock must expose the counts the buy box relies on.
            self.assertIn("available_count", fetched)
            self.assertIn("authoritative_stock_count", fetched)

        # A price must never be advertised as zero.
        self.assertGreater(fetched["final_selling_price"], 0)

        status, missing = self.api_request("GET", "/api/products/no-such-piece-adn-men-0000")
        self.assertTrue(status.startswith("404"), missing)
        print("✅ PASS: PDP fields persist and resolve by slug, id, SKU and barcode.")

    def test_13_product_page_is_server_rendered_for_crawlers(self):
        """/product/<slug> must ship real metadata, not an empty shell."""
        with get_db() as session:
            product = (
                session.query(Product)
                .filter(Product.slug.isnot(None), Product.in_stock_count > 0)
                .first()
            )
            self.assertIsNotNone(product, "A slugged product is required for this test")
            slug, name = product.slug, product.name

        status, headers, html = self.html_request(f"/product/{slug}")
        self.assertTrue(status.startswith("200"), status)
        self.assertIn("text/html", headers.get("Content-Type", ""))

        self.assertIn(name, html)
        self.assertIn('<meta property="og:type" content="product"', html)
        self.assertIn(f"https://ai-store.onrender.com/product/{slug}", html)
        self.assertIn('"@type": "Product"', html)
        self.assertIn('"priceCurrency": "UGX"', html)
        self.assertIn('rel="canonical"', html)
        # The bootstrap payload lets the page paint without a second round trip.
        self.assertIn("window.__ADONAI_PDP_PRODUCT__", html)
        # Inline JSON must not be able to break out of the script element.
        self.assertNotIn("</script>", html.split('<script type="application/ld+json">')[1].split("</script>")[0])

        # Unknown slugs still return a usable page (the client shows "sold or moved").
        status, _, _ = self.html_request("/product/this-piece-does-not-exist")
        self.assertTrue(status.startswith("200") or status.startswith("404"), status)
        print("✅ PASS: /product/<slug> is server-rendered with product SEO metadata.")

    def test_14_sitemap_lists_product_permalinks(self):
        """Every in-stock product needs a crawlable permalink in the sitemap."""
        status, headers, xml = self.html_request("/sitemap.xml")
        self.assertTrue(status.startswith("200"), status)
        self.assertIn("xml", headers.get("Content-Type", ""))
        self.assertIn("<urlset", xml)

        with get_db() as session:
            slugs = [
                row.slug
                for row in session.query(Product)
                .filter(Product.slug.isnot(None), Product.in_stock_count > 0)
                .limit(5)
                .all()
            ]
        self.assertTrue(slugs, "Expected at least one in-stock slugged product")
        for slug in slugs:
            self.assertIn(f"/product/{slug}", xml)
        print(f"✅ PASS: Sitemap exposes product permalinks ({len(slugs)} verified).")

    def test_15_seeded_catalog_is_pdp_ready(self):
        """The seed must demonstrate the PDP: prices, slugs and measurements."""
        with get_db() as session:
            seeded = session.query(Product).filter(Product.id.like("PRD-10%")).all()
            self.assertGreaterEqual(len(seeded), 16)
            for product in seeded:
                self.assertTrue(product.slug, f"{product.id} is missing a slug")
                data = product.to_dict()
                self.assertGreater(
                    data["final_selling_price"], 0,
                    f"{product.id} would be advertised at UGX 0",
                )
            with_measurements = [p for p in seeded if (p.to_dict().get("measurements") or {})]
            with_flaws = [p for p in seeded if (p.flaw_notes or "").strip()]
            with_fabric = [p for p in seeded if (p.fabric or "").strip()]
            self.assertGreaterEqual(len(with_measurements), 16, "Every seeded piece needs measurements")
            self.assertGreaterEqual(len(with_fabric), 16, "Every seeded piece needs a fabric line")
            self.assertGreaterEqual(len(with_flaws), 5, "Flaw disclosure must be demonstrated in the seed")
        print(f"✅ PASS: Seed catalog is PDP-ready ({len(with_measurements)} measured, {len(with_flaws)} with disclosed flaws).")

    def test_16_strategy_insights_endpoint(self):
        """The strategy & marketing insights endpoint is manager-only, validates
        the window, and returns the full decision payload (KPIs, trend, channels,
        customers, marketing ROI, data reliability, recommendations)."""
        status, body = self.api_request("GET", "/api/finance/insights")
        self.assertTrue(status.startswith("401"), f"Insights must require staff auth, got {status}")

        status, body = self.api_request("GET", "/api/finance/insights", terminal_key="3456")
        self.assertTrue(status.startswith("403"), f"Cashiers must not read strategy insights, got {status}")

        status, body = self.api_request(
            "GET", "/api/finance/insights", terminal_key=TEST_MASTER_KEY, query="days=45"
        )
        self.assertTrue(status.startswith("400"), f"Only 7/30/90 day windows allowed, got {status}")

        status, data = self.api_request(
            "GET", "/api/finance/insights", terminal_key=TEST_MASTER_KEY, query="days=30"
        )
        self.assertTrue(status.startswith("200"), data)
        self.assertTrue(data.get("ok"), data)
        self.assertEqual(data.get("days"), 30)

        kpis = data.get("kpis") or {}
        for key in ("revenue", "orders", "units", "avg_order_value", "gross_profit",
                    "gross_margin", "expenses", "net_contribution", "delivery_fee_revenue"):
            self.assertIn(key, kpis, f"kpis missing {key}")

        trend = data.get("daily_trend") or []
        self.assertEqual(len(trend), 31, "A 30-day window ends today, so the trend holds 31 day rows")
        for row in trend:
            self.assertIn("date", row)
            self.assertIn("revenue", row)
            self.assertIn("orders", row)
            self.assertIn("profit", row)

        for section in ("channels", "categories", "top_products", "customers",
                        "marketing", "stock_signals", "data_quality", "recommendations"):
            self.assertIn(section, data, f"response missing {section}")

        customers = data["customers"]
        for key in ("total", "repeat", "repeat_rate", "top", "identified_order_share"):
            self.assertIn(key, customers, f"customers missing {key}")

        quality = data["data_quality"]
        self.assertGreaterEqual(quality["score"], 0)
        self.assertLessEqual(quality["score"], 100)
        self.assertGreaterEqual(len(quality["checks"]), 5, "Reliability audit needs several checks")
        for check in quality["checks"]:
            self.assertIn("label", check)
            self.assertIn("pass_rate", check)
            self.assertIn("impact", check)
            self.assertGreaterEqual(check["pass_rate"], 0)
            self.assertLessEqual(check["pass_rate"], 100)

        self.assertIsInstance(data["recommendations"], list)
        for rec in data["recommendations"]:
            self.assertIn(rec.get("tone"), {"positive", "action", "warn"})
            self.assertTrue(rec.get("title"))
            self.assertTrue(rec.get("detail"))
        print(f"✅ PASS: Strategy insights — score {quality['score']}%, "
              f"{len(trend)} trend rows, {len(data['recommendations'])} recommendations.")

    def test_17_strategy_insights_reflect_posted_business(self):
        """A freshly posted marketing expense must appear in the marketing ROI
        block of the insights report (data flows from ledgers to strategy)."""
        amount = 12000
        status, posted = self.api_request(
            "POST", "/api/finance/expenses",
            {
                "category": "Marketing",
                "amount": amount,
                "payment_method": "mobile_money",
                "vendor": "TikTok boost",
                "occurred_at": datetime.now().strftime("%Y-%m-%dT%H:%M"),
            },
            TEST_MASTER_KEY,
        )
        self.assertTrue(status.startswith("201"), posted)

        status, data = self.api_request(
            "GET", "/api/finance/insights", terminal_key=TEST_MASTER_KEY, query="days=7"
        )
        self.assertTrue(status.startswith("200"), data)
        marketing = data["marketing"]
        self.assertGreaterEqual(marketing["spend"], amount,
                                "Marketing spend must aggregate posted Marketing expenses")
        self.assertGreaterEqual(marketing["campaigns"], 1)
        self.assertIn("spend_ratio", marketing)
        print(f"✅ PASS: Marketing expense flows into insights "
              f"(spend UGX {marketing['spend']:,}, {marketing['campaigns']} campaigns).")


if __name__ == "__main__":
    unittest.main()
