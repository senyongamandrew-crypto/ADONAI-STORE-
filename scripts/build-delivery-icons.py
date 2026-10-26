#!/usr/bin/env python3
"""Generate the Adonai Delivery PWA icons.

The rider app is a separate installable application, so it must not reuse the
storefront's shopping icon. Everything is drawn locally with Pillow — no remote
assets, no fonts to download, deterministic output.

Usage: .venv/bin/python scripts/build-delivery-icons.py
"""
import os
from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "assets")

INK = (11, 31, 22, 255)        # deep forest ink
LIME = (200, 245, 59, 255)     # high-visibility delivery lime
WHITE = (248, 250, 247, 255)

S = 4  # supersampling factor for smooth edges


def rounded(draw, box, radius, fill):
    draw.rounded_rectangle(box, radius=radius, fill=fill)


def draw_icon(size, maskable=False):
    scale = size * S
    img = Image.new("RGBA", (scale, scale), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # Maskable icons are square all the way to the edge; regular icons keep the
    # rounded app-tile silhouette.
    tile_radius = 0 if maskable else int(scale * 0.225)
    rounded(d, (0, 0, scale - 1, scale - 1), tile_radius, INK)

    # Safe zone: maskable artwork must stay inside the middle 80% circle.
    pad = int(scale * (0.20 if maskable else 0.135))
    badge = (pad, pad, scale - pad, scale - pad)
    rounded(d, badge, int((badge[2] - badge[0]) * 0.26), LIME)

    u = scale / 100.0  # design on a 100×100 grid
    cx = scale / 2

    # Two boda wheels.
    wheel_r = 8.6 * u
    wheel_y = 69 * u
    for wx in (36 * u, 66 * u):
        d.ellipse((wx - wheel_r, wheel_y - wheel_r, wx + wheel_r, wheel_y + wheel_r), fill=INK)
        d.ellipse((wx - wheel_r * 0.42, wheel_y - wheel_r * 0.42,
                   wx + wheel_r * 0.42, wheel_y + wheel_r * 0.42), fill=LIME)

    # Parcel / delivery box on the rack.
    rounded(d, (34 * u, 31 * u, 66 * u, 56 * u), 3.2 * u, INK)
    d.line((34 * u, 41 * u, 66 * u, 41 * u), fill=LIME, width=int(1.7 * u))
    d.line((50 * u, 31 * u, 50 * u, 41 * u), fill=LIME, width=int(1.7 * u))

    # Frame, seat and handlebar.
    d.line((36 * u, 64 * u, 47 * u, 64 * u, 57 * u, 56 * u, 66 * u, 64 * u),
           fill=INK, width=int(3.4 * u), joint="curve")
    d.line((61 * u, 56 * u, 63 * u, 38 * u, 69 * u, 36 * u),
           fill=INK, width=int(3.2 * u), joint="curve")
    d.line((40 * u, 58 * u, 46 * u, 58 * u), fill=INK, width=int(3.6 * u))

    # Small motion marks — the app is about moving parcels, not a shopfront.
    for i, x in enumerate((24, 20, 16)):
        y = 47 + i * 9
        d.line((x * u, y * u, (x + 8) * u, y * u), fill=WHITE, width=int(2.1 * u))

    return img.resize((size, size), Image.LANCZOS)


def main():
    os.makedirs(OUT, exist_ok=True)
    targets = [
        ("delivery-icon-192.png", 192, False),
        ("delivery-icon-512.png", 512, False),
        ("delivery-icon-maskable-512.png", 512, True),
        ("delivery-apple-touch.png", 180, False),
    ]
    for name, size, maskable in targets:
        path = os.path.join(OUT, name)
        draw_icon(size, maskable).save(path, "PNG", optimize=True)
        print("wrote", os.path.relpath(path, ROOT), size, "px")

    # Android launcher mipmaps for the Adonai Delivery APK
    # (ADONAI_APP_TARGET=delivery). The full-bleed maskable artwork is the
    # source so launchers can mask it to any silhouette; the POS build keeps
    # its own ic_launcher set and never uses these.
    res_dir = os.path.join(ROOT, "android", "app", "src", "main", "res")
    for density, size in [("mdpi", 48), ("hdpi", 72), ("xhdpi", 96),
                          ("xxhdpi", 144), ("xxxhdpi", 192)]:
        folder = os.path.join(res_dir, f"mipmap-{density}")
        os.makedirs(folder, exist_ok=True)
        for name in ("ic_launcher_delivery.png", "ic_launcher_delivery_round.png"):
            path = os.path.join(folder, name)
            draw_icon(size, maskable=True).save(path, "PNG", optimize=True)
            print("wrote", os.path.relpath(path, ROOT), size, "px")


if __name__ == "__main__":
    main()
