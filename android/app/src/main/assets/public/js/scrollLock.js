/* ======================================================================
   Adonai Store — page scroll lock (single source of truth)

   Background
   ----------
   The storefront had two independent cart controllers (js/storefront.js and
   js/cartController.js) each hand-rolling their own body-class scroll lock.
   Two writers, no shared state, no idempotency: any close path that did not
   strip the exact same class set left the lock engaged. Combined with the
   old `body.cart-drawer-open { touch-action: none }` rule, a stuck lock
   meant the catalog could not be panned at all — the page simply froze.

   Contract
   --------
   * The lock lives on the ROOT element as `html.scroll-locked`. Body cannot
     hold it: <html> declares `overflow-x: hidden`, so the root (not body) is
     what propagates overflow to the viewport, which makes
     `body { overflow: hidden }` inert. See css/storefront.css.
   * It is REFERENCE COUNTED by owner name, so the product modal and the cart
     drawer can be open at the same time without either one releasing the
     other's lock.
   * It is IDEMPOTENT: locking or unlocking the same owner twice is a no-op.
   * It is SELF-HEALING: on boot and on bfcache restore, if the lock is held
     but no overlay is actually on screen, it is force-released. A user can
     never land on a frozen page again.
   * Scroll position is preserved across lock/unlock.
   ====================================================================== */
(function (global) {
  "use strict";

  var LOCK_CLASS = "scroll-locked";

  /* Selectors describing "an overlay is genuinely on screen right now".
     Used only by the self-heal pass. */
  var OPEN_OVERLAY_SELECTOR = [
    ".prod-backdrop.open",
    ".cart-drawer.is-active",
    ".drawer.is-active",
    ".cart-backdrop.is-active",
    ".sidebar-drawer.is-open"
  ].join(",");

  var owners = [];
  var savedScrollY = 0;

  function root() { return document.documentElement; }

  function isLocked() {
    return owners.length > 0;
  }

  /* The DOM can be locked while our owner list is empty: a bfcache restore
     or a server-rendered/cached document replays the class, but this module
     is a fresh instance with no owners. Stale-state detection has to trust
     the DOM, not just memory. */
  function domLocked() {
    var el = root();
    return !!el && el.classList.contains(LOCK_CLASS);
  }

  function sync() {
    var el = root();
    if (!el) return;
    if (isLocked()) el.classList.add(LOCK_CLASS);
    else el.classList.remove(LOCK_CLASS);
  }

  function lock(owner) {
    owner = owner || "default";
    if (owners.indexOf(owner) !== -1) return;   // idempotent
    if (!isLocked()) {
      savedScrollY = global.scrollY || global.pageYOffset || 0;
    }
    owners.push(owner);
    sync();
  }

  function unlock(owner) {
    owner = owner || "default";
    var i = owners.indexOf(owner);
    if (i === -1) return;                        // idempotent
    owners.splice(i, 1);
    sync();
    if (!isLocked()) restoreScroll();
  }

  /* Drop every outstanding lock. The escape hatch for an inconsistent state.
     Always clears the root class, even when `owners` is already empty — that
     mismatch IS the stale state we are healing. */
  function releaseAll() {
    owners.length = 0;
    sync();
    scrubLegacyState();
    restoreScroll();
  }

  function restoreScroll() {
    if (!savedScrollY) return;
    var y = savedScrollY;
    savedScrollY = 0;
    /* `scroll-behavior: smooth` would animate this restore; jump instead. */
    try {
      global.scrollTo({ top: y, left: 0, behavior: "auto" });
    } catch (e) {
      global.scrollTo(0, y);
    }
  }

  /* Strip anything an older build (or a half-applied close path) may have
     left behind that can immobilise the page. */
  function scrubLegacyState() {
    var body = document.body;
    if (!body) return;

    body.classList.remove("cart-drawer-open", "cart-open", "modal-open");
    body.classList.add("cart-drawer-closed");

    /* Inline leftovers from the old hand-rolled locks. */
    body.style.removeProperty("overflow");
    body.style.removeProperty("position");
    body.style.removeProperty("touch-action");
    body.style.removeProperty("top");
    body.style.removeProperty("width");

    /* The catalog <main> must stay a plain, non-scrolling block.
       cartController.js used to stamp `overflow-y: auto` here on every
       cart close, which turned the product grid into a nested scrollport. */
    var catalog = document.getElementById("catalogDashboardRegion");
    if (catalog) {
      catalog.style.removeProperty("overflow");
      catalog.style.removeProperty("overflow-y");
      catalog.style.removeProperty("height");
      catalog.style.removeProperty("max-height");
      catalog.style.removeProperty("touch-action");
    }
  }

  function anyOverlayOpen() {
    try {
      if (document.querySelector(OPEN_OVERLAY_SELECTOR)) return true;
    } catch (e) { /* selector unsupported — fall through */ }
    return document.body ? document.body.classList.contains("cart-open") : false;
  }

  /* If the page is locked (in memory OR in the DOM) but nothing is actually
     on screen, the lock is stale — drop it. */
  function selfHeal() {
    if ((isLocked() || domLocked()) && !anyOverlayOpen()) releaseAll();
    else if (!isLocked() && !domLocked()) scrubLegacyState();
  }

  var ScrollLock = {
    lock: lock,
    unlock: unlock,
    releaseAll: releaseAll,
    isLocked: isLocked,
    selfHeal: selfHeal,
    owners: function () { return owners.slice(); }
  };

  global.AdonaiScrollLock = ScrollLock;

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", selfHeal);
  } else {
    selfHeal();
  }

  /* Back/forward cache restores replay the DOM exactly as it was unloaded,
     including a stuck lock class. */
  global.addEventListener("pageshow", selfHeal);

  /* Last-resort manual release for a user who is already stuck. */
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && (isLocked() || domLocked()) && !anyOverlayOpen()) {
      releaseAll();
    }
  });
})(window);
