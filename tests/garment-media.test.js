"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");
const csstree = require("css-tree");
const source = file => fs.readFileSync(path.join(__dirname, "..", file), "utf8");
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setTimeout(resolve, 0)); };

function fixture(product = null, apiBase = "") {
  const dom = new JSDOM('<div id="gallery"></div>', { url: "https://store.example/admin.html", runScripts: "outside-only" });
  const win = dom.window, root = win.document.getElementById("gallery");
  const state = { uploads: [], deleted: [], revoked: [], duration: 22, pending: null, sequence: 0 };
  win.HTMLMediaElement.prototype.pause = () => {};
  win.HTMLMediaElement.prototype.load = () => {};
  Object.defineProperty(win.HTMLMediaElement.prototype, "src", {
    configurable: true,
    get() { return this.getAttribute("src") || ""; },
    set(value) {
      this.setAttribute("src", value);
      if (this.onloadedmetadata) { Object.defineProperty(this, "duration", { configurable: true, value: state.duration }); queueMicrotask(() => { if (this.onloadedmetadata) this.onloadedmetadata(); }); }
    }
  });
  win.URL.createObjectURL = () => "blob:preview-" + (++state.sequence);
  win.URL.revokeObjectURL = url => state.revoked.push(url);
  win.Intake = { compressImage: async () => "data:image/jpeg;base64,YWJj" };
  win.DB = {
    apiUrl: value => apiBase + value,
    async uploadMedia(file, kind, signal) {
      state.uploads.push({ file, kind, signal });
      if (state.pending) await state.pending;
      const id = state.uploads.length.toString(16).padStart(32, "0");
      return { id, url: "/api/media/" + id, name: file.name, bytes: 120000, duration: kind === "video" ? 22 : null };
    },
    mediaPreview: async () => new win.Blob(["optimized mp4"], { type: "video/mp4" }),
    discardMedia: async id => { state.deleted.push(id); }
  };
  win.eval(source("js/garment-media.js"));
  let previousSelection = null;
  const editor = win.GarmentMedia.mount(root, { product, onChange: (urls, previous) => { previousSelection = { urls, previous }; } });
  const select = (selector, files) => {
    const input = root.querySelector(selector);
    Object.defineProperty(input, "files", { configurable: true, value: files });
    input.dispatchEvent(new win.Event("change", { bubbles: true }));
  };
  return { win, root, state, editor, select, previous: () => previousSelection, close() { editor.dispose(); win.close(); } };
}

(async () => {
  const product = { image_url: "assets/cover.jpg", images: Array.from({length:12}, (_, i) => `assets/${i}.jpg`), video: { id: "e".repeat(32), url: "/api/media/" + "e".repeat(32), duration: 25, name: "garment.mp4", bytes: 500000 } };
  // Cover should be deduplicated, never truncate saved photos to four.
  product.image_url = product.images[0];
  const edit = fixture(product);
  try {
    assert.equal(edit.root.querySelectorAll(".gme-photo").length, 12);
    assert.equal(edit.editor.snapshot().images.length, 12);
    assert.equal(edit.editor.snapshot().video_id, product.video.id);
    assert.equal(edit.root.querySelector("[data-media-add-photos]").disabled, true);
    edit.root.querySelector('[data-media-cover="8"]').click();
    assert.equal(edit.editor.snapshot().image_url, "assets/8.jpg");
    assert.equal(edit.previous().previous[8], "assets/8.jpg");
    assert.equal(edit.previous().urls[0], "assets/8.jpg");
    edit.root.querySelector('[data-media-move="3"][data-direction="-1"]').click();
    edit.root.querySelector('[data-media-remove="4"]').click();
    assert.equal(edit.editor.snapshot().images.length, 11);
    assert.equal(edit.editor.snapshot().video_id, product.video.id);
    edit.editor.dispose();
    assert.equal(edit.state.deleted.length, 0, "closing an edit never deletes already saved media");
    console.log("✓ full 12-photo / video editing, cover and order controls, saved-media preservation");
  } finally { edit.win.close(); }

  // The packaged Android terminal resolves media against the web origin for
  // display, but the value it SAVES must stay host-independent: an absolute
  // URL is blocked by the storefront's `img-src 'self'` CSP as soon as the
  // page is served from the apex domain or a custom domain.
  const hosted = fixture({
    image_url: "/api/media/" + "a".repeat(32),
    images: ["/api/media/" + "a".repeat(32), "/api/media/" + "b".repeat(32)]
  }, "https://www.adonaithrift-store.online");
  try {
    assert.equal(
      hosted.root.querySelector(".gme-photo img").getAttribute("src"),
      "https://www.adonaithrift-store.online/api/media/" + "a".repeat(32),
      "the editor preview still loads from the app's API base"
    );
    const saved = hosted.editor.snapshot();
    assert.deepEqual(Array.from(saved.images), ["/api/media/" + "a".repeat(32), "/api/media/" + "b".repeat(32)]);
    assert.equal(saved.image_url, "/api/media/" + "a".repeat(32));
    console.log("✓ gallery saves host-independent media references even when the app renders absolute URLs");
  } finally { hosted.close(); }

  const upload = fixture();
  try {
    assert.equal(upload.root.querySelector("[data-media-photo-input]").multiple, true);
    const files = Array.from({length:7}, (_, i) => new upload.win.File(["phone image"], `photo-${i}.jpg`, { type: "image/jpeg" }));
    let resolve;
    upload.state.pending = new Promise(done => { resolve = done; });
    upload.select("[data-media-photo-input]", files);
    assert.equal(upload.editor.busy, true);
    assert.throws(() => upload.editor.snapshot(), /finish uploading/);
    assert.equal(upload.root.querySelector("[data-media-add-video]").disabled, true);
    upload.state.pending = null; resolve(); await settle();
    assert.equal(upload.editor.snapshot().images.length, 7);
    assert.equal(upload.state.uploads.length, 7);
    assert(upload.state.uploads.every(entry => entry.kind === "image" && entry.file.type === "image/jpeg"));
    assert(upload.editor.snapshot().images.every(url => url.startsWith("/api/media/")), "only references, never image data URLs, are saved");
    upload.select("[data-media-video-input]", [new upload.win.File(["phone clip"], "turnaround.MOV", {type:"video/quicktime"})]);
    await settle();
    assert.equal(upload.editor.snapshot().video_id.length, 32);
    const preview = upload.root.querySelector("video");
    assert(preview.controls && preview.playsInline);
    assert.equal(preview.preload, "none"); assert.equal(preview.autoplay, false);
    assert.match(preview.getAttribute("src"), /^blob:/);
    upload.editor.markSaved(); upload.editor.reset();
    assert.equal(upload.editor.snapshot().images.length, 0); assert.equal(upload.editor.snapshot().video_id, "");
    assert.equal(upload.state.deleted.length, 0, "Save & Add Another never deletes media from the saved garment");
    assert(upload.state.revoked.length >= 2, "temporary preview blobs are released");
    console.log("✓ phone multi-selection beyond four, async save guards, optimized-video preview and clean next-item reset");
  } finally { upload.close(); }

  const limits = fixture();
  try {
    limits.select("[data-media-photo-input]", Array.from({length:13}, () => new limits.win.File(["x"], "photo.jpg", {type:"image/jpeg"})));
    await settle(); assert.equal(limits.state.uploads.length, 0);
    assert.throws(() => limits.editor.snapshot(), /file did not upload/);
    limits.root.querySelector("[data-media-dismiss]").click();
    limits.state.duration = 32;
    limits.select("[data-media-video-input]", [new limits.win.File(["clip"], "too-long.mp4", {type:"video/mp4"})]);
    await settle(); assert.equal(limits.state.uploads.length, 0);
    assert.match(limits.root.querySelector("[data-media-error-text]").textContent, /longer than 30 seconds/);
    limits.root.querySelector("[data-media-dismiss]").click();
    assert.equal(limits.editor.snapshot().video_id, "", "video stays optional for legacy / simple garments");
    assert.equal(limits.editor.snapshot().images.length, 0, "no rigid minimum-four save constraint");
    console.log("✓ explicit over-limit / failed-upload handling without silent media loss or mandatory video");
  } finally { limits.close(); }

  const discard = fixture();
  try {
    discard.select("[data-media-photo-input]", [new discard.win.File(["x"], "draft.jpg", {type:"image/jpeg"})]);
    await settle(); discard.root.querySelector("[data-media-remove='0']").click(); await settle();
    assert.equal(discard.state.deleted.length, 1, "only an unpublished upload is discarded directly");
  } finally { discard.close(); }

  for (const file of ["css/garment-media.css", "css/product.css", "css/storefront.css"]) {
    csstree.parse(source(file), { positions:true, onParseError:error => { throw error; } });
  }
  const app = source("app.js");
  assert.doesNotMatch(app, /slice\(0, 4\)|Upload all 4 product views|modalImageState/);
  assert.match(app, /syncFlawPhotoOptions/);
  const pdp = source("js/product.js");
  assert.match(pdp, /data-video-src/); assert.match(pdp, /controls playsinline preload="none"/);
  assert.match(pdp, /activePhoto < photos.length/); assert.match(pdp, /lastMediaSignature/);
  assert.match(source("android/app/src/main/java/com/adonaithrift/pos/MainActivity.java"), /Intent.EXTRA_ALLOW_MULTIPLE/);
  console.log("✓ valid responsive CSS, dynamic flaw-photo support, photo-only zoom and native multi-file chooser");
})().catch(error => { console.error(error); process.exitCode = 1; });
