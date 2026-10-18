"""Regression tests for host-independent product media references.

A garment photo is stored as /api/media/<32 hex>, never as an absolute URL
that names one particular hostname. The Android terminal used to save the
absolute web origin (DB.apiUrl() prefixes it outside the browser); a
storefront served from the apex domain, a custom domain or a preview host
then had every card blocked by its CSP (img-src 'self') — the "product
images do not load" report.

Run: .venv/bin/python -m unittest discover -s tests -p test_media_urls.py -v
"""
from pathlib import Path
import io
import urllib.parse
import json
import os
import sys
import tempfile
import unittest

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
_TEMP = tempfile.TemporaryDirectory(prefix="adonai-media-url-tests-")
os.environ.update({
    "DATABASE_URL": "sqlite:///" + str(Path(_TEMP.name) / "media-urls.db"),
    "ADONAI_REQUIRE_STAFF_AUTH": "0",
    "ADONAI_RATE_LIMIT_DISABLED": "1",
    "ADONAI_SEED_DEMO_CATALOG": "0",
    "ADONAI_SEED_DEMO_USERS": "0",
})
import database
database.IS_POSTGRES = False
from database import get_db
from db_init import init_db, repair_product_media_urls
from models import Inventory, NotificationEvent, PosAccessKey, PosAccessSession, Product, ProductMedia, StoreSetting
import access_control
import api
from security import canonical_image_url, safe_image_url

MEDIA_ID = "0123456789abcdef0123456789abcdef"
OTHER_ID = "fedcba9876543210fedcba9876543210"


class CanonicalImageUrlTests(unittest.TestCase):
    def test_hosted_media_references_become_root_relative(self):
        self.assertEqual(
            canonical_image_url(f"https://www.adonaithrift-store.online/api/media/{MEDIA_ID}"),
            f"/api/media/{MEDIA_ID}",
        )
        self.assertEqual(
            canonical_image_url(f"https://adonaithrift-store.online/api/media/{MEDIA_ID.upper()}?w=320"),
            f"/api/media/{MEDIA_ID}",
        )
        self.assertEqual(
            canonical_image_url(f"//preview-abc.onrender.com/api/media/{MEDIA_ID}"),
            f"/api/media/{MEDIA_ID}",
        )
        self.assertEqual(
            canonical_image_url(f"https://www.adonaithrift-store.online/api/promo-media/{MEDIA_ID}"),
            f"/api/promo-media/{MEDIA_ID}",
        )

    def test_relative_references_are_already_canonical(self):
        for value in (
            f"/api/media/{MEDIA_ID}",
            f"api/media/{MEDIA_ID}",
            f"/api/media/{MEDIA_ID}?w=96",
            "/assets/products/p1001.jpg",
            "assets/products/p1001.jpg",
            "data:image/jpeg;base64,AAAA",
            "https://images.unsplash.com/photo-123.jpg",
        ):
            self.assertEqual(canonical_image_url(value), canonical_image_url(canonical_image_url(value)))

    def test_store_owned_absolute_assets_become_root_relative(self):
        self.assertEqual(
            canonical_image_url("https://www.adonaithrift-store.online/assets/products/p1001.jpg?v=3"),
            "/assets/products/p1001.jpg",
        )
        self.assertEqual(
            canonical_image_url("https://adonai-thrift-store.onrender.com/assets/products/p1001.jpg"),
            "/assets/products/p1001.jpg",
        )
        # A third-party host with its own /assets/ folder is left alone.
        self.assertEqual(
            canonical_image_url("https://cdn.example.com/assets/photo.jpg"),
            "https://cdn.example.com/assets/photo.jpg",
        )

    def test_safe_image_url_canonicalizes_but_still_rejects_unsafe_schemes(self):
        self.assertEqual(safe_image_url(f"https://www.adonaithrift-store.online/api/media/{MEDIA_ID}?w=640"),
                         f"/api/media/{MEDIA_ID}")
        self.assertEqual(safe_image_url("javascript:alert(1)"), "")
        self.assertEqual(safe_image_url("data:text/html,<script>alert(1)</script>"), "")
        self.assertEqual(safe_image_url("https://images.unsplash.com/photo-1.jpg"),
                         "https://images.unsplash.com/photo-1.jpg")


class ProductMediaUrlApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        assert init_db(), "Isolated schema failed to initialize"
        image = Image.new("RGB", (600, 800), "#8a9bb0")
        output = io.BytesIO()
        image.save(output, "JPEG")
        cls.photo_bytes = output.getvalue()

    def setUp(self):
        with get_db() as session:
            for model in (ProductMedia, Inventory, Product, NotificationEvent,
                          PosAccessSession, PosAccessKey):
                session.query(model).delete(synchronize_session=False)
            session.query(StoreSetting).filter(
                StoreSetting.key.in_([access_control.POLICY_KEY, "storefront_promo_ids"])
            ).delete()

    def raw(self, method, path, body=b"", headers=None):
        parsed = urllib.parse.urlsplit(path)
        query = urllib.parse.parse_qs(parsed.query)
        return api.handle_api_request(method, parsed.path, query, body,
                                      headers=headers or {}, client_addr="media-url-tests")

    def request(self, method, path, body=None):
        result = self.raw(method, path, json.dumps(body).encode() if body is not None else b"")
        return result[0], json.loads(result[2])

    def upload(self, color="#445566"):
        image = Image.new("RGB", (600, 800), color)
        output = io.BytesIO()
        image.save(output, "JPEG")
        result = self.raw("POST", "/api/media/images", output.getvalue(), {"x-file-name": "front.jpg"})
        self.assertEqual(result[0], 201, result[2])
        return json.loads(result[2])["media"]

    def create_product(self, **extra):
        body = {
            "name": "Host-independent photo piece",
            "sku": "MEDIA-URL-TEST",
            "barcode_id": "MEDIA-URL-TEST-1OF1",
            "item_condition": "PRE_LOVED",
            "in_stock_count": 1,
            "cost_price": 10000,
            "base_price": 40000,
            "total_transport_cost": 0,
        }
        body.update(extra)
        status, data = self.request("POST", "/api/products", body)
        self.assertEqual(status, 201, data)
        return data["product"]

    def test_absolute_media_url_is_stored_and_served_root_relative(self):
        media = self.upload()
        absolute = f"https://www.adonaithrift-store.online{media['url']}"
        product = self.create_product(image_url=absolute, images=[absolute])

        self.assertEqual(product["image_url"], media["url"])
        self.assertEqual(product["images"], [media["url"]])

        with get_db() as session:
            row = session.query(Product).filter_by(id=product["id"]).one()
            self.assertEqual(row.image_url, media["url"])
            self.assertEqual(json.loads(row.images_json), [media["url"]])

        # And the public catalog does not leak the old host to the browser.
        status, data = self.request("GET", "/api/products?availability=public")
        self.assertEqual(status, 200)
        listed = next(item for item in data["products"] if item["id"] == product["id"])
        self.assertEqual(listed["image_url"], media["url"])
        self.assertTrue(all(url.startswith("/api/media/") for url in listed["images"]))

        served = self.raw("GET", media["url"])
        self.assertEqual(served[0], 200)
        self.assertEqual(served[1], "image/jpeg")

    def test_legacy_absolute_rows_are_normalized_on_read_and_repaired(self):
        first = self.upload("#112233")
        second = self.upload("#334455")
        absolute_first = f"https://adonaithrift-store.online{first['url']}?w=480"
        with get_db() as session:
            session.add(Product(
                id="PRD-LEGACY-ABS", sku="LEGACY-ABS", slug="legacy-abs",
                barcode_id="ADT-LEGACY-ABS", name="Legacy absolute row",
                brand="Unbranded", color="Black", demographic="Men",
                category="Tops & Shirts", size="M", condition="Grade A — Excellent",
                item_condition="PRE_LOVED", selling_price=30000, base_price=30000,
                total_transport_cost=0, in_stock_count=1, desc="Legacy row",
                image_url=absolute_first,
                images_json=json.dumps([absolute_first, second["url"]]),
                inventory_status="AVAILABLE",
            ))
            session.flush()
            # Attachment is what makes media publicly readable.
            session.query(ProductMedia).filter_by(id=first["id"]).one().product_id = "PRD-LEGACY-ABS"
            session.query(ProductMedia).filter_by(id=second["id"]).one().product_id = "PRD-LEGACY-ABS"

        status, data = self.request("GET", "/api/products?availability=public")
        self.assertEqual(status, 200)
        listed = next(item for item in data["products"] if item["id"] == "PRD-LEGACY-ABS")
        self.assertEqual(listed["image_url"], first["url"])
        self.assertEqual(listed["images"], [first["url"], second["url"]])

        # The boot repair writes the same canonical form back to the row.
        with get_db() as session:
            self.assertEqual(repair_product_media_urls(session), 2)
            row = session.query(Product).filter_by(id="PRD-LEGACY-ABS").one()
            self.assertEqual(row.image_url, first["url"])
            self.assertEqual(json.loads(row.images_json), [first["url"], second["url"]])
        with get_db() as session:
            self.assertEqual(repair_product_media_urls(session), 0, "repair is idempotent")

    def test_external_cdn_references_are_preserved(self):
        external = "https://images.unsplash.com/photo-1503342217505-b0a15ec3261c.jpg"
        product = self.create_product(image_url=external, images=[external])
        self.assertEqual(product["image_url"], external)
        self.assertEqual(product["images"], [external])

    def test_storefront_payload_never_contains_an_absolute_media_host(self):
        media = self.upload("#667788")
        self.create_product(
            sku="MEDIA-URL-TEST-2",
            barcode_id="MEDIA-URL-TEST-2OF1",
            image_url=f"https://www.adonaithrift-store.online{media['url']}",
            images=[f"https://www.adonaithrift-store.online{media['url']}"],
        )
        status, data = self.request("GET", "/api/products?availability=public")
        self.assertEqual(status, 200)
        serialized = json.dumps(data)
        self.assertNotIn("adonaithrift-store.online/api/media", serialized)
        self.assertNotIn("onrender.com/api/media", serialized)


if __name__ == "__main__":
    unittest.main(verbosity=2)
