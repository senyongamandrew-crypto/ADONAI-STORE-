"""Storefront media derivatives and the public catalog payload.

A shopper on a phone must not download a full-resolution master photo to see
a 280px card, and the public catalog must not publish internal costing.

Run: .venv/bin/python -m unittest discover -s tests -p test_media_derivatives.py -v
"""
import io
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
_TEMP = tempfile.TemporaryDirectory(prefix="adonai-derivative-tests-")
os.environ.update({"DATABASE_URL": "sqlite:///" + str(Path(_TEMP.name) / "derivative.db"),
                   "ADONAI_REQUIRE_STAFF_AUTH": "0", "ADONAI_RATE_LIMIT_DISABLED": "1",
                   "ADONAI_SEED_DEMO_CATALOG": "0", "ADONAI_SEED_DEMO_USERS": "0"})
import database
database.IS_POSTGRES = False
from database import get_db
from db_init import init_db
from models import Product, ProductMedia, StoreSetting, Inventory, NotificationEvent, PosAccessSession, PosAccessKey
import access_control
import api
import media


def photo_bytes(width=1400, height=1800, colour="#8a5a44"):
    image = Image.new("RGB", (width, height), colour)
    for y in range(0, height, 60):
        for x in range(0, width, 60):
            if (x // 60 + y // 60) % 2 == 0:
                image.paste((210, 160, 130), (x, y, x + 60, y + 60))
    buffer = io.BytesIO()
    image.save(buffer, "JPEG", quality=88)
    return buffer.getvalue()


class MediaDerivativeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        assert init_db(), "Isolated derivative schema failed to initialize"
        cls.master = photo_bytes()

    def setUp(self):
        with get_db() as session:
            for model in [ProductMedia, Inventory, Product, NotificationEvent, PosAccessSession, PosAccessKey]:
                session.query(model).delete(synchronize_session=False)
            session.query(StoreSetting).filter(StoreSetting.key.in_([access_control.POLICY_KEY, "storefront_promo_ids"])).delete()

    # ---------------- helpers ----------------

    def raw(self, method, path, body=b"", headers=None, query=None):
        return api.handle_api_request(method, path, query or {}, body,
                                      headers=headers or {}, client_addr="derivative-tests")

    def product(self, **extra):
        body = {"name": "Isolated garment", "sku": "DERIV-1", "barcode_id": "DERIV-1OF1",
                "item_condition": "PRE_LOVED", "in_stock_count": 1, "cost_price": 10000,
                "base_price": 46500, "total_transport_cost": 7000}
        body.update(extra)
        status, content_type, payload = self.raw("POST", "/api/products", json.dumps(body).encode())
        self.assertEqual(status, 201, payload)
        return json.loads(payload)["product"]

    def attach_photo(self, product_id, data=None, uploaded_by="STF-01"):
        raw = data if data is not None else self.master
        with get_db() as session:
            session.add(ProductMedia(id="a" * 32, kind="image", mime_type="image/jpeg",
                                     filename="garment.jpg", byte_length=len(raw),
                                     width=1400, height=1800, data=raw,
                                     uploaded_by=uploaded_by, product_id=product_id))
            session.commit()
        return "a" * 32

    def attach_draft_photo(self, data=None):
        raw = data if data is not None else self.master
        with get_db() as session:
            session.add(ProductMedia(id="b" * 32, kind="image", mime_type="image/jpeg",
                                     filename="draft.jpg", byte_length=len(raw),
                                     width=1400, height=1800, data=raw, uploaded_by="STF-01"))
            session.commit()
        return "b" * 32

    # ---------------- derivatives ----------------

    def test_a_width_hint_returns_a_small_re_encode_of_the_master(self):
        product = self.product()
        media_id = self.attach_photo(product["id"])
        status, content_type, payload = self.raw("GET", "/api/media/" + media_id, query={"w": ["320"]})
        self.assertEqual(status, 200, payload)
        self.assertIn("webp", content_type.lower())
        self.assertLess(len(payload), len(self.master) / 2,
                        "a 320px derivative must be far smaller than the master")
        with Image.open(io.BytesIO(payload)) as image:
            self.assertEqual(image.width, 320)
            self.assertEqual(image.format, "WEBP")

    def test_every_supported_width_is_served(self):
        product = self.product()
        media_id = self.attach_photo(product["id"])
        for width in media.MEDIA_WIDTHS:
            status, content_type, payload = self.raw("GET", "/api/media/" + media_id, query={"w": [str(width)]})
            self.assertEqual(status, 200, payload)
            self.assertIn("webp", content_type.lower())

    def test_the_master_is_never_upscaled(self):
        product = self.product()
        media_id = self.attach_photo(product["id"])
        status, content_type, payload = self.raw("GET", "/api/media/" + media_id, query={"w": ["4000"]})
        self.assertEqual(status, 200, payload)
        with Image.open(io.BytesIO(payload)) as image:
            self.assertLessEqual(image.width, 1400, "the server must not enlarge a photo")

    def test_the_full_size_photo_is_unchanged(self):
        product = self.product()
        media_id = self.attach_photo(product["id"])
        status, content_type, payload = self.raw("GET", "/api/media/" + media_id)
        self.assertEqual(status, 200, payload)
        self.assertEqual(payload, self.master, "the original bytes are still served as-is")
        self.assertIn("jpeg", content_type.lower())

    def test_a_derivative_has_its_own_cache_identity(self):
        product = self.product()
        media_id = self.attach_photo(product["id"])
        result = self.raw("GET", "/api/media/" + media_id, query={"w": ["320"]})
        headers = getattr(result, "headers", {})
        derivative_etag = headers.get("ETag")
        self.assertIsNotNone(derivative_etag, "a derivative carries its own ETag")
        self.assertIn("w320", derivative_etag)
        self.assertIn("max-age", (headers.get("Cache-Control") or ""))

    def test_a_conditional_derivative_request_is_answered_with_not_modified(self):
        product = self.product()
        media_id = self.attach_photo(product["id"])
        result = self.raw("GET", "/api/media/" + media_id, query={"w": ["320"]})
        etag = getattr(result, "headers", {}).get("ETag")
        status, _, payload = self.raw("GET", "/api/media/" + media_id, query={"w": ["320"]},
                                       headers={"if-none-match": etag})
        self.assertEqual(status, 304, payload)

    def test_a_private_draft_photo_is_still_not_public(self):
        media_id = self.attach_draft_photo()
        for query in ({}, {"w": ["320"]}):
            status, _, payload = self.raw("GET", "/api/media/" + media_id, query=query)
            self.assertEqual(status, 404, payload)

    def test_an_unknown_width_falls_back_to_the_master(self):
        product = self.product()
        media_id = self.attach_photo(product["id"])
        status, content_type, payload = self.raw("GET", "/api/media/" + media_id, query={"w": ["banana"]})
        self.assertEqual(status, 200, payload)
        self.assertIn("jpeg", content_type.lower())

    def test_a_video_is_never_re_encoded(self):
        product = self.product()
        with get_db() as session:
            asset = ProductMedia(id="c" * 32, kind="video", mime_type="video/mp4",
                                 filename="clip.mp4", byte_length=4, width=0, height=0,
                                 data=b"\x00\x00\x00\x00", uploaded_by="STF-01", product_id=product["id"])
            session.add(asset)
            session.commit()
        status, content_type, payload = self.raw("GET", "/api/media/" + ("c" * 32), query={"w": ["320"]})
        self.assertEqual(status, 200, payload)
        self.assertIn("mp4", content_type.lower())
        self.assertEqual(payload, b"\x00\x00\x00\x00")

    # ---------------- public catalog payload ----------------

    def test_the_public_catalog_never_publishes_internal_costing(self):
        self.product()
        status, _, payload = self.raw("GET", "/api/products", query={"availability": ["public"]})
        self.assertEqual(status, 200, payload)
        data = json.loads(payload)
        self.assertTrue(data["products"], "the seeded garment is on the public rail")
        for product in data["products"]:
            for field in ("cost_price", "staff_notes", "stock_lot_id", "lot_grade_id",
                          "base_price", "total_transport_cost", "checkout_transport_portion"):
                self.assertNotIn(field, product,
                                 f"the public catalog must not publish {field}")
            self.assertIn("delivery_fee", product)

    def test_the_public_product_detail_page_never_publishes_internal_costing(self):
        product = self.product()
        status, _, payload = self.raw("GET", "/api/products/" + product["id"])
        self.assertEqual(status, 200, payload)
        data = json.loads(payload)["product"]
        for field in ("cost_price", "staff_notes", "stock_lot_id", "lot_grade_id"):
            self.assertNotIn(field, data)
        self.assertIn("specifications", data, "the detail page keeps its public specifications")


if __name__ == "__main__":
    unittest.main()
