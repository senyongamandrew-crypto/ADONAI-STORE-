#!/usr/bin/env python3
"""
Adonai Thrift Store — product image optimizer (WebP + responsive srcset)

Storefront shoppers in Uganda are overwhelmingly on mobile data, so every
bundled catalog photo is:

  1. re-encoded as a capped-size progressive JPEG fallback,
  2. exported to WebP at several widths for `srcset`,
  3. recorded in `js/image-manifest.js` with its intrinsic width/height so the
     PDP and the rail grid can reserve space and avoid layout shift (CLS).

Usage:
    python3 scripts/optimize-product-images.py            # optimize + manifest
    python3 scripts/optimize-product-images.py --check     # verify, exit 1 if stale

Requires Pillow (`pip install pillow`). The generated WebP files and the
manifest are committed so production never needs an image build step.
"""
from __future__ import annotations

import argparse
import io
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PRODUCT_DIR = os.path.join(ROOT, "assets", "products")
ASSET_DIR = os.path.join(ROOT, "assets")
MANIFEST_PATH = os.path.join(ROOT, "js", "image-manifest.js")

# Bundled artwork that lives outside the catalog folder but is still served
# to shoppers through the storefront's responsive image path.
EXTRA_IMAGES = ("storefront-editorial-bg.jpg",)

# Rendered sizes across the storefront: rail card ≈ 320px, PDP main stage
# ≈ 640px, desktop gallery / lightbox ≈ 960px.
TARGET_WIDTHS = (320, 640, 960)
# The rail card shows a row of 40x40 photo-count dots. Those dots used to
# point at the full-resolution master JPEG, so four dots on one card pulled
# ~1 MB of originals. A dedicated 96px WebP keeps that row under ~5 KB.
THUMB_WIDTH = 96
MAX_JPEG_EDGE = 1280
JPEG_QUALITY = 80
JPEG_BYTE_BUDGET = 400 * 1024   # above this the fallback is re-encoded once
WEBP_QUALITY = 72
THUMB_QUALITY = 70


def optimize_jpeg(path: str, image) -> None:
    """Cap the committed JPEG fallback so it is never a multi-megabyte file.

    The rewrite must be idempotent: a photo that is already as small as this
    encoder can make it is left untouched, otherwise every run would re-encode
    (losing a little quality each time) and leave a dirty working tree.
    """
    from PIL import Image

    width, height = image.size
    longest = max(width, height)
    needs_resize = longest > MAX_JPEG_EDGE
    current_bytes = os.path.getsize(path)
    if not needs_resize and current_bytes <= JPEG_BYTE_BUDGET:
        return

    working = image
    if needs_resize:
        scale = MAX_JPEG_EDGE / float(longest)
        working = image.resize(
            (max(1, round(width * scale)), max(1, round(height * scale))),
            Image.LANCZOS,
        )

    buffer = io.BytesIO()
    working.convert("RGB").save(
        buffer, "JPEG", quality=JPEG_QUALITY, optimize=True, progressive=True
    )

    # Only commit the re-encode when it is a worthwhile win. Without this a
    # photo that sits just above the budget would be rewritten on every run.
    if not needs_resize and len(buffer.getvalue()) > current_bytes * 0.98:
        return

    with open(path, "wb") as handle:
        handle.write(buffer.getvalue())


def build() -> dict:
    from PIL import Image

    manifest: dict[str, dict] = {}
    if not os.path.isdir(PRODUCT_DIR):
        return manifest

    sources = [(os.path.join(PRODUCT_DIR, name), "assets/products")
               for name in sorted(os.listdir(PRODUCT_DIR))]
    # Storefront artwork outside the catalog folder is delivered through the
    # same responsive path, so the brand fallback tile is not the one image
    # that still ships as a full-size master.
    sources += [(os.path.join(ASSET_DIR, name), "assets")
                for name in EXTRA_IMAGES
                if os.path.isfile(os.path.join(ASSET_DIR, name))]

    for path, prefix in sources:
        filename = os.path.basename(path)
        stem, ext = os.path.splitext(filename)
        if ext.lower() not in (".jpg", ".jpeg", ".png"):
            continue
        out_dir = os.path.dirname(path)

        with Image.open(path) as opened:
            optimize_jpeg(path, opened)

        with Image.open(path) as source:
            source = source.convert("RGB")
            width, height = source.size
            widths = []
            for target in TARGET_WIDTHS:
                if target > width and widths:
                    break  # never upscale beyond the master file
                scale = min(1.0, target / float(width))
                size = (max(1, round(width * scale)), max(1, round(height * scale)))
                out_path = os.path.join(out_dir, f"{stem}-{target}.webp")
                source.resize(size, Image.LANCZOS).save(
                    out_path, "WEBP", quality=WEBP_QUALITY, method=6
                )
                widths.append(target)

            # 40x40 photo-count dot on the rail card. Never upscaled: a photo
            # narrower than the target is written at its own width.
            thumb_scale = min(1.0, THUMB_WIDTH / float(width))
            thumb_size = (
                max(1, round(width * thumb_scale)),
                max(1, round(height * thumb_scale)),
            )
            thumb_name = f"{stem}-{THUMB_WIDTH}.webp"
            source.resize(thumb_size, Image.LANCZOS).save(
                os.path.join(out_dir, thumb_name), "WEBP", quality=THUMB_QUALITY, method=6
            )

        manifest[f"{prefix}/{filename}"] = {
            "w": width,
            "h": height,
            "webp": widths,
            "thumb": f"{prefix}/{thumb_name}",
            "stem": f"{prefix}/{stem}",
        }
    return manifest


def write_manifest(manifest: dict) -> str:
    payload = json.dumps(manifest, indent=2, sort_keys=True)
    contents = (
        "/* AUTO-GENERATED by scripts/optimize-product-images.py — do not edit by hand.\n"
        "   Maps every bundled catalog photo to its intrinsic size and the WebP\n"
        "   derivatives available for responsive `srcset` delivery. */\n"
        f"window.ADONAI_IMAGE_MANIFEST = {payload};\n"
    )
    with open(MANIFEST_PATH, "w", encoding="utf-8") as handle:
        handle.write(contents)
    return contents


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="fail if the manifest is stale")
    args = parser.parse_args()

    try:
        import PIL  # noqa: F401
    except ImportError:
        print("Pillow is required: pip install pillow", file=sys.stderr)
        return 2

    manifest = build()
    if args.check:
        existing = ""
        if os.path.isfile(MANIFEST_PATH):
            with open(MANIFEST_PATH, "r", encoding="utf-8") as handle:
                existing = handle.read()
        expected = write_manifest(manifest)
        if existing != expected:
            print("image manifest is stale — re-run scripts/optimize-product-images.py")
            return 1
        print(f"image manifest current ({len(manifest)} photos)")
        return 0

    write_manifest(manifest)
    total = sum(len(entry["webp"]) for entry in manifest.values())
    print(f"Optimized {len(manifest)} catalog photos → {total} WebP derivatives")
    print(f"Manifest written to {os.path.relpath(MANIFEST_PATH, ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
