/* ============================================================
   Adonai — Display Size (Viewing Control Panel)
   Adds a "Display Size" control to the sidebar menu of the POS
   Register and the Operations Console. Lets the cashier shrink
   or enlarge the whole interface (text, buttons, tiles, cards)
   so it fits a small phone screen or a big desktop monitor.

   The chosen size is stored in localStorage and shared across
   pos.html / admin.html, so it only has to be set once.
   ============================================================ */
(function () {
  "use strict";

  var KEY = "adonai.ui.scale";       // "auto" | "0.75" ... "1.40"
  var MIN = 0.6, MAX = 1.4, STEP = 0.05;
  var doc = document.documentElement;

  /* ---------- storage ---------- */
  function read() {
    try { return localStorage.getItem(KEY) || "auto"; } catch (e) { return "auto"; }
  }
  function write(v) {
    try { localStorage.setItem(KEY, v); } catch (e) {}
  }

  /* ---------- auto size: pick a sensible scale for the device ---------- */
  function autoScale() {
    var w = window.innerWidth || doc.clientWidth || 1024;
    if (w <= 360) return 0.75;   // small / budget phones
    if (w <= 430) return 0.85;   // typical phones
    if (w <= 640) return 0.9;    // large phones
    if (w <= 1024) return 0.95;  // tablets
    return 1;                    // desktop
  }

  function clamp(n) { return Math.min(MAX, Math.max(MIN, Math.round(n * 100) / 100)); }

  function currentScale() {
    var v = read();
    return v === "auto" ? autoScale() : clamp(parseFloat(v) || 1);
  }

  /* ---------- apply ---------- */
  function apply() {
    var s = currentScale();
    doc.style.setProperty("--ui-scale", String(s));
    doc.setAttribute("data-ui-scale", read() === "auto" ? "auto" : String(s));
    syncUI();
    try {
      window.dispatchEvent(new CustomEvent("adonai:ui-scale", { detail: { scale: s } }));
    } catch (e) {}
  }

  function setScale(v) { write(String(v)); apply(); }

  function nudge(dir) {
    var next = clamp(currentScale() + dir * STEP);
    setScale(next.toFixed(2));
  }

  /* ---------- UI ---------- */
  var PRESETS = [
    { v: "0.75", label: "XS" },
    { v: "0.85", label: "S" },
    { v: "1.00", label: "M" },
    { v: "1.15", label: "L" },
    { v: "1.30", label: "XL" }
  ];

  function buildPanel() {
    var box = document.createElement("div");
    box.className = "ui-scale-panel";
    box.id = "uiScalePanel";
    box.innerHTML =
      '<div class="usp-head">' +
        '<span class="usp-ico">🔍</span>' +
        '<span class="usp-title">Display Size</span>' +
        '<span class="usp-val" id="uspVal">100%</span>' +
      '</div>' +
      '<div class="usp-row">' +
        '<button class="usp-btn" type="button" data-scale-dir="-1" aria-label="Make everything smaller">A−</button>' +
        '<input class="usp-range" id="uspRange" type="range" min="' + MIN + '" max="' + MAX + '" step="' + STEP + '" aria-label="Display size" />' +
        '<button class="usp-btn" type="button" data-scale-dir="1" aria-label="Make everything bigger">A+</button>' +
      '</div>' +
      '<div class="usp-presets" id="uspPresets">' +
        '<button class="usp-chip" type="button" data-scale="auto" title="Fit automatically to this device">Auto</button>' +
        PRESETS.map(function (p) {
          return '<button class="usp-chip" type="button" data-scale="' + p.v + '" title="' +
            Math.round(parseFloat(p.v) * 100) + '%">' + p.label + '</button>';
        }).join("") +
      '</div>' +
      '<p class="usp-hint">Shrink the console to fit a phone, or enlarge it on a big screen.</p>';
    return box;
  }

  function mount() {
    var bars = document.querySelectorAll(".sidebar");
    if (!bars.length) return false;
    Array.prototype.forEach.call(bars, function (bar) {
      if (bar.querySelector(".ui-scale-panel")) return;
      var panel = buildPanel();
      var foot = bar.querySelector(".sidebar-foot");
      if (foot) bar.insertBefore(panel, foot);
      else bar.appendChild(panel);
    });
    return true;
  }

  function syncUI() {
    var s = currentScale();
    var isAuto = read() === "auto";
    Array.prototype.forEach.call(document.querySelectorAll(".ui-scale-panel"), function (panel) {
      var val = panel.querySelector(".usp-val");
      if (val) val.textContent = Math.round(s * 100) + "%" + (isAuto ? " · auto" : "");
      var range = panel.querySelector(".usp-range");
      if (range && document.activeElement !== range) range.value = String(s);
      Array.prototype.forEach.call(panel.querySelectorAll(".usp-chip"), function (chip) {
        var d = chip.getAttribute("data-scale");
        var on = isAuto ? d === "auto" : (d !== "auto" && Math.abs(parseFloat(d) - s) < 0.001);
        chip.classList.toggle("active", on);
      });
    });
  }

  /* ---------- events (delegated — survives re-renders) ---------- */
  document.addEventListener("click", function (e) {
    var chip = e.target.closest ? e.target.closest("[data-scale]") : null;
    if (chip) { e.preventDefault(); setScale(chip.getAttribute("data-scale")); return; }
    var btn = e.target.closest ? e.target.closest("[data-scale-dir]") : null;
    if (btn) { e.preventDefault(); nudge(parseInt(btn.getAttribute("data-scale-dir"), 10)); }
  });

  document.addEventListener("input", function (e) {
    if (e.target && e.target.classList && e.target.classList.contains("usp-range")) {
      setScale(parseFloat(e.target.value).toFixed(2));
    }
  });

  /* keyboard: Ctrl/Cmd + - / + / 0 */
  document.addEventListener("keydown", function (e) {
    if (!(e.ctrlKey || e.metaKey)) return;
    if (e.key === "-" || e.key === "_") { e.preventDefault(); nudge(-1); }
    else if (e.key === "+" || e.key === "=") { e.preventDefault(); nudge(1); }
    else if (e.key === "0") { e.preventDefault(); setScale("auto"); }
  });

  /* keep auto in step with rotation / resize */
  window.addEventListener("resize", function () { if (read() === "auto") apply(); }, { passive: true });
  /* another tab/page changed it */
  window.addEventListener("storage", function (e) { if (e.key === KEY) apply(); });

  function boot() { mount(); apply(); }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();

  window.AdonaiDisplaySize = { get: currentScale, set: setScale, reset: function () { setScale("auto"); } };
})();
