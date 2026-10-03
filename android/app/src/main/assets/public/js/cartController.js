/* Cart drawer state controller. Keeps the catalog scroll context available after close. */
class POSCartDrawerManager {
  constructor() {
    this.drawer = document.getElementById('cartDrawer');
    this.backdrop = document.getElementById('cartBackdrop') || document.getElementById('drawerBackdrop');
    this.catalogRegion = document.getElementById('catalogDashboardRegion');
    this.closeButtons = document.querySelectorAll('[data-action="close-cart"], #closeCart');
    this.openButtons = document.querySelectorAll('[data-action="open-cart"], #cartBtn');
    if (!this.drawer) return;
    this.initEventListeners();
  }

  initEventListeners() {
    this.openButtons.forEach(btn => btn.addEventListener('click', () => this.openCart()));
    this.closeButtons.forEach(btn => btn.addEventListener('click', () => this.closeCart()));
    this.backdrop?.addEventListener('click', () => this.closeCart());
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && this.isCartOpen()) this.closeCart();
    });
  }

  isCartOpen() {
    return this.drawer?.classList.contains('is-active') || document.body.classList.contains('cart-open');
  }

  openCart() {
    this.drawer.classList.add('is-active');
    this.backdrop?.classList.add('is-active');
    // Keep both class vocabularies in sync (this class + storefront.js's
    // "cart-open") so every close path releases the body scroll lock.
    document.body.classList.add('cart-open');
    document.body.classList.remove('cart-drawer-closed');
    document.body.classList.add('cart-drawer-open');
  }

  closeCart() {
    this.drawer.classList.remove('is-active');
    this.backdrop?.classList.remove('is-active');
    document.body.classList.remove('cart-drawer-open', 'cart-open');
    document.body.classList.add('cart-drawer-closed');
    document.body.style.overflow = '';
    document.body.style.position = '';
    document.body.style.touchAction = '';
    if (this.catalogRegion) this.catalogRegion.style.overflowY = 'auto';
  }
}

document.addEventListener('DOMContentLoaded', () => {
  window.cartManager = new POSCartDrawerManager();
});
