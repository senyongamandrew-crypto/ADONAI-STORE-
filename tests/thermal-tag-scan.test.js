#!/usr/bin/env node
/* Does the label actually scan?
 *
 * The 32 × 16 mm stock tag prints Code 128 at 0.25 mm bars. That is the
 * smallest module this app is willing to print, so it is worth proving with a
 * real decoder instead of trusting the arithmetic: this paints the exact
 * pixel geometry the printer receives (576-dot row, 32 mm tag, 6-dot padding,
 * bars scaled to whole dots) and asks ZXing to read it back.
 */
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");
const { RGBLuminanceSource, BinaryBitmap, HybridBinarizer, MultiFormatReader, DecodeHintType, BarcodeFormat } = require("@zxing/library");
const ROOT = path.resolve(__dirname, "..");
const source = file => fs.readFileSync(path.join(ROOT, file), "utf8");

const ROLL_DOTS = 576, TAG_DOTS = 256, GAP_DOTS = 8, PAD_DOTS = 6;
const BLACK = -16777216;                 // 0xFF000000 — printed dot
const WHITE = 0xFFFFFFFF;
// The cut guides are #999999; at 203 dpi they land on the paper as ink, so a
// grey bar must still decode (print density varies between printers).
const GREY = (-16777216 | 0x999999) | 0;

const dom = new JSDOM("", { url: "https://unit.example/", runScripts: "outside-only" });
dom.window.fetch = async () => ({ ok: true, json: async () => ({}) });
dom.window.eval(source("js/db.js"));
const DB = dom.window.DB;

/* Paint one tag into a 576-dot row, exactly where the sheet renderer puts it. */
function paint(code, scale, ink) {
  const geometry = DB.code128Modules(code);
  const width = ROLL_DOTS, height = 180;
  const pixels = new Int32Array(width * height).fill(WHITE);
  const tagLeft = Math.floor((ROLL_DOTS - (2 * TAG_DOTS + GAP_DOTS)) / 2);
  const usableDots = TAG_DOTS - 2 * PAD_DOTS;
  const barsLeft = tagLeft + PAD_DOTS + Math.floor((usableDots - geometry.total * scale) / 2);
  for (const bar of geometry.bars) {
    const x0 = barsLeft + bar.x * scale, x1 = x0 + bar.w * scale;
    for (let y = 40; y < 40 + 64; y++) {
      for (let x = x0; x < x1; x++) pixels[y * width + x] = ink;
    }
  }
  return { pixels, width, height, geometry };
}

function read(code, scale, ink) {
  const { pixels, width, height } = paint(code, scale, ink);
  const bitmap = new BinaryBitmap(new HybridBinarizer(new RGBLuminanceSource(pixels, width, height)));
  const hints = new Map([[DecodeHintType.POSSIBLE_FORMATS, [BarcodeFormat.CODE_128]]]);
  return new MultiFormatReader().decode(bitmap, hints).getText();
}

/* The floor this app prints at: two dots per module on a 203 dpi head. */
assert.equal(Math.floor((TAG_DOTS - 2 * PAD_DOTS) / DB.code128Modules("1042").total), 2,
  "a 4-digit code gets 0.25 mm bars on a 32 mm tag");
assert.equal(Math.floor((TAG_DOTS - 2 * PAD_DOTS) / DB.code128Modules("999999").total), 2,
  "the widest supported code (6 digits) still gets 0.25 mm bars");

for (const code of ["1001", "1042", "999999"]) {
  for (const [scale, ink, note] of [
    [2, BLACK, "0.25 mm bars, full black"],
    [3, BLACK, "0.375 mm bars, full black"],
    [2, GREY, "0.25 mm bars, grey ink after the 1-bit threshold"]
  ]) {
    const decoded = read(code, scale, ink);
    assert.equal(decoded, code, `ZXing must read ${code} (${note})`);
  }
}

/* A camera sees a quiet zone or it does not; the tag must keep both. */
const geometry = DB.code128Modules("1042");
assert.equal(geometry.quiet, 10, "Code 128 needs ten modules of white on each side");
assert.equal(geometry.bars[0].x, geometry.quiet, "the first bar starts after the quiet zone");
assert.equal(geometry.total - (geometry.bars[geometry.bars.length - 1].x + geometry.bars[geometry.bars.length - 1].w),
  geometry.quiet, "the last bar leaves the same quiet zone");

dom.window.close();
console.log("✓ 32 × 16 mm stock tags decode at 0.25 mm bars in ZXing — 4- and 6-digit codes, both print densities");
process.exit(0);
