/* Flexible phone gallery shared by Catalog Intake and inventory editing.
   Draft previews stay in memory. Only small, durable media URLs reach DB.js. */
(function (global) {
  "use strict";
  const MAX_PHOTOS = 12, MAX_SECONDS = 30, MAX_VIDEO_BYTES = 50 * 1024 * 1024;
  const esc = value => String(value == null ? "" : value).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const icon = (kind) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${kind === "video" ? '<rect x="3" y="6" width="12" height="12" rx="3"/><path d="m15 10 6-3v10l-6-3"/>' : '<rect x="3" y="5" width="18" height="15" rx="3"/><circle cx="8.5" cy="10" r="1.5"/><path d="m3 17 5-4 4 3 4-6 5 7"/>'}</svg>`;
  const durationLabel = seconds => `0:${String(Math.round(Number(seconds) || 0)).padStart(2, "0")}`;
  const urlFor = url => /^\/api\/media\//.test(String(url || "")) ? DB.apiUrl(url) : url;

  function photosFor(product) {
    const list = [product && product.image_url].concat(product && Array.isArray(product.images) ? product.images : []);
    return list.filter((url, index) => url && typeof url === "string" && list.indexOf(url) === index).map(urlFor);
  }

  function photoBlob(dataUrl, name) {
    const data = atob(dataUrl.split(",")[1] || "");
    const bytes = Uint8Array.from(data, character => character.charCodeAt(0));
    return new File([bytes], (name || "garment").replace(/\.[^.]+$/, "") + ".jpg", { type: "image/jpeg" });
  }

  // A phone may not decode HEVC locally; the server can convert it to H.264.
  // Local metadata is an early duration check, never the only validation.
  function readVideoDuration(file) {
    return new Promise(resolve => {
      const element = document.createElement("video"), url = URL.createObjectURL(file);
      let finished = false;
      const finish = duration => {
        if (finished) return; finished = true;
        clearTimeout(timer); element.onloadedmetadata = element.onerror = null;
        element.removeAttribute("src"); element.load(); URL.revokeObjectURL(url);
        resolve(Number.isFinite(duration) && duration > 0 ? duration : null);
      };
      const timer = setTimeout(() => finish(null), 8000);
      element.preload = "metadata"; element.onloadedmetadata = () => finish(element.duration);
      element.onerror = () => finish(null); element.src = url;
    });
  }

  function mount(root, options = {}) {
    if (!root) throw new Error("Gallery container is missing");
    let photos = [], video = null, busy = false, locked = false, disposed = false, failure = "";
    let controller = null;
    root.classList.add("gme");
    root.innerHTML = `
      <div class="gme-photo-panel">
        <div class="gme-heading"><div><span class="gme-eyebrow">YOUR GARMENT, EVERY DETAIL</span><h4>Build its photo gallery</h4></div><span class="gme-count" data-media-count>0 / 12</span></div>
        <p class="gme-intro">Choose several photos at once from your phone. Add only the views this piece needs.</p>
        <div class="gme-photo-grid" data-media-photos></div>
        <div class="gme-upload-row"><button class="btn primary" type="button" data-media-add-photos>${icon("photo")} Add photos</button><span>Up to 12 photos · first photo is the cover</span></div>
        <input type="file" accept="image/*" multiple hidden data-media-photo-input aria-label="Choose multiple garment photos" />
      </div>
      <div class="gme-video-panel">
        <div class="gme-heading"><div class="gme-video-title"><span class="gme-video-icon">${icon("video")}</span><div><h4>See it in motion</h4><p>A short garment video <span class="gme-optional">Optional</span></p></div></div><span class="gme-duration-pill">Up to 30 sec</span></div>
        <div data-media-video></div>
        <p class="gme-video-tip">Show the front, back, fabric and how it moves. Aim for 20–30 seconds in good light.</p>
        <div class="gme-upload-row"><button class="btn" type="button" data-media-add-video>${icon("video")} Add garment video</button><span>1 video · MP4 or MOV · max 50 MB</span></div>
        <input type="file" accept="video/mp4,video/quicktime,.mp4,.mov" hidden data-media-video-input aria-label="Choose a short garment video" />
      </div>
      <div class="gme-progress" data-media-progress role="status" aria-live="polite" hidden></div>
      <div class="gme-error" data-media-error role="alert" hidden><span data-media-error-text></span><button type="button" data-media-dismiss>Dismiss failed upload</button></div>
      <p class="gme-save-note">Photos and video join the customer gallery when you save the garment.</p>`;
    const $ = selector => root.querySelector(selector);
    const previousVideo = () => $("video[data-media-preview]");
    const release = entry => {
      if (!entry) return;
      if (entry.preview && entry.preview.startsWith("blob:")) URL.revokeObjectURL(entry.preview);
      if (entry.draft && entry.id) DB.discardMedia(entry.id).catch(() => {});
    };
    const notify = previous => {
      if (typeof options.onChange === "function") options.onChange(photos.map(photo => photo.url), previous || [], video);
    };
    const renderPhotos = () => {
      $("[data-media-count]").textContent = `${photos.length} / ${MAX_PHOTOS}`;
      $("[data-media-photos]").innerHTML = photos.length ? photos.map((photo, index) => `
        <div class="gme-photo ${index === 0 ? "is-cover" : ""}">
          <div class="gme-photo-image"><img src="${esc(photo.preview || photo.url)}" alt="Garment photo ${index + 1}" /><span class="gme-photo-number">${index === 0 ? "Cover" : `Photo ${index + 1}`}</span></div>
          <div class="gme-photo-actions">${index > 0 ? `<button type="button" data-media-cover="${index}" title="Use photo ${index + 1} as the catalog cover">Set cover</button>` : '<span>Catalog cover</span>'}<button type="button" data-media-remove="${index}" aria-label="Remove photo ${index + 1}">Remove</button></div>
          <div class="gme-photo-order"><button type="button" data-media-move="${index}" data-direction="-1" aria-label="Move photo ${index + 1} earlier" ${index === 0 ? "disabled" : ""}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="m14 6-6 6 6 6M8 12h12"/></svg></button><span>${index + 1} of ${photos.length}</span><button type="button" data-media-move="${index}" data-direction="1" aria-label="Move photo ${index + 1} later" ${index === photos.length - 1 ? "disabled" : ""}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="m10 6 6 6-6 6M4 12h12"/></svg></button></div>
        </div>`).join("") : `<div class="gme-empty">${icon("photo")}<strong>Show every detail</strong><p>Front &amp; back · fabric · label · any close-ups</p><span>Start with a clear cover photo, then add more.</span></div>`;
      renderControls();
      const preview = previousVideo();
      if (preview) { if (photos[0]) preview.poster = photos[0].preview || photos[0].url; else preview.removeAttribute("poster"); }
    };
    const renderVideo = () => {
      const old = previousVideo(); if (old) old.pause();
      $("[data-media-video]").innerHTML = video ? `
        <div class="gme-video-preview"><video data-media-preview controls playsinline preload="none" ${photos[0] ? `poster="${esc(photos[0].preview || photos[0].url)}"` : ""} src="${esc(video.preview || urlFor(video.url))}" aria-label="Preview garment video"></video><div class="gme-video-meta"><div><strong>Garment video ready</strong><span>${esc(video.name || "garment.mp4")} · ${durationLabel(video.duration)} · ${(Number(video.bytes) / 1024 / 1024).toFixed(1)} MB</span></div><button type="button" data-media-remove-video>Remove</button></div></div>` : "";
      $("[data-media-add-video]").innerHTML = `${icon("video")} ${video ? "Replace video" : "Add garment video"}`;
      renderControls();
    };
    function renderControls() {
      root.querySelectorAll("button, input[type=file]").forEach(button => {
        const edge = button.hasAttribute("data-media-move") && (Number(button.dataset.mediaMove) + Number(button.dataset.direction) < 0 || Number(button.dataset.mediaMove) + Number(button.dataset.direction) >= photos.length);
        button.disabled = busy || locked || edge || (button.hasAttribute("data-media-add-photos") && photos.length >= MAX_PHOTOS);
      });
      root.setAttribute("aria-busy", String(busy));
      $("[data-media-error]").hidden = !failure;
      $("[data-media-error-text]").textContent = failure;
    }
    function setBusy(value, message) {
      busy = value;
      const progress = $("[data-media-progress]"); progress.hidden = !value; progress.textContent = message || "";
      renderControls();
      if (typeof options.onBusy === "function") options.onBusy(value);
    }
    function report(error) {
      failure = (error && error.message) || "Upload did not complete. Please try again.";
      renderControls();
      if (typeof options.onError === "function") options.onError(failure);
    }

    async function addPhotos(files) {
      if (busy || locked || disposed || !files.length) return;
      if (photos.length + files.length > MAX_PHOTOS) return report(new Error(`Choose up to ${MAX_PHOTOS - photos.length} more photos. The gallery holds 12 in total.`));
      controller = new AbortController(); setBusy(true, "Preparing your photos…"); failure = "";
      try {
        for (let index = 0; index < files.length; index++) {
          setBusy(true, `Uploading photo ${index + 1} of ${files.length}…`);
          const preview = await Intake.compressImage(files[index]);
          if (disposed || controller.signal.aborted) return;
          const asset = await DB.uploadMedia(photoBlob(preview, files[index].name), "image", controller.signal);
          if (disposed) { DB.discardMedia(asset.id).catch(() => {}); return; }
          const before = photos.map(photo => photo.url);
          photos.push(Object.assign({}, asset, { preview, draft: true })); renderPhotos(); notify(before);
        }
      } catch (error) { if (!disposed) report(error); }
      finally { if (!disposed) setBusy(false); }
    }

    async function addVideo(file) {
      if (busy || locked || disposed || !file) return;
      if (file.size > MAX_VIDEO_BYTES) return report(new Error("Choose a video smaller than 50 MB. Trim it or export at 720p on your phone."));
      if (!/\.(mp4|mov)$/i.test(file.name || "") && !/^video\/(mp4|quicktime)$/.test(file.type || "")) return report(new Error("Choose an MP4 or MOV garment video."));
      controller = new AbortController(); setBusy(true, "Checking your video…"); failure = "";
      try {
        const duration = await readVideoDuration(file);
        if (disposed || controller.signal.aborted) return;
        const limit = Number(options.maxVideoSeconds) > 0 ? Number(options.maxVideoSeconds) : MAX_SECONDS;
        if (duration && duration > limit + 0.5) throw new Error(`This video is longer than ${limit} seconds. Trim it on your phone and try again.`);
        setBusy(true, "Uploading & optimizing your video… please keep this page open.");
        const asset = await DB.uploadMedia(file, "video", controller.signal);
        if (disposed) { DB.discardMedia(asset.id).catch(() => {}); return; }
        let preview = file;
        // Preview the optimized H.264 MP4, including when the phone selected HEVC / MOV.
        // Private drafts need fetch auth headers, which a <video src> cannot attach.
        try { preview = await DB.mediaPreview(asset.id, controller.signal); } catch (_) {}
        if (disposed) { DB.discardMedia(asset.id).catch(() => {}); return; }
        const old = video;
        video = Object.assign({}, asset, { preview: URL.createObjectURL(preview), draft: true });
        renderVideo(); release(old); notify(photos.map(photo => photo.url));
      } catch (error) { if (!disposed) report(error); }
      finally { if (!disposed) setBusy(false); }
    }
    const change = event => {
      if (event.target.matches("[data-media-photo-input]")) { const files = Array.from(event.target.files || []); event.target.value = ""; addPhotos(files); }
      if (event.target.matches("[data-media-video-input]")) { const file = event.target.files && event.target.files[0]; event.target.value = ""; addVideo(file); }
    };
    const click = event => {
      const button = event.target.closest("button"); if (!button || !root.contains(button) || busy || locked) return;
      if (button.hasAttribute("data-media-add-photos")) $("[data-media-photo-input]").click();
      else if (button.hasAttribute("data-media-add-video")) $("[data-media-video-input]").click();
      else if (button.hasAttribute("data-media-dismiss")) { failure = ""; renderControls(); }
      else if (button.hasAttribute("data-media-remove-video")) { const old = video; video = null; renderVideo(); release(old); notify(photos.map(photo => photo.url)); }
      else if (button.hasAttribute("data-media-remove") || button.hasAttribute("data-media-cover") || button.hasAttribute("data-media-move")) {
        const before = photos.map(photo => photo.url);
        if (button.hasAttribute("data-media-remove")) release(photos.splice(Number(button.dataset.mediaRemove), 1)[0]);
        else if (button.hasAttribute("data-media-cover")) photos.unshift(photos.splice(Number(button.dataset.mediaCover), 1)[0]);
        else { const index = Number(button.dataset.mediaMove), next = index + Number(button.dataset.direction); if (next >= 0 && next < photos.length) [photos[index], photos[next]] = [photos[next], photos[index]]; }
        renderPhotos(); notify(before);
      }
    };
    root.addEventListener("click", click); root.addEventListener("change", change);
    const visibility = () => { if (document.hidden) { const element = previousVideo(); if (element) element.pause(); } };
    document.addEventListener("visibilitychange", visibility);

    const editor = {
      get busy() { return busy; },
      get photos() { return photos.map(photo => photo.url); },
      snapshot() {
        if (busy) throw new Error("Please wait for your photos and video to finish uploading.");
        if (failure) throw new Error("A file did not upload. Retry it or dismiss the failed upload before saving.");
        return { images: photos.map(photo => photo.url), image_url: photos[0] ? photos[0].url : "", video_id: video ? video.id : "" };
      },
      setLocked(value) { locked = !!value; renderControls(); },
      markSaved() { photos.forEach(photo => { photo.draft = false; }); if (video) video.draft = false; },
      reset(product) {
        const old = previousVideo(); if (old) old.pause();
        photos.forEach(release); release(video);
        photos = photosFor(product).map(url => ({ url }));
        video = product && product.video ? Object.assign({}, product.video, { url: urlFor(product.video.url) }) : null;
        failure = ""; renderPhotos(); renderVideo(); notify([]);
      },
      pause() { const element = previousVideo(); if (element) element.pause(); },
      dispose() {
        disposed = true; if (controller) controller.abort();
        editor.pause(); photos.forEach(release); release(video);
        root.removeEventListener("click", click); root.removeEventListener("change", change);
        document.removeEventListener("visibilitychange", visibility);
      }
    };
    editor.reset(options.product || null);
    return editor;
  }

  global.GarmentMedia = { mount, photosFor, durationLabel, MAX_PHOTOS, MAX_SECONDS };
})(typeof window !== "undefined" ? window : globalThis);
