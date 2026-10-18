/* ============================================================
   ADONAI STORE — shared header behaviour

   The header is the one piece of chrome every shopper sees, on
   the storefront and on every product page, so its behaviour lives
   in one small module both pages load.

   Two things it owns:
     1. the bar lifts off the page once the shopper starts reading,
     2. the cart count rides the cart icon as a superscript, shows
        nothing while the cart is empty, and pops when a piece is
        added.

   The count is written by whichever page owns the cart (the
   storefront's renderCart, the product page's paintCartCount), so
   this module watches the element instead of owning the number.
   ============================================================ */
(function () {
  "use strict";

  /* ---------- elevation once the page is scrolled ---------- */
  const head = document.querySelector(".site-head");
  if (head) {
    let ticking = false;
    const sync = () => {
      head.classList.toggle("is-scrolled", (window.scrollY || window.pageYOffset || 0) > 6);
      ticking = false;
    };
    sync();
    window.addEventListener("scroll", () => {
      if (ticking) return;
      ticking = true;
      if (typeof window.requestAnimationFrame === "function") window.requestAnimationFrame(sync);
      else setTimeout(sync, 16);
    }, { passive: true });
  }

  /* ---------- cart count badge ---------- */
  const count = document.getElementById("cartCount");
  if (count) {
    const cartBtn = document.getElementById("cartBtn");
    const status = document.getElementById("cartStatus");
    const read = () => Math.max(0, Number(count.textContent) || 0);
    let previous = read();

    /* A returning shopper's cart is restored as the page boots. That is not
       an action, so the badge appears quietly rather than popping at a
       shopper who did not touch anything. The pop is reserved for the count
       rising after the page has settled. */
    let settled = document.readyState !== "loading";
    const settle = () => { settled = true; };
    if (settled) settle();
    else {
      window.addEventListener("DOMContentLoaded", settle, { once: true });
      window.addEventListener("load", settle, { once: true });
      // A page that never finishes loading must not silence the badge for good.
      setTimeout(settle, 3000);
    }

    /* The button carries the count in its accessible name, so a shopper who
       tabs to it hears how many pieces are in the cart. */
    const name = total =>
      total > 0 ? "Cart, " + total + (total === 1 ? " item" : " items") : "Cart, empty";
    const spoken = total =>
      total > 0 ? total + (total === 1 ? " item in your cart" : " items in your cart") : "Your cart is empty";

    const sync = () => {
      const total = read();
      count.classList.toggle("is-empty", total <= 0);

      if (cartBtn) cartBtn.setAttribute("aria-label", name(total));
      if (status && status.textContent !== spoken(total)) status.textContent = spoken(total);

      if (settled && total > previous) {
        // Restart the bump so a second add re-plays it.
        count.classList.remove("bump");
        void count.offsetWidth;
        count.classList.add("bump");
      }
      previous = total;
    };
    sync();
    if (typeof MutationObserver === "function") {
      new MutationObserver(sync).observe(count, { childList: true, characterData: true, subtree: true });
    }
  }
})();
