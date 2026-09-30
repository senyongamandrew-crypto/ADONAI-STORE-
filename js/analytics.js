/**
 * Adonai Thrift Store — High-Performance E-Commerce Analytics Engine
 * Supports Google Analytics 4 (GA4), Meta Pixel hooks, and privacy-first local event queue.
 */
(function(window) {
  'use strict';

  const STORAGE_KEY = 'adonai_analytics_session';
  const QUEUE_KEY = 'adonai_analytics_queue';

  // Generate or retrieve session ID
  function getSessionId() {
    try {
      let sid = sessionStorage.getItem(STORAGE_KEY);
      if (!sid) {
        sid = 'sess_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
        sessionStorage.setItem(STORAGE_KEY, sid);
      }
      return sid;
    } catch (e) {
      return 'sess_fallback';
    }
  }

  const Analytics = {
    sessionId: getSessionId(),

    /**
     * Core event dispatcher
     * Dispatches to gtag if present, custom window listeners, and local storage queue
     */
    track(eventName, params = {}) {
      const payload = Object.assign({
        event: eventName,
        session_id: this.sessionId,
        timestamp: new Date().toISOString(),
        currency: 'UGX',
        platform: 'web_storefront'
      }, params);

      // 1. Google Analytics 4 (gtag) dispatch if initialized
      if (typeof window.gtag === 'function') {
        try {
          window.gtag('event', eventName, payload);
        } catch (err) {
          console.debug('[Analytics] gtag error:', err);
        }
      }

      // 2. Custom DOM CustomEvent dispatch for UI listeners
      try {
        window.dispatchEvent(new CustomEvent('adonai:analytics', { detail: payload }));
      } catch (e) {}

      // 3. Local buffer (for offline POS / session replay telemetry)
      try {
        const queue = JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]');
        queue.push(payload);
        if (queue.length > 50) queue.shift(); // retain last 50 events
        localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
      } catch (e) {}

      if (window.__ADONAI_DEBUG__) {
        console.info('[Analytics]', eventName, payload);
      }
    },

    /* --- Standard E-Commerce Conversion Events --- */

    trackViewItemList(items, categoryName = 'All') {
      this.track('view_item_list', {
        item_list_name: categoryName,
        items: (items || []).slice(0, 10).map((it, idx) => ({
          item_id: it.id || it.sku,
          item_name: it.name,
          item_category: it.category,
          price: it.selling_price,
          index: idx + 1
        }))
      });
    },

    trackViewItem(item) {
      if (!item) return;
      this.track('view_item', {
        currency: 'UGX',
        value: item.selling_price || 0,
        items: [{
          item_id: item.id || item.sku,
          item_name: item.name,
          item_brand: item.brand || 'Vintage',
          item_category: item.category,
          item_variant: item.size || 'Standard',
          price: item.selling_price || 0
        }]
      });
    },

    trackAddToCart(item, qty = 1) {
      if (!item) return;
      this.track('add_to_cart', {
        currency: 'UGX',
        value: (item.selling_price || 0) * qty,
        items: [{
          item_id: item.id || item.sku,
          item_name: item.name,
          item_category: item.category,
          price: item.selling_price || 0,
          quantity: qty
        }]
      });
    },

    trackRemoveFromCart(item) {
      if (!item) return;
      this.track('remove_from_cart', {
        currency: 'UGX',
        value: item.selling_price || 0,
        items: [{
          item_id: item.id || item.sku,
          item_name: item.name,
          price: item.selling_price || 0
        }]
      });
    },

    trackBeginCheckout(items, totalAmount) {
      this.track('begin_checkout', {
        currency: 'UGX',
        value: totalAmount,
        item_count: (items || []).length,
        items: (items || []).map(it => ({
          item_id: it.id || it.sku,
          item_name: it.name,
          price: it.selling_price,
          quantity: it.qty || 1
        }))
      });
    },

    trackPurchaseViaWhatsApp(order) {
      if (!order) return;
      this.track('purchase', {
        transaction_id: order.id,
        value: order.total || 0,
        currency: 'UGX',
        shipping: order.delivery_fee || 0,
        payment_type: 'WhatsApp Direct',
        items: (order.items || []).map(it => ({
          item_id: it.product_id || it.sku,
          item_name: it.name,
          price: it.unit_price || it.selling_price,
          quantity: it.qty || 1
        }))
      });
    },

    trackPosSale(sale) {
      if (!sale) return;
      this.track('pos_purchase', {
        transaction_id: sale.id,
        value: sale.total || 0,
        currency: 'UGX',
        tender_type: sale.tender ? sale.tender.type : 'cash',
        customer_name: sale.customer_name || 'Walk-in'
      });
    },

    trackSocialClick(network, targetUrl) {
      this.track('outbound_social_click', {
        network,
        target_url: targetUrl
      });
    },

    trackSearch(query, resultCount) {
      this.track('search', {
        search_term: query,
        result_count: resultCount
      });
    }
  };

  window.AdonaiAnalytics = Analytics;
})(window);
