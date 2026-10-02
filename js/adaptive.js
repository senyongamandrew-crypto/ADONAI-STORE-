/* ============================================================
   Adonai — Adaptive Device Layer (POS + Ops Console)
   Detects the device class in real time (phone / tablet /
   desktop, touch or not, portrait or landscape) and publishes
   it to CSS as data-attributes on <html> so the whole layout
   automatically flexes to a reasonable size for the screen
   in hand — no pinch-zoom, no shrunken desktop layout.
   ============================================================ */
(function () {
  "use strict";
  var doc = document.documentElement;

  /* ---- migration: purge the retired manual "View Mode" toggle ----
     Layout is now driven exclusively by CSS @media breakpoints, so any
     persisted Desktop/Phone preference or stale scale attributes from
     older builds must be cleared on boot. */
  try { localStorage.removeItem("adonai.ui.view-mode"); } catch (e) {}
  try { sessionStorage.removeItem("adonai.ui.view-mode"); } catch (e) {}
  doc.removeAttribute("data-view-mode");
  doc.removeAttribute("data-ui-scale");
  doc.style.removeProperty("--ui-scale");

  function apply() {
    var w = window.innerWidth || doc.clientWidth;
    var h = window.innerHeight || doc.clientHeight;

    /* ---- device class by viewport + touch capability ---- */
    var touch = (navigator.maxTouchPoints || 0) > 0 || "ontouchstart" in window;
    var coarse = false;
    try { coarse = window.matchMedia("(pointer: coarse)").matches; } catch (e) {}
    var isTouch = touch || coarse;

    var device = "desktop";
    if (w <= 640) device = "phone";
    else if (w <= 1024) device = isTouch ? "tablet" : "desktop";
    else if (isTouch && w <= 1280) device = "tablet";

    /* ---- orientation ---- */
    var orientation = w >= h ? "landscape" : "portrait";

    /* ---- publish to CSS ---- */
    doc.setAttribute("data-device", device);
    doc.setAttribute("data-orientation", orientation);
    doc.setAttribute("data-pointer", isTouch ? "touch" : "fine");
    doc.setAttribute("data-density", (window.devicePixelRatio || 1) >= 2 ? "hidpi" : "standard");

    /* ---- live viewport height var (handles Android browser bars) ---- */
    doc.style.setProperty("--app-vh", h + "px");

    /* ---- notch / gesture-bar safe areas ---- */
    doc.style.setProperty("--sa-b", "env(safe-area-inset-bottom, 0px)");
    doc.style.setProperty("--sa-t", "env(safe-area-inset-top, 0px)");
  }

  var rAF = null;
  function scheduled() {
    if (rAF) return;
    rAF = requestAnimationFrame(function () { rAF = null; apply(); });
  }

  apply();
  window.addEventListener("resize", scheduled, { passive: true });
  window.addEventListener("orientationchange", function () { setTimeout(apply, 120); }, { passive: true });
})();
