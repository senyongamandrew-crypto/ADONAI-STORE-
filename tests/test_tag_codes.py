"""Stock-tag codes: the permanent, sequential identity printed on small labels.

A 32 × 16 mm thermal tag carries ~99 Code 128 modules, so the full SKU cannot
be printed there. Each piece gets a short numeric code instead, and that code
must resolve to exactly one garment for as long as the label stays attached.
Locks in:

  * codes are sequential, start at 1001, and are never reused;
  * a reprint returns the same code (a tag already on a garment never changes
    identity);
  * the allocator survives a concurrent clash instead of failing the intake;
  * legacy rows and direct-upload inserts are backfilled at boot;
  * the print-time allocator endpoint is staff-only and bounded;
  * the code resolves at checkout and never leaks to the storefront.

Run: python -m unittest discover -s tests -p test_tag_codes.py -v
"""
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
_TEMP = tempfile.TemporaryDirectory(prefix="adonai-tag-tests-")
os.environ.update({
    "DATABASE_URL": "sqlite:///" + str(Path(_TEMP.name) / "tags.db"),
    "ADONAI_REQUIRE_STAFF_AUTH": "0",
    "ADONAI_RATE_LIMIT_DISABLED": "1",
    "ADONAI_SEED_DEMO_CATALOG": "0",
    "ADONAI_SEED_DEMO_USERS": "0",
})
import database
database.IS_POSTGRES = False
from database import get_db
from db_init import init_db
from models import (AccountingJournalEntry, AccountingJournalLine, Inventory, InventoryLock,
                    LedgerEntry, NotificationEvent, Order, OrderItem, Product, ProductMedia,
                    StoreSetting)
import access_control
import api
import tag_codes


def piece(pid, **kwargs):
    values = dict(
        id=pid, sku=f"SKU-{pid}", barcode_id=f"BAR-{pid}", name=f"Piece {pid}",
        demographic="Men", category="Tops & Shirts", size="M",
        item_condition="PRE_LOVED", quantity_type="PRE_LOVED",
        base_price=20000, total_transport_cost=5000, selling_price=25000,
        in_stock_count=1,
    )
    values.update(kwargs)
    return Product(**values)


class TagCodeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        assert init_db(), "Isolated tag-code schema failed to initialize"

    def setUp(self):
        with get_db() as session:
            for model in (OrderItem, InventoryLock, Inventory, ProductMedia, Order,
                          Product, LedgerEntry, AccountingJournalLine,
                          AccountingJournalEntry, NotificationEvent):
                session.query(model).delete(synchronize_session=False)
            session.query(StoreSetting).filter_by(key=access_control.POLICY_KEY).delete()

    def raw(self, method, path, body=None, headers=None, query_params=None):
        encoded = json.dumps(body).encode("utf-8") if body is not None else b""
        return api.handle_api_request(method, path, query_params or {}, encoded,
                                      headers=headers or {}, client_addr="tag-tests")

    # ------------------------------------------------------------------ codes
    def test_codes_are_sequential_and_start_at_1001(self):
        with get_db() as session:
            first, second, third = piece("TAG-1"), piece("TAG-2"), piece("TAG-3")
            session.add_all([first, second, third])
            session.flush()
            codes = [tag_codes.allocate_tag_code(session, row) for row in (first, second, third)]
        self.assertEqual(codes, ["1001", "1002", "1003"], "codes advance in order from 1001")

    def test_a_reprint_keeps_the_same_code(self):
        with get_db() as session:
            product = piece("TAG-REPRINT")
            session.add(product)
            session.flush()
            original = tag_codes.allocate_tag_code(session, product)
            session.commit()
        with get_db() as session:
            stored = session.query(Product).filter_by(id="TAG-REPRINT").one()
            self.assertEqual(stored.tag_code, original)
            self.assertEqual(tag_codes.allocate_tag_code(session, stored), original,
                             "re-printing a tag must never mint a new identity")

    def test_a_collision_does_not_fail_intake(self):
        with get_db() as session:
            taken = piece("TAG-TAKEN", tag_code="1001")
            session.add(taken)
            session.flush()
            contender = piece("TAG-NEXT")
            session.add(contender)
            session.flush()
            code = tag_codes.allocate_tag_code(session, contender)
        self.assertEqual(code, "1002", "the allocated code skips a number already on a label")

    def test_typed_codes_fold_to_the_printed_digits(self):
        self.assertEqual(tag_codes.normalize_tag_code("T-1042"), "1042")
        self.assertEqual(tag_codes.normalize_tag_code(" 1042 "), "1042")
        self.assertEqual(tag_codes.normalize_tag_code(1042), "1042")
        self.assertEqual(tag_codes.normalize_tag_code("1042-1"), "")
        self.assertEqual(tag_codes.normalize_tag_code("ABCD"), "")
        self.assertEqual(tag_codes.normalize_tag_code("1000042"), "", "a 7-digit code cannot be printed at 32 mm")

    def test_boot_backfill_stamps_every_untagged_row_once(self):
        with get_db() as session:
            session.add_all([piece("OLD-1"), piece("OLD-2"), piece("OLD-3", tag_code="1005")])
            session.flush()
            assigned = tag_codes.backfill_tag_codes(session)
            rows = {row.id: row.tag_code for row in session.query(Product).all()}
        self.assertEqual(assigned, 2, "only untagged rows are stamped")
        self.assertEqual(rows["OLD-3"], "1005", "an existing label is never renumbered")
        self.assertEqual({rows["OLD-1"], rows["OLD-2"]}, {"1006", "1007"},
                         "backfill continues above the highest code already printed")

    def test_intake_assigns_the_code_before_the_piece_is_saved(self):
        body = {
            "name": "Intake tag piece", "category": "Tops & Shirts", "subcategory": "T-Shirts",
            "base_price": 25000, "sku": "ADN-TAG-9001", "barcode_id": "ADN-TAG-9001-1OF1",
            "item_condition": "PRE_LOVED", "in_stock_count": 1,
        }
        status, _, payload = self.raw("POST", "/api/products", body)
        self.assertEqual(status, 201, payload)
        product = json.loads(payload)["product"]
        self.assertRegex(product["tag_code"], r"^[0-9]{4,6}$",
                         "a garment is printable the moment it is saved")
        with get_db() as session:
            self.assertEqual(session.query(Product).filter_by(id=product["id"]).one().tag_code,
                             product["tag_code"])

    # ------------------------------------------------------------- endpoint
    def test_print_time_allocator_is_idempotent(self):
        with get_db() as session:
            session.add_all([piece("API-1"), piece("API-2")])
        status, _, payload = self.raw("POST", "/api/products/tag-codes",
                                      {"product_ids": ["API-1", "API-2"]})
        self.assertEqual(status, 200, payload)
        body = json.loads(payload)
        self.assertTrue(body["ok"])
        self.assertEqual(body["codes"], {"API-1": "1001", "API-2": "1002"})
        status, _, again = self.raw("POST", "/api/products/tag-codes",
                                    {"product_ids": ["API-1"]})
        self.assertEqual(json.loads(again)["codes"], {"API-1": "1001"},
                         "asking twice returns the label already on the garment")

    def test_allocator_rejects_an_empty_or_oversized_request(self):
        status, _, payload = self.raw("POST", "/api/products/tag-codes", {"product_ids": []})
        self.assertEqual(status, 400)
        status, _, payload = self.raw("POST", "/api/products/tag-codes",
                                      {"product_ids": [f"P-{i}" for i in range(201)]})
        self.assertEqual(status, 400)
        self.assertIn("at most", json.loads(payload)["error"])

    def test_unknown_pieces_are_reported_not_invented(self):
        status, _, payload = self.raw("POST", "/api/products/tag-codes",
                                      {"product_ids": ["NOPE-1"]})
        body = json.loads(payload)
        self.assertEqual(status, 200)
        self.assertEqual(body["codes"], {})
        self.assertEqual(body["missing"], ["NOPE-1"])

    # ------------------------------------------------------- scanned identity
    def test_a_printed_code_resolves_to_exactly_one_piece(self):
        with get_db() as session:
            product = piece("SCAN-1")
            session.add(product)
            session.flush()
            code = tag_codes.allocate_tag_code(session, product)
            session.commit()
        with get_db() as session:
            for typed in (code, f"T-{code}", f" {code} "):
                found = api.lookup_product(session, typed)
                self.assertIsNotNone(found, f"{typed!r} is what the phone camera sends")
                self.assertEqual(found.id, "SCAN-1")

    def test_the_storefront_never_publishes_tag_codes(self):
        with get_db() as session:
            product = piece("SHOP-1", tag_code="1042")
            session.add(product)
            session.flush()
            payload = product.to_dict()
        self.assertEqual(payload["tag_code"], "1042")
        self.assertNotIn("tag_code", access_control.sanitize_storefront_product(payload),
                         "publishing the code would let anyone forge a label")
        # Staff consoles keep it: Catalog Intake prints exactly this value.
        self.assertEqual(access_control.sanitize_product(payload, {"protected": [], "granted": ["stock"]})["tag_code"], "1042")


if __name__ == "__main__":
    unittest.main()
