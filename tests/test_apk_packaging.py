"""Content-verifier regressions, not a claim that the synthetic ZIP is an APK."""
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path
import tempfile
import unittest
import zipfile

ROOT = Path(__file__).resolve().parents[1]
SPEC = spec_from_file_location("apk_verifier", ROOT / "scripts/verify-pos-apk.py")
VERIFY = module_from_spec(SPEC)
SPEC.loader.exec_module(VERIFY)


class ApkContentTests(unittest.TestCase):
    def make_fixture(self, omit=None, corrupt_asset=None):
        temporary = tempfile.TemporaryDirectory(prefix="adonai-apk-content-")
        self.addCleanup(temporary.cleanup)
        target = Path(temporary.name) / "synthetic-content.zip"
        with zipfile.ZipFile(target, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            for name in ["AndroidManifest.xml", "resources.arsc", "classes.dex"]:
                if name != omit:
                    archive.writestr(name, b"not compiled" if name != "classes.dex" else b" ".join(VERIFY.CLASSES))
            for asset in VERIFY.ASSETS:
                archive.writestr("assets/public/" + asset, b"stale" if corrupt_asset == asset else (ROOT / asset).read_bytes())
        return target

    def test_rider_and_shared_assets_must_match_current_source(self):
        VERIFY.content_checks(self.make_fixture())
        with self.assertRaisesRegex(ValueError, "stale or changed UI asset"):
            VERIFY.content_checks(self.make_fixture(corrupt_asset="js/rider-app.js"))

    def test_missing_bytecode_cannot_pass_packaging_check(self):
        with self.assertRaisesRegex(ValueError, "Missing compiled APK member"):
            VERIFY.content_checks(self.make_fixture(omit="classes.dex"))

    def test_missing_native_service_rejected(self):
        target = self.make_fixture()
        with zipfile.ZipFile(target) as archive:
            entries = [(name, archive.read(name)) for name in archive.namelist()]
        with zipfile.ZipFile(target, "w") as archive:
            for name, data in entries:
                archive.writestr(name, b"Lcom/adonaithrift/pos/MainActivity;" if name == "classes.dex" else data)
        with self.assertRaisesRegex(ValueError, "Missing compiled rider class"):
            VERIFY.content_checks(target)


if __name__ == "__main__":
    unittest.main()
