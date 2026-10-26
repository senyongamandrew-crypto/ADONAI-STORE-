"""Adonai Delivery must be downloadable as its own APK — never as the POS.

These are content/config regressions for the separate delivery build
(com.adonaithrift.delivery / dist/adonai-delivery.apk), not a claim that a
synthetic ZIP is a compiled APK. Gradle compilation, signing and badging of
the real APKs are verified in CI by scripts/verify-(pos|delivery)-apk.py.
"""
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path
import tempfile
import unittest
import zipfile

ROOT = Path(__file__).resolve().parents[1]
SPEC = spec_from_file_location("delivery_apk_verifier", ROOT / "scripts/verify-delivery-apk.py")
VERIFY = module_from_spec(SPEC)
SPEC.loader.exec_module(VERIFY)


def source(name: str) -> str:
    return (ROOT / name).read_text(encoding="utf-8")


class DeliveryApkContentTests(unittest.TestCase):
    def make_fixture(self, corrupt_asset=None, extra_asset=None, index_html=None):
        temporary = tempfile.TemporaryDirectory(prefix="adonai-delivery-apk-content-")
        self.addCleanup(temporary.cleanup)
        target = Path(temporary.name) / "synthetic-delivery-content.zip"
        with zipfile.ZipFile(target, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            for name in ["AndroidManifest.xml", "resources.arsc"]:
                archive.writestr(name, b"not compiled")
            archive.writestr("classes.dex", b" ".join(VERIFY.CLASSES))
            for asset in VERIFY.ASSETS:
                archive.writestr("assets/public/" + asset,
                                 b"stale" if corrupt_asset == asset else (ROOT / asset).read_bytes())
            archive.writestr(
                "assets/public/index.html",
                index_html if index_html is not None
                else b"<!DOCTYPE html><html><head><meta http-equiv=\"refresh\" content=\"0; url=delivery.html\"></head></html>")
            if extra_asset:
                archive.writestr("assets/public/" + extra_asset, b"must not ride along")
        return target

    def test_rider_assets_must_match_current_source(self):
        VERIFY.content_checks(self.make_fixture())
        with self.assertRaisesRegex(ValueError, "stale or changed UI asset"):
            VERIFY.content_checks(self.make_fixture(corrupt_asset="js/delivery-app.js"))

    def test_pos_pages_cannot_ride_inside_the_delivery_apk(self):
        with self.assertRaisesRegex(ValueError, "must not contain POS/admin asset"):
            VERIFY.content_checks(self.make_fixture(extra_asset="pos.html"))

    def test_entry_page_must_open_the_rider_app_not_the_register(self):
        pos_index = b"<!DOCTYPE html><html><head><meta http-equiv=\"refresh\" content=\"0; url=pos.html\"></head></html>"
        with self.assertRaisesRegex(ValueError, "must open delivery.html"):
            VERIFY.content_checks(self.make_fixture(index_html=pos_index))


class SeparateAppIdentityTests(unittest.TestCase):
    def test_gradle_has_two_distinct_application_ids(self):
        gradle = source("android/app/build.gradle")
        self.assertIn("com.adonaithrift.pos", gradle)
        self.assertIn("com.adonaithrift.delivery", gradle)
        self.assertIn("com.adonaithrift.delivery.preview", gradle)
        self.assertIn("ADONAI_APP_TARGET", gradle)

    def test_pos_preview_is_never_labelled_as_the_delivery_app(self):
        # The original bug: every branch build was the POS bundle wearing an
        # "Adonai Delivery" label, so riders installed the cashier register.
        gradle = source("android/app/build.gradle")
        self.assertIn('"Adonai POS Preview"', gradle)
        self.assertIn('"Adonai Delivery"', gradle)
        verifier = source("scripts/verify-pos-apk.py")
        self.assertIn('"Adonai POS Preview" if preview else "Adonai POS"', verifier)
        self.assertNotIn('"Adonai Delivery" if preview', verifier)

    def test_delivery_build_opens_delivery_page_in_native_shell(self):
        activity = source("android/app/src/main/java/com/adonaithrift/pos/MainActivity.java")
        self.assertIn("DELIVERY_URL", activity)
        self.assertIn("BuildConfig.DELIVERY_APP", activity)
        self.assertIn("/assets/public/delivery.html", activity)
        # The rider GPS duty switch needs a WebView geolocation grant,
        # otherwise the delivery APK starts duties that never report a fix.
        self.assertIn("onGeolocationPermissionsShowPrompt", activity)

    def test_delivery_bundle_is_rider_only_and_redirects_to_delivery(self):
        bundler = source("scripts/bundle-delivery.js")
        self.assertIn("'delivery.html'", bundler)
        self.assertIn("url=delivery.html", bundler)
        for pos_file in ("'pos.html'", "'admin.html'", "'app.js'"):
            self.assertNotIn(pos_file, bundler,
                               f"delivery bundle must not package {pos_file}")
        # A shared, uncleaned assets folder is how POS pages would leak in.
        self.assertIn("rmSync", bundler)

    def test_builder_writes_a_distinct_delivery_filename(self):
        builder = source("scripts/build-pos-apk.js")
        self.assertIn("outputBase: 'adonai-delivery'", builder)
        self.assertIn("outputBase: 'adonai-pos-v2'", builder)
        self.assertIn("ADONAI_APP_TARGET", builder)

    def test_delivery_app_defaults_to_live_server_inside_the_apk(self):
        # Inside the APK the page origin is the app-assets host, not the store.
        app = source("js/delivery-app.js")
        self.assertIn("appassets.androidplatform.net", app)
        self.assertIn("https://www.adonaithrift-store.online", app)


class DownloadRouteTests(unittest.TestCase):
    def test_server_routes_delivery_download_to_the_delivery_file(self):
        serve = source("serve.py")
        self.assertIn('"/download/delivery-apk": "dist/adonai-delivery.apk"', serve)
        self.assertIn('"/download/pos-apk": "dist/adonai-pos-v2.apk"', serve)

    def test_server_never_renames_a_download_to_the_pos_filename(self):
        # A hardcoded Content-Disposition filename renamed every APK to
        # adonai-pos-v2.apk on its way to the phone.
        serve = source("serve.py")
        self.assertNotIn('filename="adonai-pos-v2.apk"', serve)
        self.assertIn("os.path.basename(target_file)", serve)

    def test_rider_page_buttons_deliver_the_delivery_apk(self):
        page = source("rider-demo.html")
        self.assertIn("apk-dist/adonai-delivery.apk", page)
        self.assertIn("/download/delivery-apk", page)
        self.assertNotIn("apk-dist/adonai-pos-v2.apk", page)


if __name__ == "__main__":
    unittest.main()
