#!/usr/bin/env node
/* Small thermal stock tags (32 × 16 mm Code 128) — geometry, raster and the
   hard rule that a tag job never falls back to the PDF print dialog. */
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");
const ROOT = path.resolve(__dirname, "..");
const source = file => fs.readFileSync(path.join(ROOT, file), "utf8");

const PIECE = { id: "PRD-TAG-1", name: "Fixture cotton shirt", size: "M", category: "Tops & Shirts", tag_code: "1042" };

function fixture() {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "https://unit.example/admin.html", runScripts: "outside-only", pretendToBeVisual: true
  });
  const win = dom.window;
  win.fetch = async () => ({ ok: true, json: async () => ({}) });
  win.eval(source("js/db.js"));
  win.PosAccess = { canUse: () => true };
  const state = { printed: 0, raster: null, dots: 0, rows: 0 };
  win.print = () => { state.printed++; };
  win.eval(source("js/thermal-tags.js"));
  return { win, doc: win.document, state, close: () => win.close() };
}

const pxDots = dots => dots * 0.5;

function barGeometry(f, code) {
  return f.win.DB.code128Modules(code);
}

(async () => {
  const f = fixture();
  try {
    const tags = f.win.ThermalTags;

    /* ---------- a 4-digit code fits a 32 mm tag at 0.25 mm bars ---------- */
    const geometry = barGeometry(f, "1042");
    assert.equal(geometry.total, 99, "4-digit Code 128-B is 99 modules including both quiet zones");
    const usable = 256 - 2 * 6;
    const scale = Math.floor(usable / geometry.total);
    assert.equal(scale, 2, "32 mm tags print bars two dots wide (0.25 mm)");
    assert(scale >= 2, "never print bars thinner than the phone camera can read");

    const five = [PIECE, PIECE, PIECE, PIECE, PIECE];
    const markup = tags.sheetMarkup(five);
    assert.match(markup, new RegExp(`width:${pxDots(256)}px;height:${pxDots(128)}px`), "each tag is 32 × 16 mm on the roll");
    assert.equal((markup.match(/<article/g) || []).length, 5, "one tag per requested piece");
    assert.match(markup, new RegExp(`width:${pxDots(geometry.total * scale)}px`), "bars span whole dots at the chosen module scale");
    // Three rows: 8 + 3×128 + 2×8 dots tall.
    assert.match(markup, new RegExp(`height:${pxDots(8 * 2 + 3 * 128 + 2 * 8)}px`), "strip length is the row count, not a page");
    assert.equal((markup.match(/height:1px;background:#999/g) || []).length, 2, "one cut line between each pair of rows");
    assert.equal((markup.match(/width:1px;height:/g) || []).length, 1, "one cut line between the two columns");
    assert.doesNotMatch(markup, /gt-hangtag/, "thermal tags do not reuse the A4 hangtag markup");
    const lefts = [...markup.matchAll(/left:([\d.]+)px;top:([\d.]+)px;display:block/g)].map(m => [+m[1], +m[2]]);
    assert.equal(new Set(lefts.map(([x]) => x)).size, 2, "two tags per row");
    assert.equal(new Set(lefts.map(([, y]) => y)).size, 3, "five tags make three rows");
    assert(lefts.every(([x, y]) => Number.isInteger(x) && Number.isInteger(y)), "every tag sits on a whole CSS pixel (whole printer dots at 2×)");
    for (const [, w] of markup.matchAll(/left:[\d.]+px;width:([\d.]+)px/g)) {
      assert(Number.isInteger(+w), "bar widths land on whole printer dots");
    }

    /* ---------- the extra line a 16 mm tag can carry ---------- */
    assert.equal(tags.metaLine(PIECE), "M · TOPS");
    assert.equal(tags.metaLine({ size: "XL", category: "Outerwear & Jackets" }), "XL · OUTERWEAR");
    assert.equal(tags.metaLine({}), "");
    assert.equal(tags.tagCode({ tag_code: "T-1042" }), "1042", "typed 'T-1042' is the same tag");
    assert.equal(tags.tagCode({ tag_code: "" }), "");

    /* ---------- no bridge: an honest refusal, never a PDF ---------- */
    await assert.rejects(tags.print([PIECE]), /Bluetooth thermal printer/);
    assert.equal(f.state.printed, 0, "tags never fall back to the browser/PDF print path");

    f.win.PosAccess = { canUse: () => false };
    await assert.rejects(tags.print([PIECE]), /Unlock Stock/);
    f.win.PosAccess = { canUse: () => true };

    /* ---------- pieces with no allocated code are refused ---------- */
    await assert.rejects(tags.print([{ id: "PRD-NO-CODE", name: "x" }]), /no stock-tag code/);
    await assert.rejects(tags.print([]), /saved garment/);

    /* ---------- the Android bridge receives a 576-dot 1-bit raster ---------- */
    let sent = null;
    f.win.Android = {
      printThermalReceipt: (base64, dots, rows) => {
        sent = { data: Buffer.from(base64, "base64"), dots, rows };
        return true;
      }
    };
    // 576 wide × 8 tall, one black pixel in the top-left corner.
    const rgba = new Uint8ClampedArray(576 * 8 * 4).fill(255);
    rgba.fill(0, 0, 3);
    f.win.html2canvas = async () => ({ width: 576, height: 8, getContext: () => ({ getImageData: () => ({ data: rgba }) }) });
    await assert.rejects(tags.print(Array.from({ length: 51 }, () => PIECE)), /at most 50 tags/, "one job never becomes an unmanageable strip");
    const result = await tags.print([PIECE], { copies: 2 });
    assert.equal(result.tags, 2);
    assert.equal(result.rows, 1);
    assert.equal(sent.dots, 576, "80 mm roll, never a 58 mm or A4 page");
    assert.equal(sent.rows, 8);
    assert.equal(sent.data.length, 576 / 8 * 8, "packed one bit per dot, eight dots per byte");
    assert.equal(sent.data[0], 0b10000000, "the dark pixel becomes the top bit, exactly like receipts");
    assert.equal(sent.data[1], 0, "white paper stays zero");
    assert.equal(f.state.printed, 0);

    /* ---------- a busy printer reports honestly ---------- */
    f.win.Android.printThermalReceipt = () => false;
    await assert.rejects(tags.print([PIECE]), /printer is busy/);

    /* ---------- width guard: six digits fit, seven do not ---------- */
    assert.equal(barGeometry(f, "100042").total, 121, "6 digits still leave 0.25 mm bars on a 32 mm tag");
    assert.match(tags.preview({ id: "X", tag_code: "100042", size: "M", category: "Tops" }), /100042/);
    assert.equal(tags.tagCode({ tag_code: "1000042" }), "", "seven digits is not a valid stock-tag code");

    console.log("✓ 32 × 16 mm Code 128 tags: two per row, whole-dot bars, cut lines and a 576-dot raster straight to Bluetooth (no PDF)");
  } finally { f.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
