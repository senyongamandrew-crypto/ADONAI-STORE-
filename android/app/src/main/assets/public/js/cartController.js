/* ======================================================================
   Cart drawer state controller.

   Keeps the catalog scrollable after the drawer closes.

   Two things in the previous version broke mobile scrolling:

   1. `closeCart()` stamped an inline `overflow-y: auto` on
      #catalogDashboardRegion — the <main> wrapping the whole product grid.
      Inline styles outrank the stylesheet, so after the very first cart
      close the catalog was permanently converted into a nested scroll
      container. With no height bound it could not actually scroll, but it
      still captured touch (and `overflow-x` computes to `auto` alongside
      it), so swipes over the product grid went nowhere. That line is gone;
      the catalog's scrolling belongs to the page.

   2. The scroll lock was hand-rolled here AND in js/storefront.js, with no
      shared state. Any close path that missed a class left the lock on.
      Both now delegate to window.AdonaiScrollLock, which is reference
      counted, idempotent and self-healing.

   Close handling is delegated from the document so that buttons rendered
   into the drawer later (e.g. "Continue Browsing Catalog", which is
   injected by renderCart() long after this constructor runs) are wired up
   too — previously they were not, which was one way to strand the lock.
   ====================================================================== */
class POSCartDrawerManager {
  constructor() {
    this.drawer = document.getElementById('cartDrawer');
    this.backdrop = document.getElementById('cartBackdrop') || document.getElementById('drawerBackdrop');
    this.catalogRegion = document.getElementById('catalogDashboardRegion');
    if (!this.drawer) return;
    this.initEventListeners();
  }

  get scrollLock() {
    return window.AdonaiScrollLock || null;
  }

  initEventListeners() {
    /* Delegated: survives re-renders of the drawer's contents. */
    document.addEventListener('click', event => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target) return;

      if (target.closest('[data-action="open-cart"], #cartBtn')) {
        this.openCart();
        return;
      }
      if (target.closest('[data-action="close-cart"], #closeCart')) {
        this.closeCart();
        return;
      }
      /* Tapping the dimmed backdrop closes the drawer. */
      if (this.backdrop && target === this.backdrop && this.isCartOpen()) {
        this.closeCart();
      }
    });

    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && this.isCartOpen()) this.closeCart();
    });
  }

  isCartOpen() {
    return !!(this.drawer && this.drawer.classList.contains('is-active'))
      || document.body.classList.contains('cart-open');
  }

  openCart() {
    if (this.isCartOpen()) return;              // idempotent
    this.drawer.classList.add('is-active');
    this.backdrop?.classList.add('is-active');
    // Keep both class vocabularies in sync (this class + storefront.js's
    // "cart-open") so every close path releases the same state.
    document.body.classList.add('cart-open');
    document.body.classList.remove('cart-drawer-closed');
    document.body.classList.add('cart-drawer-open');
    this.scrollLock?.lock('cart-drawer');
  }

  closeCart() {
    this.drawer.classList.remove('is-active');
    this.backdrop?.classList.remove('is-active');
    document.body.classList.remove('cart-drawer-open', 'cart-open');
    document.body.classList.add('cart-drawer-closed');

    /* Release the page scroll lock. Never re-assert inline overflow /
       position / touch-action on <body> or on the catalog region: those
       are exactly the properties that froze the page. */
    this.scrollLock?.unlock('cart-drawer');
    this.scrollLock?.selfHeal();
  }
}

document.addEventListener('DOMContentLoaded', () => {
  window.cartManager = new POSCartDrawerManager();
});
