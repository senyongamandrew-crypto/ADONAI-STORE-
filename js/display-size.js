/* Adonai POS viewing mode — intentionally limited to Desktop or Phone. */
(function () {
  "use strict";
  var KEY = "adonai.ui.view-mode";
  var doc = document.documentElement;

  function automaticMode() {
    return (window.innerWidth || doc.clientWidth || 1024) <= 640 ? "phone" : "desktop";
  }
  function read() {
    try {
      var value = localStorage.getItem(KEY);
      return value === "phone" || value === "desktop" ? value : automaticMode();
    } catch (e) { return automaticMode(); }
  }
  function write(mode) {
    try { localStorage.setItem(KEY, mode); } catch (e) {}
  }
  function scaleFor(mode) { return mode === "phone" ? 0.85 : 1; }

  function apply(mode) {
    mode = mode === "phone" ? "phone" : "desktop";
    write(mode);
    doc.setAttribute("data-view-mode", mode);
    doc.setAttribute("data-ui-scale", mode);
    doc.style.setProperty("--ui-scale", String(scaleFor(mode)));
    document.querySelectorAll("[data-view-mode-option]").forEach(function (button) {
      var active = button.getAttribute("data-view-mode-option") === mode;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", active ? "true" : "false");
    });
    try { window.dispatchEvent(new CustomEvent("adonai:ui-scale", { detail: { mode: mode, scale: scaleFor(mode) } })); } catch (e) {}
  }

  function panel() {
    var box = document.createElement("div");
    box.className = "ui-scale-panel";
    box.innerHTML =
      '<div class="usp-head"><span class="usp-ico">▣</span><span class="usp-title">View Mode</span></div>' +
      '<div class="usp-presets" role="group" aria-label="View mode">' +
        '<button class="usp-chip" type="button" data-view-mode-option="desktop">Desktop</button>' +
        '<button class="usp-chip" type="button" data-view-mode-option="phone">Phone</button>' +
      '</div>' +
      '<p class="usp-hint">Choose the layout for a desktop monitor or phone.</p>';
    return box;
  }
  function mount() {
    document.querySelectorAll(".sidebar").forEach(function (bar) {
      if (bar.querySelector(".ui-scale-panel")) return;
      var box = panel();
      var foot = bar.querySelector(".sidebar-foot");
      if (foot) bar.insertBefore(box, foot); else bar.appendChild(box);
    });
  }
  document.addEventListener("click", function (event) {
    var button = event.target.closest && event.target.closest("[data-view-mode-option]");
    if (!button) return;
    event.preventDefault();
    apply(button.getAttribute("data-view-mode-option"));
  });
  window.addEventListener("storage", function (event) { if (event.key === KEY) apply(read()); });

  function boot() { mount(); apply(read()); }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();

  window.AdonaiDisplaySize = {
    get: function () { return read(); },
    set: apply,
    reset: function () { apply(automaticMode()); }
  };
})();
