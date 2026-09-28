/* ============================================================
   ADONAI — SHARED INVENTORY INTAKE HELPERS
   Used by the POS intake modal and the admin dashboard so staff
   can photograph/attach a real product image and have it appear
   live on the storefront, POS and dashboard simultaneously.
   ============================================================ */
(function (global) {
  "use strict";

  /**
   * Compress an image File into a compact JPEG data-url that is safe
   * to keep in the local DB (max 900px on the long edge, ~80% quality).
   * @returns Promise<string> data-url
   */
  function compressImage(file) {
    return new Promise((resolve, reject) => {
      if (!file || !/^image\//.test(file.type)) return reject(new Error("Please choose an image file"));
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        try {
          const MAX = 900;
          let { width: w, height: h } = img;
          const scale = Math.min(1, MAX / Math.max(w, h));
          w = Math.max(1, Math.round(w * scale));
          h = Math.max(1, Math.round(h * scale));
          const cv = document.createElement("canvas");
          cv.width = w; cv.height = h;
          cv.getContext("2d").drawImage(img, 0, 0, w, h);
          URL.revokeObjectURL(url);
          resolve(cv.toDataURL("image/jpeg", 0.82));
        } catch (e) { reject(e); }
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Could not read that image")); };
      img.src = url;
    });
  }

  /**
   * Markup for the image editor block used inside product forms.
   * Scoped by class names so it can live in any modal root.
   */
  function imageFieldHTML(currentUrl) {
    return `
      <div class="imgfield">
        <label class="fld-label">Product photo <span class="fld-hint">— replace the web image with the real piece</span></label>
        <div class="imgfield-row">
          <div class="imgfield-preview ${currentUrl ? "" : "empty"}">
            ${currentUrl ? `<img src="${escapeAttr(currentUrl)}" alt="" onerror="this.parentElement.classList.add('empty');this.remove()" />`
                         : `<span>No photo</span>`}
          </div>
          <div class="imgfield-actions">
            <button type="button" class="btn sm" data-img-upload>📷 Upload photo</button>
            <input type="file" accept="image/*" capture="environment" hidden data-img-file />
            <button type="button" class="btn sm ghost" data-img-url>Paste URL</button>
            <button type="button" class="btn sm ghost" data-img-remove>Remove</button>
          </div>
        </div>
      </div>`;
  }

  function escapeAttr(s) { return String(s).replace(/"/g, "&quot;"); }

  /**
   * Wire the image editor inside `rootEl`. `state` must be an object;
   * the chosen image lands in state.image_url (data-url or http URL).
   */
  function bindImageEditor(rootEl, state, onChange) {
    const fileInput = rootEl.querySelector("[data-img-file]");
    const render = () => {
      const box = rootEl.querySelector(".imgfield-preview");
      box.classList.toggle("empty", !state.image_url);
      box.innerHTML = state.image_url
        ? `<img src="${escapeAttr(state.image_url)}" alt="" onerror="this.parentElement.classList.add('empty');this.parentElement.innerHTML='<span>No photo</span>'" />`
        : `<span>No photo</span>`;
      if (onChange) onChange(state.image_url);
    };
    rootEl.querySelector("[data-img-upload]").addEventListener("click", () => fileInput.click());
    fileInput.addEventListener("change", async () => {
      if (!fileInput.files[0]) return;
      try { state.image_url = await compressImage(fileInput.files[0]); }
      catch (e) { alert(e.message); }
      fileInput.value = "";
      render();
    });
    rootEl.querySelector("[data-img-url]").addEventListener("click", () => {
      const url = prompt("Paste an image URL (https://…):", state.image_url && !state.image_url.startsWith("data:") ? state.image_url : "");
      if (url !== null) { state.image_url = url.trim(); render(); }
    });
    rootEl.querySelector("[data-img-remove]").addEventListener("click", () => { state.image_url = ""; render(); });
    return { refresh: render };
  }

  /** Collect the shared product-form values; returns null if name missing. */
  function readProductForm(rootEl) {
    const v = sel => { const el = rootEl.querySelector(sel); return el ? el.value.trim() : ""; };
    return {
      name: v("[data-f-name]"),
      brand: v("[data-f-brand]") || "Unbranded",
      color: v("[data-f-color]"),
      demographic: v("[data-f-demo]") || "General",
      category: v("[data-f-cat]") || "Accessories",
      size: v("[data-f-size]") || "-",
      condition: v("[data-f-cond]") || "Good",
      cost_price: Number(v("[data-f-cost]")) || 0,
      selling_price: Number(v("[data-f-sell]")) || 0,
      compare_price: Number(v("[data-f-compare]")) || 0,
      desc: v("[data-f-desc]"),
      in_stock_count: Math.max(0, Number(v("[data-f-stock]")) || 0)
    };
  }

  global.Intake = { compressImage, imageFieldHTML, bindImageEditor, readProductForm };
})(window);
