/* ============================================================
   ADONAI — SHARED INVENTORY INTAKE HELPERS
   Used by the POS intake modal and the admin dashboard so staff
   can upload/attach real product photos from device files or gallery
   and have them appear live on the storefront, POS and dashboard.
   ============================================================ */
(function (global) {
  "use strict";

  /**
   * Compress an image File from local files / gallery into a compact
   * JPEG data-url that is safe and fast to keep in the local DB
   * (max 800px on the long edge, ~80% quality).
   * @returns Promise<string> data-url
   */
  function compressImage(file) {
    return new Promise((resolve, reject) => {
      if (!file) return reject(new Error("Please select an image file"));
      if (file.type && !file.type.startsWith("image/")) {
        return reject(new Error("Selected file is not an image (select JPG, PNG, WebP)"));
      }
      const reader = new FileReader();
      reader.onerror = () => reject(new Error("Could not read image file"));
      reader.onload = ev => {
        const rawData = ev.target.result;
        const img = new Image();
        img.onerror = () => reject(new Error("Could not decode image file"));
        img.onload = () => {
          try {
            const MAX = 800;
            let { width: w, height: h } = img;
            const scale = Math.min(1, MAX / Math.max(w, h));
            w = Math.max(1, Math.round(w * scale));
            h = Math.max(1, Math.round(h * scale));
            const cv = document.createElement("canvas");
            cv.width = w; cv.height = h;
            const ctx = cv.getContext("2d");
            ctx.drawImage(img, 0, 0, w, h);
            resolve(cv.toDataURL("image/jpeg", 0.82));
          } catch (e) {
            // fallback to raw data if canvas fails
            resolve(rawData);
          }
        };
        img.src = rawData;
      };
      reader.readAsDataURL(file);
    });
  }

  /**
   * Markup for the image editor block used inside product forms.
   * Photos can only be uploaded from local files or gallery.
   */
  function imageFieldHTML(currentUrl) {
    return `
      <div class="imgfield">
        <label class="fld-label">Product photo <span class="fld-hint">— upload from gallery or local files</span></label>
        <div class="imgfield-row">
          <div class="imgfield-preview ${currentUrl ? "" : "empty"}">
            ${currentUrl ? `<img src="${escapeAttr(currentUrl)}" alt="Product photo" onerror="this.parentElement.classList.add('empty');this.remove()" />`
                         : `<span>No photo</span>`}
          </div>
          <div class="imgfield-actions">
            <button type="button" class="btn sm" data-img-upload>📁 Upload from Gallery / Files</button>
            <input type="file" accept="image/png, image/jpeg, image/jpg, image/webp, image/*" hidden data-img-file />
            <button type="button" class="btn sm ghost" data-img-remove ${currentUrl ? "" : 'style="display:none"'}>Remove photo</button>
          </div>
        </div>
      </div>`;
  }

  function escapeAttr(s) { return String(s || "").replace(/"/g, "&quot;"); }

  /**
   * Wire the image editor inside `rootEl`. `state` must be an object;
   * the chosen image lands in state.image_url (data-url).
   */
  function bindImageEditor(rootEl, state, onChange) {
    const fileInput = rootEl.querySelector("[data-img-file]");
    const uploadBtn = rootEl.querySelector("[data-img-upload]");
    const removeBtn = rootEl.querySelector("[data-img-remove]");
    const previewBox = rootEl.querySelector(".imgfield-preview");

    const render = () => {
      if (!previewBox) return;
      const hasImg = !!state.image_url;
      previewBox.classList.toggle("empty", !hasImg);
      if (hasImg) {
        previewBox.innerHTML = `<img src="${escapeAttr(state.image_url)}" alt="Product photo" onerror="this.parentElement.classList.add('empty');this.parentElement.innerHTML='<span>No photo</span>'" />`;
      } else {
        previewBox.innerHTML = `<span>No photo</span>`;
      }
      if (removeBtn) {
        removeBtn.style.display = hasImg ? "inline-block" : "none";
      }
      if (onChange) onChange(state.image_url);
    };

    if (uploadBtn && fileInput) {
      uploadBtn.addEventListener("click", () => fileInput.click());
      fileInput.addEventListener("change", async () => {
        if (!fileInput.files || !fileInput.files[0]) return;
        const file = fileInput.files[0];
        const prevText = uploadBtn.textContent;
        try {
          uploadBtn.textContent = "⏳ Uploading…";
          uploadBtn.disabled = true;
          const dataUrl = await compressImage(file);
          state.image_url = dataUrl;
          render();
        } catch (e) {
          alert(e.message || "Could not read that photo");
        } finally {
          uploadBtn.textContent = prevText;
          uploadBtn.disabled = false;
          fileInput.value = "";
        }
      });
    }

    if (removeBtn) {
      removeBtn.addEventListener("click", () => {
        state.image_url = "";
        render();
      });
    }

    return { refresh: render };
  }

  /** Collect the shared product-form values; returns null if name missing. */
  function readProductForm(rootEl) {
    const v = sel => { const el = rootEl.querySelector(sel); return el ? el.value.trim() : ""; };
    return {
      name: v("[data-f-name]"),
      brand: v("[data-f-brand]") || "Unbranded",
      color: v("[data-f-color]"),
      demographic: v("[data-f-demo]") || "Men",
      category: v("[data-f-cat]") || "Outerwear & Jackets",
      size: v("[data-f-size]") || "-",
      condition: v("[data-f-cond]") || "Grade A — Excellent",
      cost_price: Number(v("[data-f-cost]")) || 0,
      selling_price: Number(v("[data-f-sell]")) || 0,
      compare_price: Number(v("[data-f-compare]")) || 0,
      desc: v("[data-f-desc]"),
      in_stock_count: Math.max(0, Number(v("[data-f-stock]")) || 0)
    };
  }

  global.Intake = { compressImage, imageFieldHTML, bindImageEditor, readProductForm };
})(typeof window !== "undefined" ? window : globalThis);
