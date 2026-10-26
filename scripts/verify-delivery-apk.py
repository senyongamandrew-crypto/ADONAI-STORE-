#!/usr/bin/env python3
"""Verify the *built* Adonai Delivery APK and emit public metadata.

The delivery APK is a separate application from Adonai POS: its own package
(com.adonaithrift.delivery), its own launcher label/icon, and a bundle that
contains the rider-partner app (delivery.html) only. This verifier refuses a
build that quietly packages the cashier register instead — the exact failure
that made every "delivery APK" download install Adonai POS.

Runs after Gradle compilation and apksigner checks in CI. A native build
still needs phone QA (install, sign in, GPS duty, file-picker selfies).
"""
from __future__ import annotations
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import zipfile

ROOT = Path(__file__).resolve().parents[1]
ASSETS = [
    "delivery.html", "js/delivery-app.js", "css/delivery.css",
    "manifest-delivery.json", "sw-delivery.js",
    "assets/delivery-icon-192.png", "assets/delivery-icon-512.png",
    "assets/adonai-logo-horizontal-light.svg",
]
# The rider app is separate from the cashier register and the Admin Suite.
# If any of these ride along, the "delivery" download is the POS again.
FORBIDDEN_ASSETS = ["pos.html", "admin.html", "login.html", "app.js", "styles.css"]
CLASSES = [b"Lcom/adonaithrift/pos/MainActivity;"]
PERMISSIONS = ["INTERNET", "ACCESS_FINE_LOCATION", "ACCESS_COARSE_LOCATION", "POST_NOTIFICATIONS"]


def content_checks(apk: Path) -> None:
    with zipfile.ZipFile(apk) as archive:
        names = set(archive.namelist())
        for required in ["classes.dex", "resources.arsc", "AndroidManifest.xml"]:
            if required not in names:
                raise ValueError(f"Missing compiled APK member: {required}")
        dex = b"".join(archive.read(name) for name in names if re.fullmatch(r"classes\d*\.dex", name))
        for name in CLASSES:
            if name not in dex:
                raise ValueError(f"Missing compiled shell class: {name.decode()}")
        for name in ASSETS:
            if "assets/public/" + name not in names:
                raise ValueError(f"APK is missing packaged UI asset: {name}")
            if archive.read("assets/public/" + name) != (ROOT / name).read_bytes():
                raise ValueError(f"APK contains stale or changed UI asset: {name}")
        for name in FORBIDDEN_ASSETS:
            if "assets/public/" + name in names:
                raise ValueError(f"Delivery APK must not contain POS/admin asset: {name}")
        index = archive.read("assets/public/index.html").decode("utf-8", "replace")
        if "delivery.html" not in index or "pos.html" in index:
            raise ValueError("Delivery APK entry page must open delivery.html, not the POS register")


def main() -> int:
    apk = Path(sys.argv[1] if len(sys.argv) > 1 else "dist/adonai-delivery.apk").resolve()
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
    expected = "com.adonaithrift.delivery.preview" if preview else "com.adonaithrift.delivery"
    if package != expected or int(code) != 20500 or version != ("2.5.0-preview" if preview else "2.5.0"):
        raise ValueError(f"Wrong APK identity/version: {package} {version} ({code})")
    expected_label = "Adonai Delivery Preview" if preview else "Adonai Delivery"
    if f"application-label:'{expected_label}'" not in badging:
        raise ValueError(f"Wrong APK app label, expected: {expected_label}")
    if "sdkVersion:'22'" not in badging or "targetSdkVersion:'34'" not in badging:
        raise ValueError("Unexpected APK minimum/target SDK")
    for permission in PERMISSIONS:
        if f"name='android.permission.{permission}'" not in badging:
            raise ValueError(f"Built APK lacks {permission}")
    for forbidden in ["READ_PHONE_STATE", "READ_PRIVILEGED_PHONE_STATE", "ACCESS_BACKGROUND_LOCATION", "RECEIVE_BOOT_COMPLETED"]:
        if f"name='android.permission.{forbidden}'" in badging:
            raise ValueError(f"Forbidden APK permission: {forbidden}")
    signature = subprocess.check_output([str(tools / "apksigner"), "verify", "--verbose", "--print-certs", str(apk)], text=True)
    cert = re.search(r"Signer #1 certificate SHA-256 digest: ([a-fA-F0-9]+)", signature)
    if not cert:
        raise ValueError("No verified signing certificate")
    digest = hashlib.sha256(apk.read_bytes()).hexdigest()
    metadata = {
        "app_name": expected_label,
        "package": package, "version": version, "version_code": int(code),
        "preview_installs_alongside_existing_app": preview,
        "source_commit": os.environ.get("GITHUB_SHA", "local"),
        "repository": os.environ.get("GITHUB_REPOSITORY", "senyongamandrew-crypto/ADONAI-STORE-"),
        "workflow_run": os.environ.get("GITHUB_RUN_ID"),
        "apk_sha256": digest, "signing_certificate_sha256": cert[1].lower(),
        "verified": ["Gradle compiled Android bytecode/resources", "APK signature",
                     f"{len(ASSETS)} source-identical packaged rider screens/scripts/styles",
                     "no POS register or Admin Suite assets in the delivery bundle",
                     "entry page opens delivery.html (rider sign-in), not pos.html"],
        "backend_deployed_by_this_build": False,
        "real_phone_screen_lock_gps_verified": False,
    }
    output = apk.parent
    (output / "BUILD-INFO-delivery.json").write_text(json.dumps(metadata, indent=2) + "\n")
    # SHA256SUMS.txt is shared with the POS build: keep every APK's line.
    sums_path = output / "SHA256SUMS.txt"
    sums = {}
    if sums_path.exists():
        for line in sums_path.read_text().splitlines():
            parts = line.split(None, 1)
            if len(parts) == 2:
                sums[parts[1].strip().lstrip("*")] = parts[0].strip()
    sums[apk.name] = digest
    sums_path.write_text("".join(f"{sums[name]}  {name}\n" for name in sorted(sums)))
    summary = f"{metadata['app_name']} {version} ({code}); {package}; SHA256={digest}; verified rider-only bundle/assets/signature; real-phone QA still required."
    print(summary)
    # Available through the GitHub check API even if log-download hosts are unavailable.
    if os.environ.get("GITHUB_ACTIONS"):
        print("::notice title=Verified Adonai Delivery APK::" + summary)
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as handle:
            handle.write("## Verified Adonai Delivery APK\n\n" + summary + "\n\nDownload **adonai-delivery.apk** under this run's **Artifacts** or the attached release. This is the rider app; the cashier register is the separate **adonai-pos-v2.apk**.\n")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, zipfile.BadZipFile, KeyError, subprocess.CalledProcessError) as error:
        print("::error title=Delivery APK verification failed::" + str(error), file=sys.stderr)
        raise SystemExit(1)
