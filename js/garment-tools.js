/* Garment hangtags: saved catalog data, local Code 128, and system printing. */
(function (global) {
  "use strict";
  const doc = document;
  const esc = value => String(value == null ? "" : value).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const FORMATS = {
    label: { name: "80 × 50 mm label", width: 80, height: 50, page: "80mm 50mm", margin: "0", sheet: false },
    compact: { name: "62 × 40 mm label", width: 62, height: 40, page: "62mm 40mm", margin: "0", sheet: false },
    a4: { name: "A4 · 80 × 50 mm cut-out tags", width: 80, height: 50, page: "A4", margin: "10mm", sheet: true },
    wide: { name: "A4 · wide tags for long codes", width: 180, height: 60, page: "A4", margin: "10mm", sheet: true },
    // Printed straight to the Bluetooth ESC/POS printer as a 1-bit raster:
    // 2 tags across, 5 rows, 10 per job, cut apart on the grey lines. This is
    // the only format that never passes through Android's PDF print dialog.
    mini: { name: "Thermal · 32 × 16 mm stock tags (80 mm roll)", width: 32, height: 16, thermal: true }
  };
  const PAPER_KEY = "adonai.tag-paper.v1";
  // Layout sample for the thermal preview — never a real catalog piece.
  const SAMPLE_TAG = { id: "LAYOUT-ONLY", name: "Cotton Shirt", size: "M", category: "Tops & Shirts", tag_code: "1001" };
  let tagDialog = null;
  let printing = false;

  /* The installed Android app can hand a finished 1-bit raster to a paired
     Bluetooth ESC/POS printer. That printer only understands raster/receipt
     commands: every other paper choice below is a PDF print job, and a receipt
     printer renders those bytes as garbage characters in its alternate
     character set. So when the bridge exists the thermal strip is the safe
     default and the PDF sizes are labelled and confirmed before use. */
  function thermalBridge() {
    return !!(global.Android && typeof global.Android.printThermalReceipt === "function" && global.ThermalTags);
  }
  function paperKeys(bridge) {
    const keys = Object.keys(FORMATS);
    return bridge && FORMATS.mini ? ["mini"].concat(keys.filter(key => key !== "mini")) : keys;
  }
  function paperName(format, bridge) {
    if (!bridge || format.thermal) return format.name;
    return format.name + " — phone print dialog (PDF)";
  }
  function defaultPaper(bridge) {
    let stored = "";
    try { stored = localStorage.getItem(PAPER_KEY) || ""; } catch (e) {}
    if (FORMATS[stored] && (FORMATS[stored].thermal ? bridge : true)) return stored;
    return bridge ? "mini" : "label";
  }

  function dialog(id, html, onClose) {
    const previous = doc.activeElement;
    const root = doc.createElement("dialog");
    root.className = "gt-dialog";
    root.id = id;
    root.setAttribute("aria-labelledby", id + "Title");
    root.innerHTML = `<section class="gt-panel">${html}</section>`;
    let closed = false;
    function close() {
      if (closed) return;
      closed = true;
      if (typeof root.close === "function") root.close();
      root.remove();
      if (onClose) onClose();
      if (previous && previous.isConnected) previous.focus();
    }
    root.addEventListener("cancel", event => { event.preventDefault(); close(); });
    root.addEventListener("click", event => {
      if (event.target === root || event.target.closest("[data-gt-close]")) close();
    });
    root.addEventListener("keydown", event => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); }
      if (event.key === "Tab") {
        const controls = Array.from(root.querySelectorAll("button, a[href], input, select, [tabindex='0']")).filter(el => !el.disabled && !el.hidden);
        const first = controls[0], last = controls[controls.length - 1];
        if (event.shiftKey && doc.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && doc.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    });
    doc.body.appendChild(root);
    if (typeof root.showModal === "function") root.showModal();
    else { root.setAttribute("open", ""); root.setAttribute("role", "dialog"); root.setAttribute("aria-modal", "true"); }
    const first = root.querySelector("[autofocus], [data-gt-close], button");
    if (first) first.focus();
    return { root, close, isOpen: () => !closed };
  }

  function stockAllowed() {
    return !global.PosAccess || global.PosAccess.canUse("stock");
  }
  function productById(id) {
    return global.DB.getProduct ? DB.getProduct(id) : DB.listProducts().find(p => String(p.id) === String(id));
  }
  function websiteLabel(settings = {}) {
    // Print the configured storefront, never a temporary preview / native origin.
    const fallback = "https://www.adonaithrift-store.online/";
    const raw = String(settings.website_url || settings.app_url || fallback).trim();
    try {
      const url = new URL(/^https?:\/\//i.test(raw) ? raw : "https://" + raw);
      const shell = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|appassets\.androidplatform\.net)$|\.e2b\.app$/i.test(url.hostname);
      if (!/^https?:$/.test(url.protocol) || url.username || url.password || shell) throw new Error("Not a public storefront");
      return url.host.replace(/^www\./i, "") + url.pathname.replace(/\/+$/, "");
    } catch (e) { return "adonaithrift-store.online"; }
  }
  function tagModel(product, sample) {
    if (!product || !product.id) throw new Error("Save this garment before printing its tag.");
    // The saved SKU is a stable, supported checkout alias. Using it avoids
    // printing the legacy internal -1OF1 condition marker on a customer tag.
    const code = String(product.sku || product.barcode_id || "").trim();
    if (!code || !/^[\x20-\x7e]+$/.test(code)) throw new Error("This barcode cannot be printed as Code 128. Use a printable English-letter / number SKU.");
    const settings = DB.getSettings() || {};
    return {
      id: product.id, name: String(product.name || "Garment"), code,
      store: String(settings.store_name || "ADONAI STORE"), website: websiteLabel(settings), sample: !!sample
    };
  }
  function tagHTML(model) {
    const svg = DB.barcodeSVG(model.code, 58).replace(/fill="#1A1410"/g, 'fill="#000"');
    if (!svg) throw new Error("Unable to generate this garment's barcode.");
    return `<article class="gt-hangtag">
      <header class="gt-tag-brand">${esc(model.store)}</header>
      <h3 class="gt-tag-name">${esc(model.name)}</h3>
      <div class="gt-tag-bars">${svg}</div>
      <p class="gt-tag-code">${esc(model.code)}</p>
      <footer class="gt-tag-website">${esc(model.website)}</footer>
    </article>`;
  }
  function codeFits(model, format) {
    // Code 128-B: start + data + checksum (11 modules each), 13-module stop,
    // and two 10-module quiet zones. Keep modules at least 0.25 mm on paper.
    return ((model.code.length + 2) * 11 + 13 + 20) * 0.25 <= format.width - 6;
  }
  function thermalCode(product) {
    return global.ThermalTags ? ThermalTags.tagCode(product) : "";
  }
  function thermalFits(product) {
    if (!global.ThermalTags) return { fits: false, reason: "This app build needs the stock-tag update. Reload the app and try again." };
    const code = thermalCode(product);
    if (!code) return { fits: false, reason: "This piece has no stock-tag code yet. Refresh the catalog, then print the tag again." };
    const geometry = global.DB && DB.code128Modules ? DB.code128Modules(code) : null;
    if (!geometry) return { fits: false, reason: "This stock-tag code cannot be printed as Code 128." };
    const fits = Math.floor((256 - 12) / geometry.total) >= 2;
    return { fits, reason: fits ? "" : "This code is too wide for a 32 × 16 mm tag. Print the standard 80 × 50 mm tag instead." };
  }
  function printStyles(format) {
    return `@media print {
      @page { size: ${format.page}; margin: ${format.margin}; }
      html, body { margin: 0 !important; padding: 0 !important; background: #fff !important; height: auto !important; overflow: visible !important; }
      body.gt-printing > * { display: none !important; }
      body.gt-printing #garmentPrintSheet { display: grid !important; visibility: visible !important; position: static !important; width: auto !important; margin: 0 !important; padding: 0 !important; grid-template-columns: ${format.sheet && format.width === 80 ? "repeat(2, 80mm)" : format.width + "mm"}; gap: ${format.sheet ? "5mm" : "0"}; }
      body.gt-printing #garmentPrintSheet * { visibility: visible !important; }
      body.gt-printing #receiptSheet { display: none !important; }
      #garmentPrintSheet .gt-hangtag { width: ${format.width}mm !important; height: ${format.height}mm !important; padding: ${format.height === 40 ? "2" : "3"}mm !important; min-height: 0 !important; aspect-ratio: auto !important; margin: 0 !important; box-sizing: border-box; border: ${format.sheet ? ".2mm dashed #777" : "0"}; border-radius: 0 !important; box-shadow: none !important; break-inside: avoid; ${format.sheet ? "" : "break-after: page;"} }
      #garmentPrintSheet .gt-hangtag:last-child { break-after: auto; }
      #garmentPrintSheet .gt-tag-brand { width: 100%; font-size: ${format.height === 40 ? "9" : "10"}pt; line-height: 1.3; padding-bottom: 2mm; margin-bottom: 2mm; border-bottom: .15mm solid #111; }
      #garmentPrintSheet .gt-tag-name { font-size: ${format.height === 40 ? "10" : "12"}pt; line-height: 1.25; margin: 0 !important; }
      #garmentPrintSheet .gt-tag-code { font-size: ${format.height === 40 ? "6.5" : "7"}pt; line-height: 1.6; }
      #garmentPrintSheet .gt-tag-website { font-size: ${format.height === 40 ? "6" : "7"}pt; line-height: 1.5; margin-top: 1mm; }
      #garmentPrintSheet .gt-tag-bars { height: ${format.height === 40 ? "10" : "14"}mm; }
      #garmentPrintSheet .gt-tag-bars svg { width: 100% !important; max-width: none !important; height: 100% !important; }
    }`;
  }
  function cleanupPrint() {
    printing = false;
    doc.body.classList.remove("gt-printing");
    const sheet = doc.getElementById("garmentPrintSheet"), style = doc.getElementById("garmentPrintStyle");
    if (sheet) sheet.remove();
    if (style) style.remove();
  }
  function printTags(model, format, copies) {
    if (format && format.thermal) throw new Error("Stock tags print on the Bluetooth thermal printer. Choose a label size to print a paper tag instead.");
    if (printing) return;
    const markup = Array.from({ length: copies }, () => tagHTML(model)).join("");
    const style = printStyles(format);
    if (global.Android && typeof Android.printTags === "function") {
      // The native bridge uses an isolated, JavaScript-disabled print WebView.
      const html = `<!doctype html><html><head><meta charset="UTF-8"><style>${TAG_BASE_CSS}${style}</style></head><body class="gt-printing"><div id="garmentPrintSheet">${markup}</div></body></html>`;
      if (html.length > 1024 * 1024) throw new Error("This print job is too large. Choose fewer copies and print in batches.");
      Android.printTags(html, format.sheet ? "a4" : (format.width === 62 ? "compact" : "label"));
      return;
    }
    cleanupPrint();
    const sheet = doc.createElement("div"); sheet.id = "garmentPrintSheet"; sheet.innerHTML = markup;
    const printStyle = doc.createElement("style"); printStyle.id = "garmentPrintStyle"; printStyle.textContent = style;
    doc.head.appendChild(printStyle); doc.body.appendChild(sheet);
    doc.body.classList.add("gt-printing"); printing = true;
    try { global.print(); }
    catch (error) { cleanupPrint(); throw new Error("Printing could not open. Try opening Catalog Intake in your phone's browser."); }
  }
  // Kept small and self-contained for native Android's isolated print document.
  const TAG_BASE_CSS = `.gt-hangtag{display:flex;flex-direction:column;align-items:center;text-align:center;background:#fff;color:#000;font-family:Arial,sans-serif;overflow:hidden} .gt-hangtag p,.gt-hangtag h3{margin:0} .gt-tag-brand{font-weight:800;letter-spacing:.12em;text-transform:uppercase} .gt-tag-name{font-weight:700;line-height:1.25;max-width:100%;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical} .gt-tag-bars{width:100%;flex-shrink:0;margin-top:auto;background:#fff} .gt-tag-bars svg{display:block} .gt-tag-code{font-family:monospace;line-height:1.6;white-space:nowrap} .gt-tag-website{max-width:100%;overflow:hidden;overflow-wrap:anywhere;line-height:1.5} `;

  async function openTag(id, sample = false) {
    if (global.PosAccess && !stockAllowed() && !(await PosAccess.ensure("stock"))) return;
    if (tagDialog) tagDialog.close();
    const sampleProduct = { id: "LAYOUT-ONLY", name: "Cotton Shirt", sku: "ADN-000000", barcode_id: "ADN-000000" };
    let model;
    try { model = tagModel(sample ? sampleProduct : productById(id), sample); }
    catch (error) { notify(error.message); return; }
    const bridge = thermalBridge();
    const preferred = defaultPaper(bridge);
    const current = dialog("garmentTagDialog", `
      <div class="gt-heading"><div><p class="gt-eyebrow">${sample ? "CLEAN GARMENT TAG · LAYOUT PREVIEW" : "SAVED GARMENT · READY TO ATTACH"}</p><h2 id="garmentTagDialogTitle">${sample ? "Garment tag preview" : "Print garment tag"}</h2></div><button class="gt-icon-button" type="button" data-gt-close aria-label="Close tag preview">×</button></div>
      <p class="gt-description">${sample ? "This layout is an example, not a saved catalog item. Print a saved garment for a working checkout barcode." : "The barcode identifies this saved garment. Checkout retrieves its current catalog price."}</p>
      <div class="gt-tag-stage" id="garmentTagPreview"></div>
      <div class="gt-print-options"><label for="gtPaper">Paper / tag size<select id="gtPaper">${paperKeys(bridge).map(key => `<option value="${key}"${key === preferred ? " selected" : ""}>${paperName(FORMATS[key], bridge)}</option>`).join("")}</select></label><label for="gtCopies">Copies<input id="gtCopies" type="number" inputmode="numeric" min="1" max="100" value="1" /></label></div>
      <p class="gt-pdf-warning" id="gtPdfWarning" role="alert" hidden></p>
      <p class="gt-message" id="gtPrintMessage" role="status" aria-live="polite"></p>
      <p class="gt-print-help">Print at <strong>100% / Actual size</strong>, with browser headers and footers off. Attach the label to a hangtag, not directly to fabric. A4 tags include cut lines.</p>
      <div class="gt-actions"><button class="btn" type="button" data-gt-close>Close</button><button class="btn primary" type="button" id="gtPrintButton">Print ${sample ? "layout" : "tag"}</button></div>`, () => { if (tagDialog === current) tagDialog = null; });
    tagDialog = current;
    const paper = current.root.querySelector("#gtPaper"), copies = current.root.querySelector("#gtCopies"), message = current.root.querySelector("#gtPrintMessage"), button = current.root.querySelector("#gtPrintButton"), help = current.root.querySelector(".gt-print-help"), pdfWarning = current.root.querySelector("#gtPdfWarning");
    const buttonLabel = `Print ${sample ? "layout" : "tag"}`;
    // A PDF size needs one deliberate second press on a bridge phone.
    let confirmedPdf = null;
    function liveProduct() { return sample ? Object.assign({}, SAMPLE_TAG) : productById(id); }
    function pdfWarningText(format) {
      return `This phone prints to a <strong>Bluetooth receipt printer</strong>. That printer cannot print a PDF, so “${esc(format.name)}” comes out as garbage characters. Use <strong>Thermal · 32 × 16 mm stock tags</strong> instead — or send this PDF to a real label printer.`;
    }
    function paint() {
      const format = FORMATS[paper.value];
      const stage = current.root.querySelector("#garmentTagPreview");
      button.textContent = buttonLabel;
      pdfWarning.hidden = !bridge || !!format.thermal;
      if (!pdfWarning.hidden) pdfWarning.innerHTML = pdfWarningText(format);
      if (format.thermal) {
        const product = liveProduct();
        const check = thermalFits(product);
        stage.style.removeProperty("--gt-tag-width");
        stage.style.removeProperty("--gt-tag-ratio");
        stage.innerHTML = check.fits && global.ThermalTags
          ? `<div class="tt-stage">${ThermalTags.preview(product, 2.8)}</div>`
          : `<p class="tt-empty">${esc(check.reason)}</p>`;
        button.disabled = !check.fits;
        message.classList.toggle("gt-error", !check.fits);
        message.textContent = check.fits
          ? `32 × 16 mm · Code 128 ${thermalCode(product)} · ${sample ? "layout example" : "10 tags per sheet, straight to the printer"}`
          : check.reason;
        help.innerHTML = "Sends straight to your <strong>Bluetooth thermal printer</strong> — no PDF, no print dialog. Cut along the grey lines.";
        return;
      }
      stage.style.setProperty("--gt-tag-width", Math.min(format.width * 4, 440) + "px");
      stage.style.setProperty("--gt-tag-ratio", format.width + " / " + format.height);
      stage.innerHTML = tagHTML(model);
      const fits = codeFits(model, format);
      button.disabled = !fits;
      message.classList.toggle("gt-error", !fits);
      message.textContent = fits ? `${format.name} · Code 128 · ${model.sample ? "layout example" : "saved garment code"}` : "This code is too long for a reliably scannable tag at this size. Choose a larger label or A4 wide tags.";
      help.innerHTML = bridge
        ? "This size is a <strong>PDF print job</strong> through Android's print dialog. On a Bluetooth receipt printer it prints as garbage — use the thermal stock-tag strip."
        : "Print at <strong>100% / Actual size</strong>, with browser headers and footers off. Attach the label to a hangtag, not directly to fabric. A4 tags include cut lines.";
    }
    paper.addEventListener("change", () => { confirmedPdf = null; try { localStorage.setItem(PAPER_KEY, paper.value); } catch (e) {} paint(); });
    button.addEventListener("click", async () => {
      if (!stockAllowed()) { current.close(); return; }
      const count = Number(copies.value);
      if (!Number.isInteger(count) || count < 1 || count > 100) { message.textContent = "Choose 1–100 whole copies."; message.classList.add("gt-error"); copies.focus(); return; }
      try {
        // Re-read the saved garment and storefront at print time; no draft data.
        if (!sample) model = tagModel(productById(id), false);
        paint();
        if (FORMATS[paper.value].thermal) { confirmedPdf = null; await printThermalTags(liveProduct(), count, message, button); return; }
        if (!codeFits(model, FORMATS[paper.value])) return;
        // Never hand a PDF to the ESC/POS printer by accident: the first press
        // explains the consequence, the second one opts in deliberately.
        if (bridge && confirmedPdf !== paper.value) {
          confirmedPdf = paper.value;
          button.textContent = "Print PDF anyway";
          pdfWarning.hidden = false;
          pdfWarning.innerHTML = pdfWarningText(FORMATS[paper.value]);
          message.textContent = "PDF job, not a thermal tag — press “Print PDF anyway” only to send it to a real label printer.";
          message.classList.add("gt-error");
          return;
        }
        confirmedPdf = null;
        button.textContent = buttonLabel;
        printTags(model, FORMATS[paper.value], count);
      } catch (error) { message.textContent = error.message; message.classList.add("gt-error"); }
    });
    paint();
  }
  /* Thermal stock tags: allocate the permanent code once, then send raster
     data to the Bluetooth bridge. Never a HTML/PDF print job. */
  async function printThermalTags(product, copies, message, button) {
    if (!product || !product.id) throw new Error("Save this garment before printing its tag.");
    button.disabled = true;
    message.classList.remove("gt-error");
    message.textContent = "Preparing the stock-tag sheet…";
    try {
      const codes = await DB.tagCodes([product.id]);
      const code = codes[product.id];
      if (!code) throw new Error("The server did not issue a stock-tag code for this piece. Refresh the catalog and try again.");
      const tagged = Object.assign({}, product, { tag_code: code });
      const result = await ThermalTags.print([tagged], { copies });
      message.textContent = `${result.tags} tag(s) sent to the printer — cut along the grey lines.`;
    } catch (error) {
      message.textContent = error.message;
      message.classList.add("gt-error");
      throw error;
    } finally { button.disabled = false; }
  }
  function notify(text) {
    const toast = doc.getElementById("toast");
    if (toast) { toast.textContent = text; toast.classList.add("show", "err"); setTimeout(() => toast.classList.remove("show"), 3500); }
  }
  doc.addEventListener("click", event => {
    const button = event.target.closest("[data-print-tag], [data-sample-tag]");
    if (button) openTag(button.dataset.printTag, button.hasAttribute("data-sample-tag"));
  });
  global.addEventListener("afterprint", cleanupPrint);
  global.addEventListener("pagehide", () => { if (tagDialog) tagDialog.close(); cleanupPrint(); });
  global.addEventListener("pos-access-change", () => { if (!stockAllowed()) { if (tagDialog) tagDialog.close(); cleanupPrint(); } });
  global.GarmentTools = { dialog, openTag, websiteLabel, thermalFits, thermalBridge, defaultPaper };
})(window);
