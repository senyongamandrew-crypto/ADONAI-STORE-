/* Real browser downloads + bounded native Android Save As.
   Never navigate a WebView to a blob it cannot save; never fake a .xlsx file. */
(function (global) {
  "use strict";
  const MAX_BYTES = 32 * 1024 * 1024, CHUNK_BYTES = 96 * 1024;
  const objectURLs = new Set();
  const safeName = name => String(name || "adonai-export.csv").replace(/[\\/\x00-\x1f]/g, "_").slice(0, 180);
  function nativeSupported() {
    const bridge = global.Android;
    return !!(bridge && typeof bridge.beginFileExport === "function" && typeof bridge.appendFileExport === "function" && typeof bridge.finishFileExport === "function");
  }
  function nativePresent() { return !!global.Android; }
  function encoded(bytes) {
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode.apply(null, bytes.subarray(offset, offset + 8192));
    return btoa(binary);
  }
  async function saveNative(blob, filename, mime, signal) {
    if (blob.size > MAX_BYTES) throw new Error("This report is too large to save in the app. Choose a smaller date range or use your browser.");
    const bytes = new Uint8Array(await blob.arrayBuffer());
    if (signal?.aborted) throw new DOMException("Download cancelled", "AbortError");
    const id = global.Android.beginFileExport(safeName(filename), mime.split(";")[0], blob.size);
    if (!id) throw new Error("The app could not start Save As. Finish any earlier save dialog, then try this download again.");
    try {
      for (let offset = 0; offset < bytes.length; offset += CHUNK_BYTES) {
        if (signal?.aborted) throw new DOMException("Download cancelled", "AbortError");
        if (!global.Android.appendFileExport(id, encoded(bytes.subarray(offset, offset + CHUNK_BYTES)))) throw new Error("The file could not be copied to the app. Please try again.");
      }
      if (!global.Android.finishFileExport(id)) throw new Error("The Save As dialog could not be opened. Use the browser download link instead.");
      return { mode: "native", id };
    } catch (error) {
      if (typeof global.Android.cancelFileExport === "function") global.Android.cancelFileExport(id);
      throw error;
    }
  }
  function trigger(url, filename) {
    const anchor = document.createElement("a");
    anchor.href = url; anchor.download = safeName(filename); anchor.rel = "noopener noreferrer";
    anchor.target = "_blank"; anchor.style.display = "none";
    document.body.appendChild(anchor); anchor.click();
    setTimeout(() => anchor.remove(), 1000);
    return { mode: "browser" };
  }
  async function download(ticket, signal) {
    if (!ticket || !ticket.url || !ticket.filename) throw new Error("The report download is not ready. Export it again.");
    if (nativeSupported()) {
      const controller = new AbortController();
      const abort = () => controller.abort();
      const timer = setTimeout(abort, 120000);
      if (signal) { if (signal.aborted) abort(); else signal.addEventListener("abort", abort, {once:true}); }
      try {
        const response = await fetch(ticket.url, {cache:"no-store", signal:controller.signal});
        if (!response.ok) {
          let error = {}; try { error = await response.json(); } catch (_) {}
          throw new Error(error.error || "The download expired. Export it again.");
        }
        const blob = await response.blob();
        if (blob.size !== Number(ticket.bytes)) throw new Error("The file download was incomplete. Please try again.");
        return await saveNative(blob, ticket.filename, ticket.type, controller.signal);
      } finally { clearTimeout(timer); if (signal) signal.removeEventListener("abort", abort); }
    }
    if (nativePresent()) {
      // Older APKs have no file-save bridge. An ordinary HTTPS attachment link
      // still works in the user's browser, without passing staff credentials.
      if (typeof global.Android.openExternal === "function") {
        global.Android.openExternal(new URL(ticket.url, global.location.href).href);
        return { mode: "external" };
      }
      throw new Error("Open the download link in your phone browser to save this file.");
    }
    return trigger(ticket.url, ticket.filename);
  }
  async function save(blob, filename, mime) {
    if (nativeSupported()) return saveNative(blob, filename, mime || blob.type);
    if (nativePresent()) throw new Error("This app build needs the file-save update. Use the browser for this report.");
    const url = URL.createObjectURL(blob); objectURLs.add(url);
    const result = trigger(url, filename);
    setTimeout(() => { URL.revokeObjectURL(url); objectURLs.delete(url); }, 10 * 60 * 1000);
    return result;
  }
  function csvCell(value) {
    let text = String(value == null ? "" : value);
    if (typeof value !== "number" && /^[\s\ufeff]*[=+\-@]/.test(text)) text = "'" + text;
    return /[",\r\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
  }
  global.__adonaiFileExportResult = (id, status, message) => {
    global.dispatchEvent(new CustomEvent("adonai-file-export-result", {detail:{id,status,message}}));
  };
  global.addEventListener("pagehide", () => { objectURLs.forEach(url => URL.revokeObjectURL(url)); objectURLs.clear(); });
  global.FileDownloads = {download, save, csvCell, nativeSupported, nativePresent, MAX_BYTES};
})(typeof window !== "undefined" ? window : globalThis);
