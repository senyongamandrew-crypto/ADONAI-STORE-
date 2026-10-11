"""Durable gallery regressions. Every write uses a throwaway SQLite database.
Run: .venv/bin/python -m unittest discover -s tests -p test_product_media.py -v
"""
from datetime import datetime, timedelta
import io
import json
import os
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

from PIL import Image
import imageio_ffmpeg
from sqlalchemy import event, inspect

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
_TEMP = tempfile.TemporaryDirectory(prefix="adonai-media-tests-")
os.environ.update({"DATABASE_URL": "sqlite:///" + str(Path(_TEMP.name) / "media.db"),
                   "ADONAI_REQUIRE_STAFF_AUTH": "0", "ADONAI_RATE_LIMIT_DISABLED": "1",
                   "ADONAI_SEED_DEMO_CATALOG": "0", "ADONAI_SEED_DEMO_USERS": "0"})
import database
# Explicit SQLite URLs currently inherit the deployment flag; pin this isolated
# test's schema migration dialect without changing any real deployment.
database.IS_POSTGRES = False
from database import get_db, engine
from db_init import init_db
from models import Product, ProductMedia, PosAccessKey, PosAccessSession, StoreSetting, Inventory, NotificationEvent
import api
import access_control
import media
import serve


class ProductMediaTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        assert init_db(), "Isolated media schema failed to initialize"
        image = Image.new("RGB", (400, 600), "#779876")
        output = io.BytesIO(); image.save(output, "JPEG"); cls.photo_bytes = output.getvalue()
        path = Path(_TEMP.name) / "short.mov"
        command = [imageio_ffmpeg.get_ffmpeg_exe(), "-nostdin", "-hide_banner", "-loglevel", "error",
                   "-f", "lavfi", "-i", "testsrc2=size=240x320:rate=12", "-t", "2", "-c:v", "libx264",
                   "-threads", "1", "-pix_fmt", "yuv420p", "-metadata", "location=+00.123+032.123/",
                   "-movflags", "+faststart", "-y", str(path)]
        result = subprocess.run(command, capture_output=True, timeout=30)
        assert result.returncode == 0, result.stderr
        cls.video_bytes = path.read_bytes()

    def setUp(self):
        with get_db() as session:
            for model in [ProductMedia, Inventory, Product, NotificationEvent, PosAccessSession, PosAccessKey]:
                session.query(model).delete(synchronize_session=False)
            session.query(StoreSetting).filter_by(key=access_control.POLICY_KEY).delete()

    def raw(self, method, path, body=b"", headers=None):
        return api.handle_api_request(method, path, {}, body, headers=headers or {}, client_addr="media-tests")

    def request(self, method, path, body=None, headers=None):
        result = self.raw(method, path, json.dumps(body).encode() if body is not None else b"", headers)
        return result[0], json.loads(result[2])

    def upload(self, kind="image", data=None, headers=None):
        result = self.raw("POST", "/api/media/" + ("images" if kind == "image" else "videos"),
                          data if data is not None else (self.photo_bytes if kind == "image" else self.video_bytes),
                          dict({"x-file-name": "phone%20garment.mov" if kind == "video" else "front.jpg"}, **(headers or {})))
        self.assertEqual(result[0], 201, result[2]); return json.loads(result[2])["media"]

    def product(self, **extra):
        body = {"name": "Isolated garment", "sku": "MEDIA-TEST", "barcode_id": "MEDIA-TEST-1OF1",
                "item_condition": "PRE_LOVED", "in_stock_count": 1, "cost_price": 10000,
                "base_price": 46500, "total_transport_cost": 7000}
        body.update(extra)
        status, data = self.request("POST", "/api/products", body)
        self.assertEqual(status, 201, data); return data["product"]

    def test_twelve_phone_photos_video_and_legacy_edit_preservation(self):
        photos = [self.upload() for _ in range(12)]; clip = self.upload("video")
        product = self.product(images=[image["url"] for image in photos], image_url=photos[0]["url"], video_id=clip["id"], flaw_photo_index=10)
        self.assertEqual(len(product["images"]), 12)
        self.assertEqual(product["video"]["id"], clip["id"])
        self.assertEqual(product["video"]["type"], "video/mp4")
        self.assertEqual(product["selling_price"], 50000)
        self.assertEqual(product["flaw_photo_index"], 10)
        self.assertLess(len(json.dumps(product)), 6500)
        self.assertNotIn("data:video", json.dumps(product))
        self.assertNotIn("data:image", json.dumps(product))
        status, updated = self.request("PUT", "/api/products/" + product["id"], {"name": "Edited garment"})
        self.assertEqual(status, 200, updated)
        self.assertEqual(updated["product"]["images"], product["images"])
        self.assertEqual(updated["product"]["video"], product["video"])
        self.assertEqual(updated["product"]["sku"], product["sku"])
        with get_db() as session:
            self.assertEqual(session.query(ProductMedia).filter_by(product_id=product["id"]).count(), 13)
            self.assertEqual(session.query(Inventory).count(), 1)

    def test_optional_photos_and_video_and_legacy_data_urls(self):
        product = self.product(images=["data:image/jpeg;base64,YWJj"], image_url="data:image/jpeg;base64,YWJj")
        self.assertIsNone(product["video"])
        self.assertEqual(len(product["images"]), 1)
        status, result = self.request("PUT", "/api/products/" + product["id"], {"images": [], "image_url": ""})
        self.assertEqual(status, 200, result)
        self.assertEqual(result["product"]["images"], [])
        self.assertIsNone(result["product"]["video"])

    def test_video_byte_ranges_head_cache_and_no_full_blob_catalog_load(self):
        clip = self.upload("video"); product = self.product(video_id=clip["id"])
        with get_db() as session:
            row = session.get(ProductMedia, clip["id"])
            self.assertIn("data", inspect(row).unloaded)
            full = bytes(row.data)
        with mock.patch.dict(os.environ, {"ADONAI_REQUIRE_STAFF_AUTH": "1"}):
            result = self.raw("GET", clip["url"], headers={"range": "bytes=7-106"})
            self.assertEqual(result[0], 206)
            self.assertEqual(result[1], "video/mp4"); self.assertEqual(result[2], full[7:107])
            self.assertEqual(result.headers["Content-Range"], f"bytes 7-106/{len(full)}")
            self.assertEqual(dict(serve.api_response_headers(result))["Content-Length"], "100")
            tail = self.raw("GET", clip["url"], headers={"range": "bytes=-12"})
            self.assertEqual(tail[2], full[-12:])
            head = self.raw("HEAD", clip["url"])
            self.assertEqual(head[0], 200); self.assertEqual(head[2], b"")
            self.assertEqual(dict(serve.api_response_headers(head))["Content-Length"], str(len(full)))
            self.assertEqual(self.raw("GET", clip["url"], headers={"range": "bytes=9999999-"})[0], 416)
            self.assertEqual(self.raw("GET", clip["url"], headers={"range": "bytes=0-2,7-9"})[0], 416)
            cached = self.raw("GET", clip["url"], headers={"if-none-match": head.headers["ETag"]})
            self.assertEqual(cached[0], 304); self.assertEqual(cached[2], b"")
        statements = []
        def capture(_conn, _cursor, statement, _params, _context, _many): statements.append(statement)
        event.listen(engine, "before_cursor_execute", capture)
        try:
            status, result = self.request("GET", "/api/products")
            self.assertEqual(status, 200); self.assertEqual(result["products"][0]["video"]["id"], clip["id"])
            self.assertFalse(any("product_media.data" in statement for statement in statements), statements)
        finally: event.remove(engine, "before_cursor_execute", capture)

    def test_media_and_product_writes_share_stock_password_public_reads_stay_open(self):
        image = self.upload()
        product = self.product(images=[image["url"]], image_url=image["url"])
        status, owner = self.request("POST", "/api/pos-access/admin", {"password": "Media owner test password"})
        self.assertEqual(status, 200, owner)
        headers = {"x-pos-access": owner["session"]["token"]}
        status, _ = self.request("PATCH", "/api/pos-access/policy", {"protected_areas": ["stock"]}, headers)
        self.assertEqual(status, 200)
        for method, path, body in [("POST", "/api/media/images", self.photo_bytes), ("POST", "/api/media/videos", self.video_bytes), ("DELETE", image["url"], b"")]:
            result = self.raw(method, path, body)
            self.assertEqual(result[0], 403); self.assertEqual(json.loads(result[2])["area"], "stock")
        self.assertEqual(self.raw("GET", image["url"])[0], 200)
        private = self.upload(headers=headers)
        self.assertEqual(self.raw("GET", private["url"])[0], 404)
        self.assertEqual(self.raw("GET", private["url"], headers=headers)[0], 200)
        self.assertEqual(self.raw("DELETE", image["url"], headers=headers)[0], 409)
        self.assertEqual(self.raw("DELETE", private["url"], headers=headers)[0], 200)
        self.assertEqual(self.request("GET", "/api/products/" + product["id"])[0], 200)
        with mock.patch.dict(os.environ, {"ADONAI_REQUIRE_STAFF_AUTH": "1"}):
            self.assertEqual(self.raw("POST", "/api/media/images", self.photo_bytes, headers=headers)[0], 401)

    def test_invalid_media_reference_rolls_back_product_update_and_new_intake(self):
        product = self.product()
        status, _ = self.request("PUT", "/api/products/" + product["id"], {"name": "Must not persist", "video_id": "a" * 32})
        self.assertEqual(status, 400)
        self.assertEqual(self.request("GET", "/api/products/" + product["id"])[1]["product"]["name"], "Isolated garment")
        status, _ = self.request("POST", "/api/products", {"name": "Bad clip", "sku": "BAD-CLIP", "base_price": 10000, "in_stock_count": 1, "video_id": "b" * 32})
        self.assertEqual(status, 400)
        with get_db() as session:
            self.assertEqual(session.query(Product).count(), 1); self.assertEqual(session.query(Inventory).count(), 1)
            self.assertEqual(session.query(NotificationEvent).filter_by(event_type="STOCK_ADDED").count(), 1)

    def test_managed_photos_cannot_be_stolen_by_a_second_garment(self):
        image = self.upload(); original = self.product(images=[image["url"]], image_url=image["url"])
        status, _ = self.request("POST", "/api/products", {"name": "Second garment", "sku": "SECOND-GARMENT", "base_price": 10000, "in_stock_count": 1, "images": [image["url"]]})
        self.assertEqual(status, 400)
        with get_db() as session:
            self.assertEqual(session.get(ProductMedia, image["id"]).product_id, original["id"])
            self.assertEqual(session.query(Product).count(), 1)

    def test_removing_and_replacing_video_is_atomic_and_releases_old_bytes(self):
        first = self.upload("video"); second = self.upload("video"); image = self.upload()
        product = self.product(video_id=first["id"], images=[image["url"]], image_url=image["url"])
        status, result = self.request("PUT", "/api/products/" + product["id"], {"video_id": second["id"]})
        self.assertEqual(status, 200, result); self.assertEqual(result["product"]["video"]["id"], second["id"])
        self.assertEqual(self.raw("GET", first["url"])[0], 404)
        status, result = self.request("PUT", "/api/products/" + product["id"], {"video_id": "", "images": [], "image_url": ""})
        self.assertEqual(status, 200, result); self.assertIsNone(result["product"]["video"])
        with get_db() as session: self.assertEqual(session.query(ProductMedia).count(), 0)

    def test_phone_mp4_mov_validation_limits_metadata_and_optimization(self):
        self.assertEqual(media.mp4_info(self.video_bytes)[0], 2)
        clip = self.upload("video")
        with get_db() as session:
            data = bytes(session.get(ProductMedia, clip["id"]).data)
            self.assertNotIn(b"+00.123+032.123/", data)
            self.assertLessEqual(len(data), media.MAX_STORED_VIDEO)
            self.assertEqual(media.mp4_info(data)[0], 2)
        self.assertEqual(self.raw("POST", "/api/media/videos", b"not a video")[0], 400)
        self.assertEqual(self.raw("POST", "/api/media/images", b'<svg onload="alert(1)"/>')[0], 400)
        too_long = bytearray(self.video_bytes)
        a = too_long.index(b"mvhd") + 4
        scale = struct.unpack_from(">I", too_long, a + 12)[0]
        struct.pack_into(">I", too_long, a + 16, scale * 31)
        with mock.patch("media.prepare_video", wraps=media.prepare_video) as processor:
            result = self.raw("POST", "/api/media/videos", bytes(too_long))
            self.assertEqual(result[0], 400); self.assertIn("30 seconds", json.loads(result[2])["error"])
            self.assertEqual(processor.call_count, 1)
        external = bytearray(self.video_bytes)
        a = external.index(b"url ", external.index(b"dref") + 4) + 4; struct.pack_into(">I", external, a, 0)
        self.assertEqual(self.raw("POST", "/api/media/videos", bytes(external))[0], 400)
        self.assertEqual(serve.api_body_limit("POST", "/api/media/videos"), 50 * 1024 * 1024)
        self.assertEqual(serve.api_body_limit("POST", "/api/media/images"), 10 * 1024 * 1024)
        self.assertEqual(serve.api_body_limit("POST", "/api/products"), serve.MAX_API_BODY_BYTES)
        status, _ = self.request("POST", "/api/products", {"name": "Too many", "images": ["assets/front.jpg"] * 13})
        self.assertEqual(status, 400)

    def test_unpublished_draft_cleanup_never_deletes_saved_media(self):
        saved = self.upload(); stale = self.upload()
        product = self.product(images=[saved["url"]], image_url=saved["url"])
        with get_db() as session:
            for asset in session.query(ProductMedia): asset.created_at = datetime.utcnow() - timedelta(days=2)
        fresh = self.upload()
        with get_db() as session:
            self.assertIsNotNone(session.get(ProductMedia, saved["id"])); self.assertIsNone(session.get(ProductMedia, stale["id"]))
            self.assertIsNotNone(session.get(ProductMedia, fresh["id"])); self.assertIsNotNone(session.get(Product, product["id"]))


if __name__ == "__main__": unittest.main()
