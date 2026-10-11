/* Phone-camera checkout. Decodes locally; scans use the existing stock/cart API. */
(function (global) {
  "use strict";
  const scriptURL = document.currentScript && document.currentScript.src;
  const decoderURL = scriptURL ? new URL("vendor/zxing-browser.min.js", scriptURL).href : "js/vendor/zxing-browser.min.js";
  let decoderPromise = null;
  let current = null;
  let onScan = null;
  let stream = null;
  let controls = null;
  let timer = null;
  let epoch = 0;
  let busy = false;
  let torch = false;
  let choosingPhoto = false;

  function loadDecoder() {
    if (global.ZXingBrowser) return Promise.resolve(global.ZXingBrowser);
    if (decoderPromise) return decoderPromise;
    decoderPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script"); script.src = decoderURL; script.async = true;
      script.onload = () => global.ZXingBrowser ? resolve(global.ZXingBrowser) : reject(new Error("Barcode decoder did not load."));
      script.onerror = () => { script.remove(); reject(new Error("Barcode decoder is unavailable. Check the connection, or type the code below.")); };
      document.head.appendChild(script);
    }).catch(error => { decoderPromise = null; throw error; });
    return decoderPromise;
  }
  async function reader() {
    const ZX = await loadDecoder();
    const result = new ZX.BrowserMultiFormatReader(new Map(), { delayBetweenScanAttempts: 180, delayBetweenScanSuccess: 1000 });
    result.possibleFormats = [ZX.BarcodeFormat.CODE_128, ZX.BarcodeFormat.CODE_39, ZX.BarcodeFormat.EAN_13, ZX.BarcodeFormat.EAN_8, ZX.BarcodeFormat.UPC_A, ZX.BarcodeFormat.UPC_E];
    return result;
  }
  function stopCapture() {
    clearTimeout(timer); timer = null;
    if (controls) { try { controls.stop(); } catch (e) {} controls = null; }
    if (stream) { stream.getTracks().forEach(track => track.stop()); stream = null; }
    torch = false;
    if (current) {
      const video = current.root.querySelector("video");
      if (video) { video.pause(); video.srcObject = null; }
      const button = current.root.querySelector("#cameraTorch");
      if (button) { button.hidden = true; button.setAttribute("aria-pressed", "false"); }
      current.root.querySelector(".gt-camera-frame").classList.remove("gt-camera-live");
    }
  }
  function close() { if (current) current.close(); }
  function isOpen() { return !!(current && current.isOpen()); }
  function message(text, error = false) {
    if (!current) return;
    const node = current.root.querySelector("#cameraStatus");
    node.textContent = text; node.classList.toggle("gt-error", error);
  }
  function permissionError(error) {
    const policy = document.permissionsPolicy || document.featurePolicy;
    if (policy && typeof policy.allowsFeature === "function" && !policy.allowsFeature("camera")) {
      return "Camera access is blocked in this embedded preview. Open the register in a new tab on your phone, or scan a tag photo below.";
    }
    if (error.name === "NotAllowedError" || error.name === "PermissionDeniedError" || error.name === "SecurityError") return "Camera permission was not granted. Allow camera access in your browser settings, then try again. You can also scan a tag photo or type its code.";
    if (error.name === "NotFoundError" || error.name === "DevicesNotFoundError") return "No camera was found on this device. Scan a tag photo or type the barcode below.";
    if (error.name === "NotReadableError" || error.name === "TrackStartError") return "The camera is being used by another app. Close that app, then try again.";
    return error.message || "Could not open the camera. Try again, scan a tag photo, or type the barcode.";
  }
  async function submit(code, token) {
    code = String(code || "").trim();
    if (!code || code.length > 80 || busy || !current || token !== epoch) return;
    token = ++epoch; // cancel late camera / photo results before reserving stock
    busy = true;
    stopCapture(); // one physical scan = at most one add; no repeated video frames
    const form = current.root.querySelector("#cameraManualForm");
    const input = form.querySelector("input"); input.value = code;
    form.querySelector("button").disabled = true;
    current.root.querySelector("#cameraRetry").disabled = true;
    message("Checking saved garment and reserving stock…");
    try {
      const accepted = await onScan(code);
      if (!current || token !== epoch) return;
      if (accepted) close();
      else message(`Could not add “${code}”. Check the code, stock availability, or the register's message. Scan again when ready.`, true);
    } catch (error) {
      if (current && token === epoch) message(error.message || "The item could not be added. Try again.", true);
    } finally {
      if (current && token === epoch) {
        busy = false;
        form.querySelector("button").disabled = false;
        current.root.querySelector("#cameraRetry").disabled = false;
      }
    }
  }
  async function start() {
    if (!current || busy) return;
    const token = ++epoch;
    stopCapture();
    const video = current.root.querySelector("#cameraVideo");
    const retry = current.root.querySelector("#cameraRetry"); retry.disabled = true;
    message("Opening your rear camera… Allow camera access when asked.");
    try {
      if (!global.isSecureContext) throw new Error("Camera scanning needs HTTPS. Open the secure register link, or scan a tag photo below.");
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error("Live camera scanning isn't supported here. Open the register in your phone's browser, scan a tag photo, or type its code.");
      const acquired = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } } });
      if (!current || token !== epoch) { acquired.getTracks().forEach(track => track.stop()); return; }
      stream = acquired; video.srcObject = acquired;
      await video.play();
      if (!current || token !== epoch) return;
      current.root.querySelector(".gt-camera-frame").classList.add("gt-camera-live");
      const track = stream.getVideoTracks()[0];
      const capabilities = track && track.getCapabilities ? track.getCapabilities() : {};
      current.root.querySelector("#cameraTorch").hidden = !capabilities.torch;
      message("Keep the entire barcode inside the guide. One scan adds one garment to the current sale.");
      let detector = null;
      if (global.BarcodeDetector) {
        try {
          const supported = await BarcodeDetector.getSupportedFormats();
          if (supported.includes("code_128")) detector = new BarcodeDetector({ formats: ["code_128", "code_39", "ean_13", "ean_8", "upc_a", "upc_e"].filter(format => supported.includes(format)) });
        } catch (e) {} // Safari / older WebViews use the bundled decoder below.
      }
      if (!current || token !== epoch) return;
      if (detector) {
        let failures = 0;
        const decode = async () => {
          if (!current || token !== epoch || !stream || busy) return;
          if (video.readyState >= 2) {
            try {
              const results = await detector.detect(video);
              failures = 0;
              if (results.length && results[0].rawValue) { submit(results[0].rawValue, token); return; }
            } catch (e) {
              if (++failures >= 3) { await startBundled(video, token); return; }
            }
          }
          if (current && token === epoch && stream) timer = setTimeout(decode, 180);
        };
        decode();
      } else await startBundled(video, token);
    } catch (error) {
      if (current && token === epoch) { stopCapture(); message(permissionError(error), true); }
    } finally {
      if (current && token === epoch) retry.disabled = false;
    }
  }
  async function startBundled(video, token) {
    try {
      const decoder = await reader();
      if (!current || token !== epoch || !stream || busy) return;
      const scanning = await decoder.decodeFromVideoElement(video, result => {
        if (result) submit(result.getText(), token);
      });
      if (!current || token !== epoch || !stream || busy) scanning.stop();
      else controls = scanning;
    } catch (error) {
      if (current && token === epoch) { stopCapture(); message(error.message || "Camera decoding failed. Try a tag photo instead.", true); }
    }
  }
  async function photo(file) {
    if (!file || !current || busy) return;
    if (!file.type.startsWith("image/") || file.size > 20 * 1024 * 1024) { message("Choose a barcode photo smaller than 20 MB.", true); return; }
    const token = ++epoch;
    stopCapture();
    message("Reading the barcode in your photo…");
    const url = URL.createObjectURL(file);
    try {
      const decoder = await reader();
      if (!current || token !== epoch) return;
      const result = await decoder.decodeFromImageUrl(url);
      if (current && token === epoch) await submit(result.getText(), token);
    } catch (error) {
      if (current && token === epoch) message("No readable barcode found. Photograph the whole tag in good light, or type its code below.", true);
    } finally { URL.revokeObjectURL(url); }
  }
  function open() {
    if (current || !onScan) return;
    const item = GarmentTools.dialog("posCameraDialog", `
      <div class="gt-heading"><div><p class="gt-eyebrow">PHONE CAMERA · GARMENT CHECKOUT</p><h2 id="posCameraDialogTitle">Scan a garment tag</h2></div><button class="gt-icon-button" type="button" data-gt-close aria-label="Close camera">×</button></div>
      <p class="gt-description">Point your rear camera at the printed barcode. The saved garment and its current price go straight into your sale.</p>
      <div class="gt-camera-frame"><video id="cameraVideo" autoplay playsinline muted aria-label="Live barcode camera"></video><div class="gt-camera-guide" aria-hidden="true"><span></span><span></span><span></span><span></span><div class="gt-camera-line"></div></div><p class="gt-camera-caption">ALIGN THE FULL BARCODE HERE</p><button class="gt-torch-button" id="cameraTorch" type="button" aria-pressed="false" hidden>Light</button></div>
      <p class="gt-message" id="cameraStatus" role="status" aria-live="polite"></p>
      <div class="gt-camera-actions"><button class="btn" type="button" id="cameraRetry">Try camera again</button><button class="btn" type="button" id="cameraPhotoButton">Scan a tag photo</button><input id="cameraPhotoInput" type="file" accept="image/*" capture="environment" hidden /></div>
      <form id="cameraManualForm" class="gt-manual-form"><label for="cameraManualCode">Or enter the code printed below the barcode</label><div><input id="cameraManualCode" type="text" maxlength="80" autocomplete="off" placeholder="Garment barcode / SKU" /><button class="btn primary" type="submit">Add to sale</button></div></form>
      <div class="gt-camera-foot"><span>Camera images are decoded on this device, not uploaded.</span><a href="pos.html" target="_blank" rel="noopener noreferrer">Open register in a new tab ↗</a></div>`, () => {
      ++epoch; stopCapture(); current = null; busy = false; choosingPhoto = false;
    });
    current = item;
    item.root.querySelector("#cameraRetry").addEventListener("click", start);
    const photoInput = item.root.querySelector("#cameraPhotoInput");
    item.root.querySelector("#cameraPhotoButton").addEventListener("click", () => {
      if (busy) return;
      ++epoch; stopCapture(); choosingPhoto = true; photoInput.click();
    });
    photoInput.addEventListener("change", () => { choosingPhoto = false; photo(photoInput.files && photoInput.files[0]); photoInput.value = ""; });
    photoInput.addEventListener("cancel", () => { choosingPhoto = false; });
    item.root.querySelector("#cameraManualForm").addEventListener("submit", event => {
      event.preventDefault(); submit(item.root.querySelector("#cameraManualCode").value, epoch);
    });
    item.root.querySelector("#cameraTorch").addEventListener("click", async event => {
      const track = stream && stream.getVideoTracks()[0]; if (!track) return;
      try { await track.applyConstraints({ advanced: [{ torch: !torch }] }); torch = !torch; event.target.setAttribute("aria-pressed", String(torch)); }
      catch (e) { message("This camera could not switch its light. Use brighter room lighting.", true); }
    });
    start();
  }
  function bind(options) {
    onScan = options.onScan;
    if (options.button) options.button.addEventListener("click", open);
  }
  global.addEventListener("pagehide", close);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) return;
    if (choosingPhoto) { ++epoch; stopCapture(); } else close();
  });
  global.PosCamera = { bind, open, close, isOpen };
})(window);
