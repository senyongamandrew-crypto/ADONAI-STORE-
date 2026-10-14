/* ============================================================
   Adonai — Adaptive Device Layer (POS + Ops Console)
   Detects the device class in real time (phone / tablet /
   desktop, touch or not, portrait or landscape) and publishes
   it to CSS as data-attributes on <html> so the whole layout
   automatically flexes to a reasonable size for the screen
   in hand — no pinch-zoom, no shrunken desktop layout.

   Also owns the persisted Display size preference
   (Compact / Standard / Large) that fits words to the device
   in hand, published as --ui-font-scale + data-display-size
   for css/adaptive-display.css.
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

  /* ============================================================
     DISPLAY SIZE — Compact / Standard / Large
     One knob that scales every type token in
     css/adaptive-display.css. Persisted per device, so a phone
     and a laptop can keep different densities.
     ============================================================ */
  var DISPLAY_KEY = "adonai.ui.display-size";
  var DISPLAY_SIZES = ["compact", "standard", "large"];
  var DISPLAY_SCALES = { compact: 0.86, standard: 1, large: 1.15 };
  var displaySize = "compact";

  function normalizeDisplaySize(value) {
    value = String(value == null ? "" : value).trim().toLowerCase();
    return DISPLAY_SIZES.indexOf(value) >= 0 ? value : null;
  }

  function storedDisplaySize() {
    var stored = null;
    try { stored = localStorage.getItem(DISPLAY_KEY); } catch (e) {}
    return normalizeDisplaySize(stored);
  }

  function queryDisplaySize() {
    try {
      var match = /[?&]display=([a-z]+)/i.exec(window.location.search || "");
      return match ? normalizeDisplaySize(match[1]) : null;
    } catch (e) { return null; }
  }

  function displayButtons() {
    try { return doc.querySelectorAll("[data-display-size-option]"); }
    catch (e) { return []; }
  }

  function paintDisplayButtons() {
    var buttons = displayButtons();
    for (var i = 0; i < buttons.length; i++) {
      var active = buttons[i].getAttribute("data-display-size-option") === displaySize;
      buttons[i].setAttribute("aria-pressed", active ? "true" : "false");
      if (active) buttons[i].classList.add("is-active");
      else buttons[i].classList.remove("is-active");
    }
  }

  /* `?fit=off` renders the shell with the pre-fix sizing for one load — the
     A/B switch used by device-preview.html and by support calls. */
  function fitDisabled() {
    try { return /[?&]fit=(off|legacy)\b/i.test(window.location.search || ""); }
    catch (e) { return false; }
  }

  function applyDisplaySize(value, persist) {
    var next = normalizeDisplaySize(value) || "compact";
    displaySize = next;
    if (fitDisabled()) doc.removeAttribute("data-display-size");
    else doc.setAttribute("data-display-size", next);
    doc.style.setProperty("--ui-font-scale", String(DISPLAY_SCALES[next]));
    if (persist) { try { localStorage.setItem(DISPLAY_KEY, next); } catch (e) {} }
    paintDisplayButtons();
    try {
      window.dispatchEvent(new CustomEvent("adonai:display-size", {
        detail: { size: next, scale: DISPLAY_SCALES[next] }
      }));
    } catch (e) {}
  }

  window.AdonaiDisplay = {
    sizes: DISPLAY_SIZES.slice(),
    scales: DISPLAY_SCALES,
    get: function () { return displaySize; },
    disabled: function () { return fitDisabled(); },
    scale: function () { return DISPLAY_SCALES[displaySize]; },
    set: function (value) { applyDisplaySize(value, true); return displaySize; },
    reset: function () { applyDisplaySize("compact", true); return displaySize; }
  };

  /* Delegated so the control works on every shell without per-page code. */
  document.addEventListener("click", function (event) {
    var node = event.target;
    while (node && node !== doc) {
      if (node.getAttribute && node.getAttribute("data-display-size-option")) {
        applyDisplaySize(node.getAttribute("data-display-size-option"), true);
        return;
      }
      node = node.parentNode;
    }
  }, false);

  function apply() {
    var w = window.innerWidth || doc.clientWidth;
    var h = window.innerHeight || doc.clientHeight;

    /* ---- device class ----
       The SHORT side of the screen decides the class, not the width: a phone
       held in landscape (e.g. 780 x 360) is still a phone and must not be
       served the laptop layout or the laptop type scale. */
    var coarse = false;
    try { coarse = window.matchMedia("(pointer: coarse)").matches; } catch (e) {}
    /* Pointer capability comes from the pointer media query and the touch-point
       count only. (`ontouchstart` is present in ordinary desktop windows too —
       and in headless parsers — so it is deliberately not trusted.) */
    var touchPoints = (navigator.maxTouchPoints || navigator.msMaxTouchPoints || 0) > 0;
    var isTouch = coarse || touchPoints;
    var short = Math.min(w, h);

    var device = "desktop";
    if (short <= 480 && (isTouch || w <= 767)) device = "phone";
    else if (isTouch && short <= 834) device = "tablet";
    else if (isTouch && w <= 1280) device = "tablet";

    /* ---- orientation ---- */
    var orientation = w >= h ? "landscape" : "portrait";

    /* ---- publish to CSS ---- */
    doc.setAttribute("data-device", device);
    doc.setAttribute("data-orientation", orientation);
    doc.setAttribute("data-pointer", isTouch ? "touch" : "fine");
    doc.setAttribute("data-density", (window.devicePixelRatio || 1) >= 2 ? "hidpi" : "standard");
    doc.setAttribute("data-viewport", short <= 480 ? "compact" : (short <= 834 ? "medium" : "wide"));

    /* ---- live viewport height var (handles Android browser bars) ---- */
    doc.style.setProperty("--app-vh", h + "px");

    /* ---- notch / gesture-bar safe areas ---- */
    doc.style.setProperty("--sa-b", "env(safe-area-inset-bottom, 0px)");
    doc.style.setProperty("--sa-t", "env(safe-area-inset-top, 0px)");

    /* ---- keep the display-size preference consistent across resizes ---- */
    paintDisplayButtons();
  }

  var rAF = null;
  function scheduled() {
    if (rAF) return;
    rAF = requestAnimationFrame(function () { rAF = null; apply(); });
  }

  /* Boot: URL override (?display=large) wins for the current load, then the
     saved per-device choice, then the Compact default. */
  applyDisplaySize(queryDisplaySize() || storedDisplaySize() || "compact", false);

  apply();
  window.addEventListener("resize", scheduled, { passive: true });
  window.addEventListener("orientationchange", function () { setTimeout(apply, 120); }, { passive: true });
})();
