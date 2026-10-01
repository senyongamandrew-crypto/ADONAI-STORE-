#!/usr/bin/env python3
"""Regenerate Adonai Store raster brand assets (favicons, PWA icons, OG share
image) from the vector logo geometry, using ImageMagick 6.

Why: WhatsApp / Facebook / X / iOS do NOT render SVG link-preview images or
apple-touch-icons, so the .svg brand assets need .png/.ico companions.

Logo geometry is taken verbatim from the repo's brand SVGs
(assets/favicon.svg and assets/adonai-logo-stacked.svg) so the rasters
match the official mark exactly.

Requires: imagemagick (`convert`), and three TTF fonts in /tmp/fonts
(Cinzel.ttf, Playfair-Italic.ttf, Jakarta.ttf — any close serif/sans works).
"""
import subprocess, os

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(REPO, "assets")
def _font(preferred, fallback):
    """Use the brand TTF when present, else a bundled system face."""
    return preferred if os.path.exists(preferred) else fallback

FONT_CINZEL = _font("/tmp/fonts/Cinzel.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSerif-Bold.ttf")
FONT_PLAYFAIR = _font("/tmp/fonts/Playfair-Italic.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf")
FONT_JAKARTA = _font("/tmp/fonts/Jakarta.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf")

# --- polygon geometry (local SVG coordinates) ---
A_TILE = [(41,19),(59,19),(80,81),(62,81),(50,58),(38,81),(20,81)]
STAR_TILE = [(50,32.5),(50.9,39.8),(54.3,37.6),(52.2,41.1),(59.5,42),(52.2,42.9),
             (54.3,46.4),(50.9,44.2),(50,51.5),(49.1,44.2),(45.7,46.4),(47.8,42.9),
             (40.5,42),(47.8,41.1),(45.7,37.6),(49.1,39.8)]
A_MARK = [(42,15),(62,15),(85,85),(64,85),(52,61),(40,85),(19,85)]
STAR_MARK = [(52,28.5),(53,36),(56.6,33.7),(54.4,37.3),(62,38.2),(54.4,39.1),
             (56.6,42.7),(53,40.4),(52,47.9),(51,40.4),(47.4,42.7),(49.6,39.1),
             (42,38.2),(49.6,37.3),(47.4,33.7),(51,36)]

DARK = "#222222"          # tile background / glyph color
GLYPH = "#2E3236"         # charcoal glyph (matches printed logo)
TEXT_DARK = "#3A3A3A"
GOLD = "#C9962E"
STAR_CUT = "#FFFFFF"
CREAM = "#FAF7F2"

def poly(pts, s, tx, ty):
    return "polygon " + " ".join(f"{x*s+tx:.2f},{y*s+ty:.2f}" for x, y in pts)

def run(args):
    subprocess.run(args, check=True)

# ---------------------------------------------------------------- favicon tile
def favicon_master(path, size=512, ss=4):
    """Dark rounded tile with white A and dark star (assets/favicon.svg)."""
    S = size * ss / 100.0           # scale from 100-unit viewBox
    W = size * ss
    r = 22 * S
    d = (f"fill {DARK} roundrectangle 0,0 {W-1},{W-1} {r},{r} "
         f"fill #FFFFFF {poly(A_TILE, S, 0, 0)} "
         f"fill {DARK} {poly(STAR_TILE, S, 0, 0)}")
    run(["convert", "-size", f"{W}x{W}", "xc:none", "-draw", d,
         "-resize", f"{size}x{size}", "-depth", "8", "-strip", path])

# ---------------------------------------------------------------- cream icons
def cream_icon(path, size=512, glyph_h=300, bg=CREAM):
    """Full-bleed opaque tile: cream bg, charcoal A mark, white star."""
    ss = 2
    W = size * ss
    s = glyph_h * ss / 70.0          # glyph local height is 70 (y15..85)
    tx = W / 2 - 52 * s              # local center x = 52
    ty = W / 2 - 50 * s              # local center y = 50
    d = (f"fill {GLYPH} {poly(A_MARK, s, tx, ty)} "
         f"fill {STAR_CUT} {poly(STAR_MARK, s, tx, ty)}")
    run(["convert", "-size", f"{W}x{W}", f"xc:{bg}", "-draw", d,
         "-resize", f"{size}x{size}", "-depth", "8", "-strip", path])

# ------------------------------------------------------------------- OG image
def label(text, font, size, color, fname, kerning=0, stroke_w=0):
    args = ["convert", "-background", "none", "-font", font,
            "-pointsize", str(size), "-fill", color]
    if kerning:
        args += ["-kerning", str(kerning)]
    if stroke_w:
        args += ["-stroke", color, "-strokewidth", str(stroke_w)]
    args += ["label:" + text, "-trim", "+repage", fname]
    run(args)
    out = subprocess.check_output(["identify", "-format", "%w %h", fname]).decode().split()
    return int(out[0]), int(out[1])

def og_image(path):
    """Social share banner: logo mark, ADONAI STORE wordmark, motto. Nothing else."""
    W, H = 2400, 1260                 # 2x supersample of 1200x630
    MOTTO = "Your Choice, Straight to Your Door"
    # --- wordmark two-tone ---
    w1, h1 = label("ADONAI", FONT_CINZEL, 150, TEXT_DARK, "/tmp/w1.png", kerning=22, stroke_w=3)
    w2, h2 = label("STORE", FONT_CINZEL, 150, GOLD, "/tmp/w2.png", kerning=22, stroke_w=3)
    space = 88
    total = w1 + space + w2
    x1 = (W - total) // 2
    wm_top = 740                      # top of wordmark glyphs
    # --- A mark glyph (centred above the wordmark) ---
    s = 470.0 / 70.0
    tx = W/2 - 52*s
    ty = 220                          # top of glyph
    d_glyph = (f"fill {GLYPH} {poly(A_MARK, s, tx, ty-15*s)} "
               f"fill {STAR_CUT} {poly(STAR_MARK, s, tx, ty-15*s)}")
    # frame + gold divider bar under the wordmark
    d_frame = (f"fill none stroke #E9E2D6 stroke-width 4 rectangle 52,52 {W-52},{H-52} "
               f"stroke none fill {GOLD} roundrectangle {W//2-145},960 {W//2+145},976 8,8")
    run(["convert", "-size", f"{W}x{H}", "xc:#FFFFFF",
         "-draw", d_frame,
         "-draw", d_glyph,
         "/tmp/og_base.png"])
    # composite wordmark halves
    run(["convert", "/tmp/og_base.png",
         "/tmp/w1.png", "-geometry", f"+{x1}+{wm_top}", "-composite",
         "/tmp/w2.png", "-geometry", f"+{x1+w1+space}+{wm_top}", "-composite",
         "/tmp/og_base.png"])
    # bottom footer: store motto only (no contacts, URLs or delivery notes)
    run(["convert", "/tmp/og_base.png",
         "-font", FONT_PLAYFAIR, "-pointsize", "66", "-fill", "#5C5548",
         "-kerning", "4", "-gravity", "center", "-annotate", "+0+440", MOTTO,
         "-resize", "1200x630!", "-depth", "8", "-strip", path])


if __name__ == "__main__":
    favicon_master(f"{OUT}/favicon-512.png")
    for n in (16, 32, 48):
        favicon_master(f"/tmp/favicon-{n}.png", size=n, ss=8)
    run(["convert", "/tmp/favicon-16.png", "/tmp/favicon-32.png", "/tmp/favicon-48.png",
         f"{OUT}/favicon.ico"])
    run(["convert", f"{OUT}/favicon-512.png", "-resize", "32x32", "-depth", "8", f"{OUT}/favicon-32x32.png"])
    run(["convert", f"{OUT}/favicon-512.png", "-resize", "16x16", "-depth", "8", f"{OUT}/favicon-16x16.png"])
    cream_icon(f"{OUT}/icon-512.png", size=512, glyph_h=300)
    cream_icon(f"{OUT}/icon-maskable-512.png", size=512, glyph_h=350)
    run(["convert", f"{OUT}/icon-512.png", "-resize", "192x192", "-depth", "8", f"{OUT}/icon-192.png"])
    run(["convert", f"{OUT}/icon-512.png", "-resize", "180x180", "-depth", "8", f"{OUT}/apple-touch-icon.png"])
    og_image(f"{OUT}/og-image.png")
    run(["cp", f"{OUT}/og-image.png", f"{OUT}/og-preview-banner.png"])
    print("done")
    for f in sorted(os.listdir(OUT)):
        if f.endswith((".png", ".ico")):
            p = os.path.join(OUT, f)
            print(f, os.path.getsize(p))
