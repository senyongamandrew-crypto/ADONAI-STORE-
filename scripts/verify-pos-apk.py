#!/usr/bin/env python3
"""Verify the *built* APK, its rider bytecode and bundled UI; emit public metadata.

Runs after Gradle compilation and apksigner checks in CI. No signing material or
rider credentials are copied to output. A native build still needs phone QA.
"""
from __future__ import annotations
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import zipfile

ROOT = Path(__file__).resolve().parents[1]
ASSETS = [
    "pos.html", "admin.html", "rider.html", "app.js", "js/db.js",
    "js/rider-app.js", "js/dispatch-center.js", "css/rider.css", "css/dispatch.css",
    "js/receipt-printing.js", "js/audit-exports.js", "js/file-downloads.js",
    "js/vendor/leaflet/leaflet.js", "css/vendor/leaflet/leaflet.css",
]
CLASSES = [b"Lcom/adonaithrift/pos/MainActivity;", b"Lcom/adonaithrift/pos/RiderApi;",
           b"Lcom/adonaithrift/pos/RiderTrackingService;"]
PERMISSIONS = ["ACCESS_FINE_LOCATION", "ACCESS_COARSE_LOCATION", "FOREGROUND_SERVICE",
               "FOREGROUND_SERVICE_LOCATION", "POST_NOTIFICATIONS", "WAKE_LOCK"]


def content_checks(apk: Path) -> None:
    with zipfile.ZipFile(apk) as archive:
        names = set(archive.namelist())
        for required in ["classes.dex", "resources.arsc", "AndroidManifest.xml"]:
            if required not in names:
                raise ValueError(f"Missing compiled APK member: {required}")
        dex = b"".join(archive.read(name) for name in names if re.fullmatch(r"classes\d*\.dex", name))
        for name in CLASSES:
            if name not in dex:
                raise ValueError(f"Missing compiled rider class: {name.decode()}")
        for name in ASSETS:
            if archive.read("assets/public/" + name) != (ROOT / name).read_bytes():
                raise ValueError(f"APK contains stale or changed UI asset: {name}")


def main() -> int:
    apk = Path(sys.argv[1] if len(sys.argv) > 1 else "dist/adonai-pos-v2.apk").resolve()
    content_checks(apk)
    sdk = os.environ.get("ANDROID_HOME") or os.environ.get("ANDROID_SDK_ROOT")
    if not sdk:
        raise ValueError("ANDROID_HOME is required to verify the compiled manifest/signature")
    tools = Path(sdk) / "build-tools" / "34.0.0"
    badging = subprocess.check_output([str(tools / "aapt2"), "dump", "badging", str(apk)], text=True)
    match = re.search(r"package: name='([^']+)' versionCode='(\d+)' versionName='([^']+)'", badging)
    if not match:
        raise ValueError("Could not read compiled package/version")
    package, code, version = match.groups()
    preview = os.environ.get("ADONAI_PREVIEW_BUILD") == "1"
    expected = "com.adonaithrift.pos.preview" if preview else "com.adonaithrift.pos"
    if package != expected or int(code) != 20500 or version != ("2.5.0-preview" if preview else "2.5.0"):
        raise ValueError(f"Wrong APK identity/version: {package} {version} ({code})")
    if "sdkVersion:'22'" not in badging or "targetSdkVersion:'34'" not in badging:
        raise ValueError("Unexpected APK minimum/target SDK")
    for permission in PERMISSIONS:
        if f"name='android.permission.{permission}'" not in badging:
            raise ValueError(f"Built APK lacks {permission}")
    for forbidden in ["READ_PHONE_STATE", "READ_PRIVILEGED_PHONE_STATE", "ACCESS_BACKGROUND_LOCATION", "RECEIVE_BOOT_COMPLETED"]:
        if f"name='android.permission.{forbidden}'" in badging:
            raise ValueError(f"Forbidden APK permission: {forbidden}")
    tree = subprocess.check_output([str(tools / "aapt2"), "dump", "xmltree", str(apk), "--file", "AndroidManifest.xml"], text=True)
    service = re.search(r"E: service\b[^\n]*\n(?P<attrs>(?:[^\n]*\bA: [^\n]*\n)+)", tree)
    if not service or "com.adonaithrift.pos.RiderTrackingService" not in service["attrs"]:
        raise ValueError("Built manifest has no native RiderTrackingService")
    if not re.search(r"android:exported[^\n]*(?:0x0+\b|=\s*false\b)", service["attrs"]) or not re.search(r"android:foregroundServiceType[^\n]*(?:0x0*8\b|=\s*\"location\")", service["attrs"]):
        raise ValueError("Rider service must be non-exported and location-typed: " + service["attrs"].replace("\n", " "))
    signature = subprocess.check_output([str(tools / "apksigner"), "verify", "--verbose", "--print-certs", str(apk)], text=True)
    cert = re.search(r"Signer #1 certificate SHA-256 digest: ([a-fA-F0-9]+)", signature)
    if not cert:
        raise ValueError("No verified signing certificate")
    digest = hashlib.sha256(apk.read_bytes()).hexdigest()
    metadata = {
        "app_name": "Adonai Store Preview" if preview else "Adonai POS",
        "package": package, "version": version, "version_code": int(code),
        "preview_installs_alongside_existing_app": preview,
        "source_commit": os.environ.get("GITHUB_SHA", "local"),
        "repository": os.environ.get("GITHUB_REPOSITORY", "senyongamandrew-crypto/ADONAI-STORE-"),
        "workflow_run": os.environ.get("GITHUB_RUN_ID"),
        "apk_sha256": digest, "signing_certificate_sha256": cert[1].lower(),
        "verified": ["Gradle compiled Android bytecode/resources", "APK signature", "compiled foreground-location manifest",
                     "native rider bridge/service bytecode", "14 source-identical packaged screens/scripts/styles"],
        "backend_deployed_by_this_build": False,
        "real_phone_screen_lock_gps_verified": False,
    }
    output = apk.parent
    artifacts = [apk]
    if preview:
        alias = output / "adonai-pos-v2.5.0-preview.apk"
        shutil.copy2(apk, alias)
        artifacts.append(alias)
    (output / "BUILD-INFO.json").write_text(json.dumps(metadata, indent=2) + "\n")
    (output / "SHA256SUMS.txt").write_text("".join(f"{digest}  {file.name}\n" for file in artifacts))
    summary = f"{metadata['app_name']} {version} ({code}); {package}; SHA256={digest}; verified native rider service/manifest/assets/signature; real-phone GPS QA still required."
    print(summary)
    # Available through the GitHub check API even if log-download hosts are unavailable.
    if os.environ.get("GITHUB_ACTIONS"):
        print("::notice title=Verified installation APK::" + summary)
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as handle:
            handle.write("## Verified installable APK\n\n" + summary + "\n\nDownload the APK under this run's **Artifacts** or the attached release.\n")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, zipfile.BadZipFile, KeyError, subprocess.CalledProcessError) as error:
        print("::error title=APK verification failed::" + str(error), file=sys.stderr)
        raise SystemExit(1)
