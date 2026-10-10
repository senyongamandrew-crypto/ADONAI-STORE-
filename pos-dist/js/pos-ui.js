/* ======================================================================
   POS presentation sync
   Mirrors the existing cart's displayed totals into the fixed mobile dock
   and forwards its taps to the original controls. No sale state, validation,
   storage, receipt behavior, network request, or business logic is duplicated.
   ====================================================================== */
(function () {
  "use strict";

  const shell = document.getElementById("appShell");
  const layout = document.querySelector(".pos-dashboard-layout");
  const dock = document.getElementById("posCheckoutBar");
  const quickCart = document.getElementById("posQuickCart");
  const quickCharge = document.getElementById("posQuickCharge");
  const quickCount = document.getElementById("posQuickCount");
  const quickTotal = document.getElementById("posQuickTotal");
  const cartToggle = document.getElementById("cartToggle");
  const liveCount = document.getElementById("ctCount");
  const liveTotal = document.getElementById("ctTotal");
  const chargeButton = document.getElementById("btnCharge");

  if (!shell || !layout || !dock || !quickCart || !quickCharge || !cartToggle || !chargeButton) return;

  const copyText = (source, destination) => {
    if (source && destination && destination.textContent !== source.textContent) {
      destination.textContent = source.textContent;
    }
  };

  const syncDock = () => {
    const active = layout.classList.contains("has-cart-items");
    dock.classList.toggle("is-active", active);
    shell.classList.toggle("pos-has-checkout", active);
    dock.setAttribute("aria-hidden", active ? "false" : "true");
    copyText(liveCount, quickCount);
    copyText(liveTotal, quickTotal);
    quickCharge.disabled = !active || chargeButton.disabled;
    quickCart.setAttribute("aria-expanded", cartToggle.getAttribute("aria-expanded") === "true" ? "true" : "false");
  };

  quickCart.addEventListener("click", () => cartToggle.click());
  quickCharge.addEventListener("click", () => {
    if (!quickCharge.disabled) chargeButton.click();
  });

  const observer = new MutationObserver(syncDock);
  observer.observe(layout, { attributes: true, attributeFilter: ["class"] });
  if (liveCount) observer.observe(liveCount, { childList: true, characterData: true, subtree: true, attributes: true });
  if (liveTotal) observer.observe(liveTotal, { childList: true, characterData: true, subtree: true, attributes: true });
  observer.observe(chargeButton, { attributes: true, childList: true, characterData: true, subtree: true });
  observer.observe(cartToggle, { attributes: true, attributeFilter: ["aria-expanded"] });
  window.addEventListener("resize", syncDock, { passive: true });
  syncDock();
})();
