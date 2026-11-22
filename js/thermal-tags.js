/* Small thermal stock tags: 32 × 16 mm Code 128 labels on an 80 mm roll.
 *
 * Why this file exists: Android's print framework renders every page to a
 * PDF before a print service sees it. A Bluetooth ESC/POS printer is not a
 * print service, so the "Print tag" button could only ever offer "Save as
 * PDF". Receipts already dodge that by packing a 1-bit raster and handing it
 * to the native Bluetooth bridge; the stock tags do exactly the same.
 *
 * The sheet is laid out in printer dots (8 dots per mm at 203 dpi) and every
 * bar sits on a whole number of dots, so the raster never blurs a barcode
 * edge into grey.
 */
(function (global) {
  "use strict";
  const DOC = document;

  const ROLL_DOTS = 576;            // 80 mm head at 203 dpi
  const TAG_DOTS = { width: 256, height: 128 };  // 32 × 16 mm
  const GAP_DOTS = 8;               // 1 mm between tags, the cut channel
  const PAD_DOTS = 6;               // 0.75 mm inside each tag (quiet zones sit in the code itself)
  const SHEET_MARGIN_DOTS = 8;      // 1 mm of white roll at the strip edges
  const MIN_MODULE_DOTS = 2;        // 0.25 mm bars — the floor for a phone camera
  const MAX_TAGS = 50;              // 25 rows ≈ 216 mm of roll per job
  const CSS_PER_DOT = 0.5;          // html2canvas runs at scale 2 → 2 canvas px per dot
  const CUT_INK = "#999";

  const esc = value => String(value == null ? "" : value)
    .replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const px = dots => (dots * CSS_PER_DOT) + "px";

  function tagCode(product) {
    if (!product) return "";
    if (global.DB && typeof DB.normalizeTagCode === "function") return DB.normalizeTagCode(product.tag_code);
    const text = String(product.tag_code == null ? "" : product.tag_code).trim().replace(/^T/i, "").replace(/[\s\-_]/g, "");
    return /^[0-9]{4,6}$/.test(text) ? text : "";
  }

  /* "M · TOPS" — the one extra line a 16 mm tag can carry. */
  function metaLine(product) {
    const size = String(product && product.size || "").trim().slice(0, 4);
    const group = String(product && product.category || "").trim().split(/[\s&,/]+/).filter(Boolean)[0] || "";
    const short = group.slice(0, 9).toUpperCase();
    return [size.toUpperCase(), short].filter(Boolean).join(" · ");
  }

  function barMarkup(code) {
    const geometry = global.DB && DB.code128Modules ? DB.code128Modules(code) : null;
    if (!geometry) throw new Error("This stock-tag code cannot be printed as Code 128.");
    const usable = TAG_DOTS.width - 2 * PAD_DOTS;
    const scale = Math.floor(usable / geometry.total);
    if (scale < MIN_MODULE_DOTS) {
      throw new Error("This stock-tag code is too wide for a 32 × 16 mm tag. Print the standard 80 × 50 mm tag instead.");
    }
    const bars = geometry.bars
      .map(bar => `<span style="position:absolute;top:0;height:100%;background:#000;left:${px(bar.x * scale)};width:${px(bar.w * scale)}"></span>`)
      .join("");
    return `<div style="position:relative;height:32px;width:${px(geometry.total * scale)};margin:0 auto;background:#fff">${bars}</div>`;
  }

  function tagMarkup(product, code, at = "") {
    return `<article style="position:absolute;${at}display:block;box-sizing:border-box;background:#fff;color:#000;` +
      `width:${px(TAG_DOTS.width)};height:${px(TAG_DOTS.height)};padding:${px(4)} ${px(PAD_DOTS)};` +
      `font-family:Arial,Helvetica,sans-serif;overflow:hidden;text-align:center">` +
      `<p style="margin:0;height:11px;font:700 9px/11px Arial,Helvetica,sans-serif;letter-spacing:.06em;` +
      `text-transform:uppercase;white-space:nowrap;overflow:hidden">${esc(metaLine(product))}</p>` +
      barMarkup(code) +
      `<p style="margin:0;height:13px;font:700 12px/13px &quot;Courier New&quot;,monospace;letter-spacing:.08em">${esc(code)}</p>` +
      `</article>`;
  }

  /* Absolute placement only: html2canvas does not lay out CSS grid, and a
     shifted tag is a mis-cut label. */
  function sheetMarkup(items) {
    const rows = Math.ceil(items.length / 2);
    const blockWidth = 2 * TAG_DOTS.width + GAP_DOTS;
    const left = Math.floor((ROLL_DOTS - blockWidth) / 2);
    const height = SHEET_MARGIN_DOTS * 2 + rows * TAG_DOTS.height + (rows - 1) * GAP_DOTS;
    const tags = items.map((product, index) => {
      const row = Math.floor(index / 2), column = index % 2;
      const x = left + column * (TAG_DOTS.width + GAP_DOTS);
      const y = SHEET_MARGIN_DOTS + row * (TAG_DOTS.height + GAP_DOTS);
      return tagMarkup(product, tagCode(product), `left:${px(x)};top:${px(y)};`);
    }).join("");
    const guides = [];
    if (items.length > 2) {
      for (let row = 1; row < rows; row++) {
        const y = SHEET_MARGIN_DOTS + row * TAG_DOTS.height + (row - 1) * GAP_DOTS + Math.floor(GAP_DOTS / 2);
        guides.push(`<span style="position:absolute;left:${px(left)};top:${px(y)};` +
          `width:${px(blockWidth)};height:1px;background:${CUT_INK}"></span>`);
      }
    }
    if (items.length > 1) {
      const columnGuide = left + TAG_DOTS.width + Math.floor(GAP_DOTS / 2);
      guides.push(`<span style="position:absolute;left:${px(columnGuide)};top:${px(SHEET_MARGIN_DOTS)};` +
        `width:1px;height:${px(height - SHEET_MARGIN_DOTS * 2)};background:${CUT_INK}"></span>`);
    }
    return `<div style="position:relative;width:${px(ROLL_DOTS)};height:${px(height)};background:#fff">${tags}${guides.join("")}</div>`;
  }

  function buildSheet(items) {
    const host = DOC.createElement("div");
    host.setAttribute("data-thermal-tags", "1");
    host.style.cssText = `position:absolute;left:-9999px;top:0;width:${px(ROLL_DOTS)};background:#fff;pointer-events:none;`;
    host.innerHTML = sheetMarkup(items);
    DOC.body.appendChild(host);
    return host;
  }

  function assertStockAccess() {
    if (global.PosAccess && typeof PosAccess.canUse === "function" && !PosAccess.canUse("stock")) {
      throw new Error("Unlock Stock before printing stock tags.");
    }
  }
  function assertThermalBridge() {
    if (!global.Android || typeof global.Android.printThermalReceipt !== "function") {
      throw new Error("Stock tags print on the Bluetooth thermal printer. Open Catalog Intake in the ADONAI POS app on the phone paired with that printer.");
    }
    if (!global.html2canvas) throw new Error("The tag renderer did not load. Reopen the app and try again.");
  }

  async function rasterize(host) {
    const canvas = await global.html2canvas(host, { scale: 2, backgroundColor: "#fff", logging: false });
    const { width, height } = canvas;
    if (width !== ROLL_DOTS) throw new Error("The tag sheet did not render at roll width. Try again.");
    if (!height || height > 12000) throw new Error("This tag job is too long. Print fewer tags.");
    const pixels = canvas.getContext("2d").getImageData(0, 0, width, height).data;
    const bytes = new Uint8Array(width * height / 8);
    for (let i = 0; i < width * height; i++) {
      const j = i * 4;
      // Same 1-bit threshold as receipts: anything that reads as dark ink is
      // a dot. Light greys (the cut guides) stay off the paper.
      if ((pixels[j] * 299 + pixels[j + 1] * 587 + pixels[j + 2] * 114) < 180000) bytes[i >> 3] |= 128 >> (i % 8);
    }
    let binary = "";
    for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
    return { base64: btoa(binary), width, height };
  }

  function expand(products, copies) {
    const items = [];
    (products || []).forEach(product => { for (let i = 0; i < copies; i++) items.push(product); });
    return items;
  }

  async function print(products, options = {}) {
    const copies = Math.max(1, Math.min(9, Math.round(Number(options.copies) || 1)));
    const list = (products || []).filter(Boolean);
    if (!list.length) throw new Error("Choose a saved garment before printing a stock tag.");
    assertStockAccess();
    if (list.some(product => !tagCode(product))) {
      throw new Error("This piece has no stock-tag code yet. Refresh the catalog, then print the tag again.");
    }
    assertThermalBridge();
    const items = expand(list, copies);
    if (items.length > MAX_TAGS) {
      throw new Error(`Print at most ${MAX_TAGS} tags per job. Choose fewer copies and print the next batch.`);
    }
    const host = buildSheet(items);
    try {
      const shot = await rasterize(host);
      if (!global.Android.printThermalReceipt(shot.base64, shot.width, shot.height)) {
        throw new Error("The printer is busy. Finish the open print job, then try again.");
      }
      return { tags: items.length, rows: Math.ceil(items.length / 2), width: shot.width, height: shot.height };
    } finally { host.remove(); }
  }

  /* Dialog preview: the same markup, doubled so staff can read it on screen. */
  function preview(product, scale = 2.6) {
    const code = tagCode(product);
    if (!code) return "";
    const width = TAG_DOTS.width * CSS_PER_DOT * scale;
    const height = TAG_DOTS.height * CSS_PER_DOT * scale;
    return `<div class="tt-preview" style="width:${width}px;height:${height}px">` +
      `<div style="position:relative;width:${px(TAG_DOTS.width)};height:${px(TAG_DOTS.height)};` +
      `transform:scale(${scale});transform-origin:top left;background:#fff">${tagMarkup(product, code)}</div></div>`;
  }

  global.ThermalTags = {
    TAG_MM: { width: 32, height: 16 },
    PER_ROW: 2,
    MAX_TAGS,
    tagCode,
    metaLine,
    sheetMarkup,
    preview,
    print
  };
})(window);
