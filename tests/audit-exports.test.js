"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {JSDOM} = require("jsdom");
const csstree = require("css-tree");
const source = file => fs.readFileSync(path.join(__dirname, "..", file), "utf8");
const settle = async () => { for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve)); };

function basic(html = "<body></body>") {
  const dom = new JSDOM(html, {url:"https://store.example/admin.html?view=customers", runScripts:"outside-only", pretendToBeVisual:true});
  const win = dom.window, state = {clicked:[], areas:[], requests:[], downloads:[], prints:0, pending:null, denied:false, fail:null};
  win.Blob = global.Blob;
  win.HTMLAnchorElement.prototype.click = function () { state.clicked.push({url:this.href, name:this.download}); };
  win.eval(source("js/file-downloads.js")); win.eval(source("js/audit-exports.js"));
  return {win, doc:win.document, state, close:() => win.close()};
}
function appFixture() {
  const f = basic(source("admin.html")), {win, state} = f;
  state.now = Date.parse("2026-10-11T12:00:00Z");
  const OriginalDate = win.Date;
  win.Date = class extends OriginalDate {
    constructor(...args) { super(...(args.length ? args : [state.now])); }
    static now() { return state.now; }
  };
  state.refreshes = 0; state.refreshOK = true;
  win.Auth = {ready:async () => {}, guard:() => ({id:"TEST", name:"Test cashier", role:"cashier"}), locked:() => false, openAccess:() => true, suiteUnlocked:() => true, token:() => "", me:() => null, authHeaders:() => ({})};
  win.Icons = {svg:() => '<svg aria-hidden="true"></svg>', icon:() => ""};
  win.Intake = {compressImage:async () => "", imageFieldHTML:() => ""};
  const sales = [
    {id:"START", channel:"pos", status:"completed", payment:{status:"unpaid"}, total:43000, customer_name:"Sarah", created_at:"2026-10-09T21:00:00", tender:{type:"cash"}},
    {id:"END", channel:"web", status:"unfulfilled", payment:{status:"paid", paid_at:"2026-10-10T20:59:59"}, total:30000, customer_name:"Peter", created_at:"2026-10-08T12:00:00"},
    {id:"NEXT", channel:"pos", status:"completed", payment:{status:"paid"}, total:10000, created_at:"2026-10-10T21:00:00"},
    {id:"UNPAID", channel:"web", status:"unfulfilled", payment:{status:"unpaid"}, total:90000, created_at:"2026-10-10T12:00:00"},
    {id:"CANCEL", channel:"pos", status:"cancelled", payment:{status:"paid"}, total:90000, created_at:"2026-10-10T12:00:00"}
  ];
  win.DB = {
    DEMOGRAPHICS:["Men","Women"], CATEGORIES:["Dresses"], CONDITIONS:["Grade A"], ROLE_LABELS:{},
    listProducts:() => [], listSales:() => sales, listStaff:() => [], listGuests:() => [], listRiders:() => [], listLedger:() => [], on:() => {},
    getSettings:() => ({store_name:"Adonai Store", base_delivery_fee:7000}), barcodeSVG:() => "<svg></svg>", ugx:value => "UGX " + Number(value).toLocaleString("en-US"), financeRequest:async () => ({stock_lots:[]}),
    operationalSyncStatus:() => ({online:state.refreshOK, last_synced_at:"2026-10-11T12:00:00Z"}),
    refreshOperationalData:async () => { state.refreshes++; return state.refreshOK; },
    prepareExport:async (options, signal) => {
      state.requests.push({options:{...options}, signal});
      if (state.pending) await state.pending;
      if (state.fail) throw new Error(state.fail);
      return {url:"/api/exports/download/" + "T".repeat(43), filename:`adonai-${options.kind}.${options.format}`, type:options.format === "csv" ? "text/csv; charset=utf-8" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", bytes:200, records:2, kind:options.kind};
    }
  };
  win.PosAccess = {ready:async () => {}, areaInfo:() => ({label:"Orders & audit"}), areaForView:view => view === "customers" ? "orders" : null, canUse:() => !state.denied,
    ensure:async area => { state.areas.push(area); return !state.denied; }, getPolicy:() => ({protected_areas:[]})};
  win.print = () => { state.prints++; };
  win.eval(source("js/garment-media.js")); win.eval(source("js/garment-tools.js")); win.eval(source("js/receipt-printing.js")); win.eval(source("app.js"));
  f.change = (id, value) => { const node = f.doc.getElementById(id); node.value = value; node.dispatchEvent(new win.Event(id === "auditSearch" ? "input" : "change", {bubbles:true})); };
  return f;
}

(async () => {
  const f = basic();
  try {
    const audit = f.win.AuditExports;
    assert.equal(audit.kampalaDay(new Date("2026-10-10T21:01:00Z")), "2026-10-11");
    assert.deepEqual({...audit.preset("yesterday", new Date("2026-10-10T21:01:00Z"))}, {from:"2026-10-10", to:"2026-10-10"});
    assert.deepEqual({...audit.preset("7", new Date("2026-10-10T21:01:00Z"))}, {from:"2026-10-05", to:"2026-10-11"});
    assert.equal(audit.within("2026-10-09T21:00:00", audit.range("2026-10-10", "2026-10-10")), true);
    assert.equal(audit.within("2026-10-10T21:00:00", audit.range("2026-10-10", "2026-10-10")), false);
    assert.throws(() => audit.range("2026-10-11", "2026-10-10"), /on or before/);
    assert.throws(() => audit.range("2026-02-30", ""), /valid/);
    const values = ["=1+1", "+256700111222", " \t@SUM(1)", "\r-1+2"];
    values.forEach(value => assert(f.win.FileDownloads.csvCell(value).includes("'")));
    assert.equal(f.win.FileDownloads.csvCell(-5000), "-5000");
    assert.equal(f.win.FileDownloads.csvCell('Sarah, "Kampala"\r\n'), '"Sarah, ""Kampala""\r\n"');
    await f.win.FileDownloads.download({url:"/api/exports/download/" + "A".repeat(43), filename:"sales.csv"});
    assert.equal(f.state.clicked[0].name, "sales.csv"); assert.match(f.state.clicked[0].url, /https:\/\/store.example\/api\/exports\/download\//);
    assert(!f.state.clicked[0].url.startsWith("blob:"));
    f.win.Android = {openExternal:url => f.state.downloads.push(url)};
    assert.equal((await f.win.FileDownloads.download({url:"/api/exports/download/" + "B".repeat(43), filename:"sales.csv"})).mode, "external");
    assert.match(f.state.downloads[0], /^https:\/\/store.example\/api\/exports\/download\//);
    console.log("✓ inclusive Kampala date presets, CSV formula / RFC quoting, real HTTP browser download and older-APK fallback");
  } finally { f.close(); }

  const native = basic();
  try {
    const bytes = Buffer.alloc(1024 * 1024 + 25); for (let index = 0; index < bytes.length; index++) bytes[index] = index % 251;
    const chunks = []; let started = null, finished = false, cancelled = false;
    native.win.Android = {
      beginFileExport:(name, mime, length) => { started = {name,mime,length}; return "NATIVE-1"; },
      appendFileExport:(id, encoded) => { assert.equal(id, "NATIVE-1"); assert(encoded.length < 180000); chunks.push(Buffer.from(encoded, "base64")); return true; },
      finishFileExport:() => { finished = true; return true; }, cancelFileExport:() => { cancelled = true; }
    };
    const result = await native.win.FileDownloads.save(new Blob([bytes], {type:"text/csv; charset=utf-8"}), "fixture.csv", "text/csv; charset=utf-8");
    assert.equal(result.mode, "native"); assert(finished); assert.equal(started.length, bytes.length); assert.equal(started.mime, "text/csv"); assert(Buffer.concat(chunks).equals(bytes));
    native.win.Android.appendFileExport = () => false;
    await assert.rejects(native.win.FileDownloads.save(new Blob(["test"]), "fixture.csv", "text/csv"), /copied/);
    assert(cancelled);
    native.win.fetch = async () => ({ok:false, json:async () => ({error:"This download has expired. Export again."})});
    await assert.rejects(native.win.FileDownloads.download({url:"/api/exports/download/X", filename:"x.csv", type:"text/csv", bytes:10}), /expired/);
    let read; const signal = new native.win.AbortController();
    native.win.fetch = async () => ({ok:true, blob:async () => ({size:4, arrayBuffer:() => new Promise(resolve => { read = resolve; })})});
    let began = false; native.win.Android.beginFileExport = () => { began = true; return "SHOULD-NOT-START"; };
    const waiting = native.win.FileDownloads.download({url:"/api/exports/download/X", filename:"x.csv", type:"text/csv", bytes:4}, signal.signal);
    const rejected = assert.rejects(waiting, /cancelled/);
    await settle(); signal.abort(); read(new Uint8Array(4).buffer); await rejected;
    assert.equal(began, false, "relocking during buffer reading never opens native Save As");
    console.log("✓ native byte-exact chunked file transfer, MIME/length preservation, failure cleanup and expired-ticket handling");
  } finally { native.close(); }

  const ui = appFixture();
  try {
    await settle(); assert(ui.doc.querySelector("#view-customers.active"));
    assert.equal(ui.doc.querySelector("#auditDatePreset").value, "today");
    assert.equal(ui.doc.querySelector("#auditDateFrom").value, "2026-10-11");
    assert.equal(ui.doc.querySelectorAll(".audit-card").length, 1, "Today, not all stored days, is the initial receipt tray");
    assert.match(ui.doc.querySelector("#auditDayTitle").textContent, /Today's receipts/);
    ui.change("auditDateFrom", "2026-10-10"); ui.change("auditDateTo", "2026-10-10");
    assert.equal(ui.doc.querySelectorAll(".audit-card").length, 2);
    assert.match(ui.doc.querySelector("#auditSummary").textContent, /73,000/);
    ui.change("auditSearch", "2026-10-10"); assert.equal(ui.doc.querySelectorAll(".audit-card").length, 2);
    ui.change("auditSearch", "");
    ui.doc.querySelector("#btnPrintAudit").click(); assert.equal(ui.state.prints, 1);
    assert.match(ui.doc.querySelector("#receiptSheet").textContent, /START/); assert.doesNotMatch(ui.doc.querySelector("#receiptSheet").textContent, /NEXT|UNPAID|CANCEL/);
    assert.match(ui.doc.querySelector("#receiptPrintStyle").textContent, /size:A4/);
    ui.win.dispatchEvent(new ui.win.Event("afterprint"));
    ui.doc.querySelector("#btnExportAudit").click(); await settle();
    assert.deepEqual(ui.state.requests[0].options, {kind:"sales", format:"csv", from:"2026-10-10", to:"2026-10-10", q:""});
    assert.equal(ui.state.clicked[0].name, "adonai-sales.csv"); assert.equal(ui.doc.querySelector("#auditDownloadFallback").hidden, false);
    assert.match(ui.doc.querySelector("#auditDownloadMessage").textContent, /Download requested/); assert.doesNotMatch(ui.doc.querySelector("#auditDownloadMessage").textContent, /File saved|downloaded successfully/i);
    ui.change("auditReport", "ledger"); assert.equal(ui.doc.querySelector("#auditDownloadFallback").hasAttribute("href"), false);
    ui.doc.querySelector("#btnExportAuditExcel").click(); await settle();
    assert.equal(ui.state.requests[1].options.kind, "ledger"); assert.equal(ui.state.requests[1].options.format, "xlsx"); assert(ui.state.areas.includes("finance"));
    assert.equal(ui.state.clicked[1].name, "adonai-ledger.xlsx");
    ui.change("auditSearch", "REFUND"); ui.doc.querySelector("#btnExportAudit").click(); await settle(); assert.equal(ui.state.requests[2].options.q, "refund");
    ui.change("auditDateFrom", "2026-10-11"); ui.doc.querySelector("#btnExportAudit").click(); await settle();
    assert.equal(ui.state.requests.length, 3); assert.match(ui.doc.querySelector("#auditDownloadMessage").textContent, /on or before/);
    ui.change("auditDatePreset", "all"); assert.equal(ui.doc.querySelector("#auditDateFrom").value, "");
    console.log("✓ real CSV / Excel buttons, date/search/print parity, paid POS legacy receipts, correct report scopes and honest download status");
  } finally { ui.close(); }

  const daily = appFixture();
  try {
    await settle();
    const savedCount = daily.win.DB.listSales().length;
    const invoice = daily.doc.querySelector('[data-print-sale="NEXT"]');
    assert.equal(invoice.tagName, "BUTTON"); invoice.click();
    assert.equal(daily.state.prints, 1, "one tap opens print, not a second-click modal");
    assert.equal(daily.doc.querySelector("#modalBackdrop").classList.contains("open"), false);
    assert.match(daily.doc.querySelector("#receiptSheet").textContent, /NEXT/);
    assert.doesNotMatch(daily.doc.querySelector("#receiptSheet").textContent, /START|END|UNPAID/);
    assert.match(daily.doc.querySelector("#auditPrintStatus").textContent, /Print dialog requested/);
    daily.win.dispatchEvent(new daily.win.Event("afterprint"));
    assert.equal(daily.doc.querySelector("#receiptSheet").textContent, "");
    assert.equal(daily.doc.body.classList.contains("rp-printing"), false);
    daily.change("auditReceiptDay", "2026-10-10");
    assert.equal(daily.doc.querySelector("#auditDatePreset").value, "custom");
    assert.equal(daily.doc.querySelector("#auditDateTo").value, "2026-10-10");
    assert.equal(daily.doc.querySelectorAll(".audit-card").length, 2, "the inline day picker opens past-day invoices immediately");
    daily.doc.querySelector("#btnAuditYesterday").click();
    assert.equal(daily.doc.querySelectorAll(".audit-card").length, 2);
    daily.doc.querySelector("#btnPrintDayReceipts").click();
    assert.equal(daily.state.prints, 2); assert.equal(daily.doc.querySelectorAll("#receiptSheet .rp-invoice").length, 2);
    assert.match(daily.doc.querySelector("#receiptPrintStyle").textContent, /break-after:page/);
    daily.win.dispatchEvent(new daily.win.Event("afterprint"));
    daily.doc.querySelector("#btnRefreshAudit").click(); await settle();
    assert.equal(daily.state.refreshes, 1); assert.equal(daily.doc.querySelector("#auditDateFrom").value, "2026-10-10", "refresh retains a chosen history day");
    daily.state.refreshOK = false; daily.doc.querySelector("#btnRefreshAudit").click(); await settle();
    assert.match(daily.doc.querySelector("#auditSyncState").textContent, /Could not refresh/);
    assert.equal(daily.doc.querySelectorAll(".audit-card").length, 2, "failed refresh never erases old receipts");
    daily.doc.querySelector("#btnAuditToday").click();
    daily.state.now = Date.parse("2026-10-11T21:00:01Z"); // October 12 in Kampala
    daily.win.dispatchEvent(new daily.win.Event("focus"));
    assert.equal(daily.doc.querySelector("#auditDateFrom").value, "2026-10-12");
    assert.equal(daily.doc.querySelectorAll(".audit-card").length, 0, "yesterday's invoices disappear only from today's tray");
    assert.equal(daily.doc.querySelector("#btnPrintDayReceipts").disabled, true);
    assert.equal(daily.win.DB.listSales().length, savedCount, "midnight does not delete or repost saved records");
    daily.doc.querySelector("#btnAuditYesterday").click();
    assert.equal(daily.doc.querySelectorAll(".audit-card").length, 1, "old day's invoice remains reprintable");
    daily.change("auditDateFrom", "2026-10-10"); daily.change("auditDateTo", "2026-10-10");
    daily.state.now = Date.parse("2026-10-12T21:00:01Z"); daily.win.renderAll();
    assert.equal(daily.doc.querySelector("#auditDateFrom").value, "2026-10-10", "an explicit past-day selection never jumps forward at midnight");
    console.log("✓ today-first receipts, one-tap print, daily invoice batch, refresh/history retention and midnight rollover without deletion");
  } finally { daily.close(); }

  const late = appFixture();
  try {
    await settle(); let release; late.state.pending = new Promise(resolve => { release = resolve; });
    late.doc.querySelector("#btnExportAudit").click(); late.doc.querySelector("#btnExportAudit").click(); await settle();
    assert.equal(late.state.requests.length, 1); assert.equal(late.doc.querySelector("#btnExportAudit").disabled, true);
    late.state.denied = true; late.win.dispatchEvent(new late.win.CustomEvent("pos-access-change")); release(); await settle();
    assert.equal(late.state.requests[0].signal.aborted, true); assert.equal(late.state.clicked.length, 0);
    assert.equal(late.doc.querySelector("#auditDownloadFallback").hasAttribute("href"), false);
    assert.match(late.doc.querySelector("#auditDownloadMessage").textContent, /locked/);
    late.state.denied = false; late.state.pending = null; late.state.fail = "Connection lost. Try again.";
    late.doc.querySelector("#btnExportAudit").click(); await settle(); assert.match(late.doc.querySelector("#auditDownloadMessage").textContent, /Connection lost/);
    assert.equal(late.doc.querySelector("#btnExportAudit").disabled, false);
    console.log("✓ double-tap guard, re-lock cancellation / late-response privacy and recoverable download errors");
  } finally { late.close(); }

  const saved = appFixture();
  try {
    await settle(); saved.win.Android = {beginFileExport:() => "ID-SAVE", appendFileExport:() => true, finishFileExport:() => true, cancelFileExport:() => {}};
    saved.win.fetch = async () => ({ok:true, blob:async () => new Blob([Buffer.alloc(200)], {type:"text/csv"})});
    saved.doc.querySelector("#btnExportAudit").click(); await settle();
    assert.equal(saved.doc.querySelector("#btnExportAudit").disabled, true); assert.match(saved.doc.querySelector("#auditDownloadMessage").textContent, /Choose a folder/);
    saved.win.__adonaiFileExportResult("ID-SAVE", "cancelled", "Save cancelled — tap Download again.");
    assert.equal(saved.doc.querySelector("#btnExportAudit").disabled, false); assert.match(saved.doc.querySelector("#auditDownloadMessage").textContent, /cancelled/);
    saved.doc.querySelector("#auditDownloadFallback").dispatchEvent(new saved.win.MouseEvent("click", {bubbles:true, cancelable:true})); await settle();
    saved.win.__adonaiFileExportResult("ID-SAVE", "saved", "Saved adonai-sales.csv. Open it from the folder you chose.");
    assert.match(saved.doc.querySelector("#auditDownloadMessage").textContent, /Saved adonai-sales.csv/);
    console.log("✓ Android Save As / cancel / retry / saved callbacks, without premature save claims");
  } finally { saved.close(); }

  const android = source("android/app/src/main/java/com/adonaithrift/pos/MainActivity.java");
  assert.match(android, /Intent.ACTION_CREATE_DOCUMENT/); assert.match(android, /getContentResolver\(\).openOutputStream/);
  assert.match(android, /MAX_EXPORT_BYTES = 32L/); assert.match(android, /expectedBytes > MAX_EXPORT_BYTES/);
  assert.match(android, /item.written != item.expected/); assert.match(android, /!trustedAppPage/);
  assert.doesNotMatch(source("android/app/src/main/AndroidManifest.xml"), /WRITE_EXTERNAL_STORAGE|MANAGE_EXTERNAL_STORAGE/);
  assert(source("admin.html").indexOf("js/file-downloads.js") < source("admin.html").indexOf("app.js?v="));
  csstree.parse(source("styles.css"), {onParseError(error) { throw error; }});
  console.log("✓ responsive export UI / stylesheet, trusted bounded native Save As and no blanket phone-storage permissions");
})().catch(error => { console.error(error); process.exitCode = 1; });
