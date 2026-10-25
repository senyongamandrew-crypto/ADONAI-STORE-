/* =====================================================================
   Adonai Delivery — rider partner application
   ---------------------------------------------------------------------
   A third, standalone entity in the Adonai system:
     storefront  -> shopper
     pos/admin   -> cashier & dispatcher
     delivery    -> the rider partner (this app)
   It has its own device-bound session, its own installable manifest and its
   own screens. Everything it displays comes from /api/rider/* on this server;
   it never reads the cashier session, the shopper's cart or another rider's
   customer details.
   ===================================================================== */
(function (global) {
  "use strict";

  var $ = function (id) { return document.getElementById(id); };
  var esc = function (value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  };
  var SESSION_KEY = "adonai.delivery.session.v1";
  var PENDING_KEY = "adonai.delivery.pending.v1";
  var DEMO_PARAM = new URLSearchParams(global.location.search).get("demo") === "1";
  var STAGES = ["assigned", "accepted", "collected", "arrived", "delivered"];
  var STAGE_LABEL = {
    assigned: "Assigned", accepted: "Accepted", collected: "Collected",
    arrived: "Arrived", delivered: "Delivered", issue: "Problem", declined: "Declined"
  };
  var TABS = ["jobs", "active", "history", "profile"];
  var DECLINE_REASONS = ["Too far for this trip", "Vehicle problem", "Customer unreachable", "Finishing another job", "Other"];
  var ISSUE_HINTS = ["Customer not answering", "Address is unclear", "Heavy traffic delay", "Parcel needs checking"];

  function readJSON(key, fallback) {
    try { return JSON.parse(global.localStorage.getItem(key) || "null") || fallback; }
    catch (_) { return fallback; }
  }
  function writeJSON(key, value) {
    try { global.localStorage.setItem(key, JSON.stringify(value)); } catch (_) {}
  }

  var state = {
    token: "", base: global.location.origin, label: "", connectedAt: null,
    rider: null, orders: [], tracking: null, history: null,
    gpsPolicy: false, demo: false, online: global.navigator.onLine !== false,
    tab: "jobs", known: new Set(), fresh: new Set(), pending: readJSON(PENDING_KEY, []),
    busy: false, syncing: false, detail: {}, watchId: null, mockTimer: null, seq: 0,
    installPrompt: null, sessionExpired: false, lastSync: null
  };

  /* ---------------------------------------------------------------- utils */
  function money(n) {
    try { return new Intl.NumberFormat("en-UG").format(Math.max(0, Number(n) || 0)); }
    catch (_) { return String(Math.max(0, Number(n) || 0)); }
  }
  function timeAgo(value) {
    if (!value) return "just now";
    var t = Date.parse(value);
    if (!t) return "";
    var d = Math.max(0, Date.now() - t);
    if (d < 60000) return "just now";
    if (d < 3600000) return Math.floor(d / 60000) + " min ago";
    if (d < 86400000) return Math.floor(d / 3600000) + " h ago";
    try { return new Date(t).toLocaleDateString("en-UG", { day: "numeric", month: "short" }); }
    catch (_) { return "earlier"; }
  }
  function fullTime(value) {
    if (!value) return "";
    var t = Date.parse(value);
    if (!t) return "";
    try { return new Date(t).toLocaleString("en-UG", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }); }
    catch (_) { return value; }
  }
  function digits(phone) { return String(phone || "").replace(/[^+0-9]/g, ""); }
  function waNumber(phone) {
    var d = String(phone || "").replace(/\D/g, "");
    if (d.length === 10 && d.charAt(0) === "0") d = "256" + d.slice(1);
    return d;
  }
  function stageOf(order) { return (order && order.progress && order.progress.stage) || "assigned"; }
  function stageChip(stage) {
    if (stage === "assigned") return "lime";
    if (stage === "delivered") return "green";
    if (stage === "issue" || stage === "declined") return "red";
    return "slate";
  }
  function setOnline(value) {
    state.online = !!value;
    var bar = $("offlineBar"), net = $("netState");
    if (bar) bar.hidden = state.online;
    if (net) {
      net.classList.toggle("off", !state.online);
      var span = net.querySelector("span");
      if (span) span.textContent = state.online ? "Online" : "Offline";
    }
  }
  function toast(text, kind) {
    var host = $("toastHost");
    if (!host) return;
    var node = global.document.createElement("div");
    node.className = "dl-toast" + (kind ? " " + kind : "");
    node.innerHTML = '<span class="ico">' + (kind === "err" ? "!" : kind === "ok" ? "✓" : "●") + "</span><span>" + esc(text) + "</span>";
    host.appendChild(node);
    global.setTimeout(function () { node.remove(); }, 4600);
  }
  function deskLog(text) {
    var log = $("deskLog");
    if (!log) return;
    var row = global.document.createElement("div");
    row.textContent = new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" }) + " · " + text;
    log.insertBefore(row, log.firstChild);
    while (log.children.length > 14) log.removeChild(log.lastChild);
  }
  function beep() {
    try {
      var Ctx = global.AudioContext || global.webkitAudioContext;
      if (!Ctx) return;
      var ctx = new Ctx(), osc = ctx.createOscillator(), gain = ctx.createGain();
      osc.type = "sine"; osc.frequency.value = 880;
      gain.gain.setValueAtTime(0.0001, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.09, ctx.currentTime + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.32);
      osc.connect(gain); gain.connect(ctx.destination);
      osc.start(); osc.stop(ctx.currentTime + 0.34);
      osc.onended = function () { try { ctx.close(); } catch (_) {} };
    } catch (_) {}
  }
  function systemNotice(order) {
    try {
      if (!("Notification" in global) || global.Notification.permission !== "granted") return;
      new global.Notification("New delivery · " + order.id, {
        body: (order.customer_name || "Customer") + " · " + (order.area || order.address || "Kampala"),
        tag: "adonai-delivery-" + order.id,
        icon: "assets/delivery-icon-192.png"
      });
    } catch (_) {}
  }

  /* ------------------------------------------------------------------ api */
  function call(path, method, body) {
    method = method || "GET";
    var controller = typeof AbortController === "function" ? new AbortController() : null;
    var timer = controller ? global.setTimeout(function () { controller.abort(); }, 16000) : null;
    var headers = { "Content-Type": "application/json" };
    if (state.token) headers.Authorization = "Bearer " + state.token;
    return global.fetch(state.base + path, {
      method: method, headers: headers, cache: "no-store",
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller ? controller.signal : undefined
    }).then(function (response) {
      return response.json().catch(function () { return {}; }).then(function (data) {
        return { status: response.status, ok: response.ok && data.ok !== false, data: data || {} };
      });
    }).then(function (result) {
      setOnline(true);
      if (result.status === 401 && path !== "/api/rider/connect") {
        state.sessionExpired = true;
        clearSession();
        render();
        var message = "This phone's session expired. Ask dispatch for a new connection code.";
        showConnectError(message);
        throw new Error(message);
      }
      return result;
    }).catch(function (error) {
      if (error && error.name === "AbortError") throw new Error("The server took too long. Check your connection and try again.");
      // Browsers reject a dead network with a TypeError, a DOMException or a
      // bare "Failed to fetch" error depending on the engine/realm. Treat all
      // of them as offline so a delivery update can be queued, not lost.
      var offline = error instanceof TypeError ||
        (error && (error.name === "TypeError" || error.name === "NetworkError" ||
          /failed to fetch|networkerror|load failed|network request failed/i.test(String(error.message || ""))));
      if (offline) {
        setOnline(false);
        throw new Error("You are offline. Reconnect to continue.");
      }
      throw error;
    }).finally(function () { if (timer) global.clearTimeout(timer); });
  }

  function saveSession() {
    writeJSON(SESSION_KEY, {
      token: state.token, base: state.base, label: state.label,
      connectedAt: state.connectedAt, rider: state.rider
    });
  }
  function clearSession() {
    state.token = ""; state.rider = null; state.orders = []; state.history = null;
    state.known = new Set(); state.fresh = new Set(); state.detail = {};
    try { global.localStorage.removeItem(SESSION_KEY); } catch (_) {}
    stopLocation();
  }
  function savePending() { writeJSON(PENDING_KEY, state.pending); }

  /* -------------------------------------------------------------- connect */
  function showConnectError(text) {
    var box = $("connectError");
    if (!box) return;
    box.hidden = !text;
    box.textContent = text || "";
  }
  function connect(event) {
    event.preventDefault();
    if (state.busy) return;
    var code = $("connectCode").value.trim();
    var label = $("deviceLabel").value.trim() || "My delivery phone";
    var server = ($("serverUrl").value || "").trim().replace(/\/+$/, "") || global.location.origin;
    if (!code) { showConnectError("Enter the connection code from dispatch."); return; }
    state.base = server;
    state.busy = true;
    showConnectError(state.sessionExpired ? "This phone's session expired. Ask dispatch for a new connection code." : "");
    state.sessionExpired = false;
    $("connectBtn").disabled = true;
    $("connectBtn").innerHTML = "Connecting… <span>→</span>";
    call("/api/rider/connect", "POST", { code: code, device_label: label })
      .then(function (result) {
        if (!result.ok) {
          showConnectError(result.data.error || "Could not connect this phone. Check the code and try again.");
          return null;
        }
        state.token = result.data.session_token;
        state.rider = result.data.rider || null;
        state.label = label;
        state.connectedAt = new Date().toISOString();
        state.gpsPolicy = !!result.data.gps_policy;
        state.demo = !!result.data.demo;
        state.known = new Set(); state.fresh = new Set();
        saveSession();
        $("connectCode").value = "";
        render();
        toast("Connected — loading your assigned deliveries.", "ok");
        deskLog("phone connected" + (state.rider ? " · " + state.rider.name : ""));
        return sync();
      })
      .catch(function (error) { showConnectError(error.message || "Could not reach dispatch."); })
      .finally(function () {
        state.busy = false;
        $("connectBtn").disabled = false;
        $("connectBtn").innerHTML = "Connect this phone <span>→</span>";
      });
  }

  /* ----------------------------------------------------------------- sync */
  function announce(orders) {
    orders.forEach(function (order) {
      state.fresh.add(order.id);
      systemNotice(order);
    });
    if (orders.length) {
      beep();
      try { if (global.navigator.vibrate) global.navigator.vibrate([90, 60, 90]); } catch (_) {}
      toast(orders.length === 1 ? "New delivery assigned: " + orders[0].id : orders.length + " new deliveries assigned");
      deskLog("new order " + orders.map(function (o) { return o.id; }).join(", "));
    }
  }
  function ingest(orders) {
    var ids = new Set(orders.map(function (o) { return o.id; }));
    if (state.known.size) {
      var fresh = orders.filter(function (o) { return !state.known.has(o.id); });
      if (fresh.length) announce(fresh);
    }
    state.known = ids;
    // A job that vanished (delivered, declined or cancelled) is no longer new.
    state.fresh.forEach(function (id) { if (!ids.has(id)) state.fresh.delete(id); });
  }
  function flushPending() {
    if (!state.pending.length || !state.online) return Promise.resolve();
    var queue = state.pending.slice();
    return queue.reduce(function (chain, item) {
      return chain.then(function () {
        return call(item.path, "POST", item.body).then(function (result) {
          // Any definitive answer means the server has seen this attempt; the
          // progress endpoint is idempotent for a repeated stage.
          state.pending = state.pending.filter(function (p) { return p.id !== item.id; });
          savePending();
          if (!result.ok) toast(result.data.error || "A queued update was rejected by dispatch.", "err");
          else deskLog("queued update sent · " + item.body.stage);
        }).catch(function () { /* keep it queued for the next sync */ });
      });
    }, Promise.resolve()).then(function () { render(); });
  }
  function sync() {
    if (!state.token || state.syncing) return Promise.resolve();
    state.syncing = true;
    return call("/api/rider/me")
      .then(function (result) {
        if (!result.ok) throw new Error(result.data.error || "Could not load your deliveries.");
        var data = result.data;
        state.rider = data.rider || state.rider;
        state.tracking = data.tracking || null;
        state.gpsPolicy = !!data.gps_policy;
        state.demo = !!data.demo;
        state.orders = data.orders || [];
        state.lastSync = new Date();
        ingest(state.orders);
        saveSession();
        render();
        return flushPending();
      })
      .catch(function (error) {
        if (error && /offline/i.test(error.message)) setOnline(false);
        else toast(error.message || "Could not refresh your jobs.", "err");
        render();
      })
      .finally(function () { state.syncing = false; });
  }
  function loadHistory() {
    if (!state.token) return Promise.resolve();
    return call("/api/rider/history").then(function (result) {
      if (result.ok) { state.history = result.data; render(); }
    }).catch(function () {});
  }

  /* -------------------------------------------------------------- actions */
  function queueProgress(orderId, stage, extra) {
    state.pending.push({
      id: "p" + Date.now() + Math.random().toString(36).slice(2, 7),
      path: "/api/rider/orders/" + encodeURIComponent(orderId) + "/progress",
      body: Object.assign({ stage: stage }, extra || {})
    });
    savePending();
  }
  function doProgress(orderId, stage, extra) {
    if (state.busy) return;
    state.busy = true;
    var body = Object.assign({ stage: stage }, extra || {});
    return call("/api/rider/orders/" + encodeURIComponent(orderId) + "/progress", "POST", body)
      .then(function (result) {
        if (!result.ok) { toast(result.data.error || "That update could not be saved.", "err"); return; }
        closeSheet();
        toast(stage === "delivered" ? "Delivery confirmed. Nice work!" : "Update saved · " + STAGE_LABEL[stage], "ok");
        deskLog(orderId + " → " + stage);
        if (stage === "delivered") loadHistory();
        return sync();
      })
      .catch(function (error) {
        if (/offline/i.test(error.message)) {
          queueProgress(orderId, stage, extra);
          closeSheet();
          toast("Saved on this phone — it will send when you are back online.", "ok");
          render();
        } else toast(error.message, "err");
      })
      .finally(function () { state.busy = false; });
  }
  function doDecline(orderId, reason, note) {
    if (state.busy) return;
    state.busy = true;
    return call("/api/rider/orders/" + encodeURIComponent(orderId) + "/decline", "POST", { reason: reason, note: note })
      .then(function (result) {
        if (!result.ok) { toast(result.data.error || "Could not decline that job.", "err"); return; }
        closeSheet();
        toast("Job declined. Dispatch can reassign it.", "ok");
        deskLog(orderId + " declined · " + reason);
        return sync();
      })
      .catch(function (error) { toast(error.message, "err"); })
      .finally(function () { state.busy = false; });
  }
  function doStatus(status) {
    if (state.busy) return;
    state.busy = true;
    call("/api/rider/status", "POST", { status: status })
      .then(function (result) {
        if (!result.ok) { toast(result.data.error || "Could not change your availability.", "err"); return; }
        state.rider = result.data.rider || state.rider;
        saveSession();
        toast("You are now " + status + ".", "ok");
        deskLog("availability → " + status);
        render();
      })
      .catch(function (error) { toast(error.message, "err"); })
      .finally(function () { state.busy = false; });
  }
  function demoOrder() {
    if (!state.token) { toast("Connect this phone first, then send a demo order."); return; }
    if (state.busy) return;
    state.busy = true;
    call("/api/rider/demo/order", "POST", {})
      .then(function (result) {
        if (!result.ok) { toast(result.data.error || "Demo orders are not enabled on this server.", "err"); return; }
        toast("A new paid order was dispatched to you.", "ok");
        deskLog("demo order created · " + result.data.order_id);
        return sync();
      })
      .catch(function (error) { toast(error.message, "err"); })
      .finally(function () { state.busy = false; });
  }

  /* ---------------------------------------------------------------- sheets */
  function closeSheet() {
    var host = $("sheetHost");
    if (!host) return;
    host.hidden = true;
    host.innerHTML = "";
  }
  function openSheet(html, mount) {
    var host = $("sheetHost");
    host.innerHTML = '<div class="dl-sheet" role="dialog" aria-modal="true">' + html + "</div>";
    host.hidden = false;
    host.onclick = function (event) { if (event.target === host) closeSheet(); };
    var sheet = host.querySelector(".dl-sheet");
    sheet.querySelectorAll("[data-close]").forEach(function (btn) {
      btn.addEventListener("click", closeSheet);
    });
    if (mount) mount(sheet);
    return sheet;
  }
  function sheetHead(title, subtitle) {
    return '<div class="dl-sheet-head"><div><h3>' + esc(title) + "</h3>" +
      (subtitle ? "<p>" + esc(subtitle) + "</p>" : "") +
      '</div><button class="dl-sheet-x" type="button" data-close aria-label="Close">×</button></div>';
  }
  function openProgressSheet(orderId, stage, customer) {
    if (stage === "issue") return openIssueSheet(orderId);
    if (stage !== "delivered") return doProgress(orderId, stage, {});
    openSheet(
      sheetHead("Confirm delivery", "Record who received the parcel. Dispatch stores this with the order.") +
      '<div class="dl-consent" style="background:#F1F5F9;border-color:#E2E8F0"><strong style="font-size:12px">' +
        esc(orderId) + " · " + esc(customer || "Customer") + "</strong></div>" +
      '<label for="proofName">Recipient name (required)</label>' +
      '<input id="proofName" type="text" maxlength="100" autocomplete="off" placeholder="Person who received the parcel" />' +
      '<label for="proofNote">Delivery note (optional)</label>' +
      '<textarea id="proofNote" rows="2" maxlength="500" placeholder="Left with gatekeeper, customer called ahead…"></textarea>' +
      '<div class="dl-consent"><input id="proofConfirm" type="checkbox" /><label for="proofConfirm">I handed this parcel to the person named above and the delivery is complete.</label></div>' +
      '<p class="dl-sheet-error" id="sheetError" hidden></p>' +
      '<div class="dl-btn-row"><button class="dl-btn" type="button" data-close>Cancel</button>' +
      '<button class="dl-btn primary" type="button" id="sheetGo">Confirm delivered</button></div>',
      function (sheet) {
        sheet.querySelector("#sheetGo").addEventListener("click", function () {
          var name = sheet.querySelector("#proofName").value.trim();
          var note = sheet.querySelector("#proofNote").value.trim();
          var err = sheet.querySelector("#sheetError");
          if (!name) { err.hidden = false; err.textContent = "Enter the name of the person who received the parcel."; return; }
          if (!sheet.querySelector("#proofConfirm").checked) { err.hidden = false; err.textContent = "Confirm that you handed over the parcel."; return; }
          err.hidden = true;
          doProgress(orderId, "delivered", { received_by: name, note: note });
        });
        global.setTimeout(function () { try { sheet.querySelector("#proofName").focus(); } catch (_) {} }, 60);
      }
    );
  }
  function openIssueSheet(orderId) {
    openSheet(
      sheetHead("Report a problem", "Dispatch sees this immediately. The job stays yours until they reassign it.") +
      '<p class="dl-hint">Quick notes — tap one or write your own:</p>' +
      '<div class="dl-reasons" id="issueHints">' + ISSUE_HINTS.map(function (h) {
        return '<button type="button" data-hint="' + esc(h) + '">' + esc(h) + "</button>";
      }).join("") + "</div>" +
      '<label for="issueNote">What happened? (required)</label>' +
      '<textarea id="issueNote" rows="3" maxlength="500" placeholder="Describe the problem for dispatch…"></textarea>' +
      '<p class="dl-sheet-error" id="sheetError" hidden></p>' +
      '<div class="dl-btn-row"><button class="dl-btn" type="button" data-close>Cancel</button>' +
      '<button class="dl-btn primary" type="button" id="sheetGo">Send problem report</button></div>',
      function (sheet) {
        sheet.querySelectorAll("[data-hint]").forEach(function (btn) {
          btn.addEventListener("click", function () {
            var field = sheet.querySelector("#issueNote");
            field.value = btn.getAttribute("data-hint") + (field.value ? ". " + field.value : "");
            field.focus();
          });
        });
        sheet.querySelector("#sheetGo").addEventListener("click", function () {
          var note = sheet.querySelector("#issueNote").value.trim();
          var err = sheet.querySelector("#sheetError");
          if (!note) { err.hidden = false; err.textContent = "Describe the problem so dispatch can help."; return; }
          err.hidden = true;
          doProgress(orderId, "issue", { note: note });
        });
      }
    );
  }
  function openDeclineSheet(orderId) {
    var selected = DECLINE_REASONS[0];
    openSheet(
      sheetHead("Decline this delivery", "The order returns to dispatch so another rider can take it. Only decline before collecting the parcel.") +
      '<p class="dl-hint">Reason (required)</p>' +
      '<div class="dl-reasons" id="declineReasons">' + DECLINE_REASONS.map(function (r, i) {
        return '<button type="button" data-reason="' + esc(r) + '" aria-pressed="' + (i === 0 ? "true" : "false") + '">' + esc(r) + "</button>";
      }).join("") + "</div>" +
      '<label for="declineNote">Extra detail (optional)</label>' +
      '<textarea id="declineNote" rows="2" maxlength="300" placeholder="Anything dispatch should know…"></textarea>' +
      '<p class="dl-sheet-error" id="sheetError" hidden></p>' +
      '<div class="dl-btn-row"><button class="dl-btn" type="button" data-close>Keep job</button>' +
      '<button class="dl-btn danger" type="button" id="sheetGo">Decline job</button></div>',
      function (sheet) {
        sheet.querySelectorAll("[data-reason]").forEach(function (btn) {
          btn.addEventListener("click", function () {
            selected = btn.getAttribute("data-reason");
            sheet.querySelectorAll("[data-reason]").forEach(function (b) {
              b.setAttribute("aria-pressed", String(b === btn));
            });
          });
        });
        sheet.querySelector("#sheetGo").addEventListener("click", function () {
          doDecline(orderId, selected, sheet.querySelector("#declineNote").value.trim());
        });
      }
    );
  }
  function openDetailSheet(orderId) {
    openSheet(
      sheetHead("Parcel details", orderId) +
      '<div id="detailBody"><p class="dl-muted">Loading this delivery…</p></div>' +
      '<div class="dl-btn-row"><button class="dl-btn" type="button" data-close>Close</button></div>'
    );
    call("/api/rider/orders/" + encodeURIComponent(orderId))
      .then(function (result) {
        var body = $("detailBody");
        if (!body) return;
        if (!result.ok) { body.innerHTML = '<p class="dl-sheet-error">' + esc(result.data.error || "Could not load this delivery.") + "</p>"; return; }
        var o = result.data.order || {};
        state.detail[orderId] = o;
        var items = (o.items || []).map(function (i) {
          return "<li><span>" + esc(i.name) + " <small style='color:#64748B'>× " + esc(i.qty) + "</small></span><strong>UGX " + money(i.unit_price) + "</strong></li>";
        }).join("") || "<li><span>No item list on this order</span></li>";
        var timeline = (o.timeline || []).map(function (e) {
          return "<li><strong>" + esc(STAGE_LABEL[e.stage] || e.stage) + "</strong><small>" + esc(fullTime(e.created_at)) +
            (e.note ? " · " + esc(e.note) : "") + (e.received_by ? " · received by " + esc(e.received_by) : "") + "</small></li>";
        }).join("") || "<li><strong>Assigned</strong><small>Waiting for your first update</small></li>";
        body.innerHTML =
          '<div class="dl-row"><span class="k">Customer</span><span class="v">' + esc(o.customer_name) + "</span></div>" +
          '<div class="dl-row"><span class="k">Phone</span><span class="v">' + esc(o.customer_phone || "—") + "</span></div>" +
          '<div class="dl-row"><span class="k">Address</span><span class="v">' + esc(o.address || o.area || "Confirm with dispatch") + "</span></div>" +
          '<div class="dl-row"><span class="k">Payment</span><span class="v">' + (o.paid ? "Paid · " + esc(o.payment_method || "online") : esc(o.payment_status)) + "</span></div>" +
          '<div class="dl-row"><span class="k">Order total</span><span class="v">UGX ' + money(o.total) + "</span></div>" +
          (o.notes ? '<p class="dl-job-note">📝 ' + esc(o.notes) + "</p>" : "") +
          '<p class="dl-eyebrow-sm" style="margin-top:16px">PARCEL CONTENTS</p><ul class="dl-detail-items">' + items + "</ul>" +
          '<p class="dl-eyebrow-sm" style="margin-top:16px">DELIVERY TIMELINE</p><ul class="dl-timeline">' + timeline + "</ul>";
      })
      .catch(function (error) {
        var body = $("detailBody");
        if (body) body.innerHTML = '<p class="dl-sheet-error">' + esc(error.message) + "</p>";
      });
  }
  function openAlertsSheet() {
    var supported = "Notification" in global;
    var permission = supported ? global.Notification.permission : "unsupported";
    var label = permission === "granted" ? "Pop-ups are on" : permission === "denied" ? "Pop-ups are blocked in browser settings" :
      permission === "unsupported" ? "This browser cannot show system pop-ups" : "Turn on pop-ups";
    openSheet(
      sheetHead("New order alerts", "Get told the moment dispatch assigns you a delivery.") +
      '<div class="dl-consent"><strong style="font-size:14px">🔔</strong><label style="font-size:12px">New jobs also appear with a sound, a vibration and a banner inside this app — no browser permission needed. System pop-ups additionally work when the app is in the background.</label></div>' +
      '<p class="dl-hint">Current status: <strong>' + esc(label) + "</strong></p>" +
      '<div class="dl-btn-row"><button class="dl-btn" type="button" data-close>Close</button>' +
      (permission === "default" ? '<button class="dl-btn primary" type="button" id="sheetGo">Allow pop-ups</button>' : "") + "</div>",
      function (sheet) {
        var go = sheet.querySelector("#sheetGo");
        if (!go) return;
        go.addEventListener("click", function () {
          global.Notification.requestPermission().then(function (result) {
            closeSheet();
            toast(result === "granted" ? "Pop-ups are on for new deliveries." : "Pop-ups were not enabled — in-app alerts still work.", result === "granted" ? "ok" : "");
          }).catch(function () { closeSheet(); });
        });
      }
    );
  }

  /* ------------------------------------------------------------- GPS duty */
  function postLocation(lat, lng, accuracy, fixMs, mock) {
    return call("/api/rider/location", "POST", {
      latitude: lat, longitude: lng, accuracy_m: accuracy,
      sequence: ++state.seq, fix_time_ms: fixMs, mock: !!mock
    }).catch(function () {});
  }
  function stopLocation() {
    if (state.watchId !== null && global.navigator.geolocation && global.navigator.geolocation.clearWatch) {
      try { global.navigator.geolocation.clearWatch(state.watchId); } catch (_) {}
    }
    state.watchId = null;
    if (state.mockTimer) { global.clearInterval(state.mockTimer); state.mockTimer = null; }
  }
  function startDuty(mock) {
    if (state.busy) return;
    state.busy = true;
    call("/api/rider/duty/start", "POST", { consent: true })
      .then(function (result) {
        if (!result.ok) { toast(result.data.error || "Could not start the duty.", "err"); return; }
        closeSheet();
        toast(mock ? "Duty started · sending simulated Kampala fixes." : "Duty started · sharing your latest fix only.", "ok");
        deskLog("GPS duty started" + (mock ? " · simulated" : ""));
        stopLocation();
        state.seq = 0;
        if (mock) {
          var send = function () {
            var fix = Date.now();
            postLocation(0.3136 + (Math.random() - 0.5) * 0.012, 32.5822 + (Math.random() - 0.5) * 0.012,
              12 + Math.random() * 20, fix, true);
          };
          send(); state.mockTimer = global.setInterval(send, 9000);
        } else if (global.navigator.geolocation) {
          state.watchId = global.navigator.geolocation.watchPosition(function (pos) {
            postLocation(pos.coords.latitude, pos.coords.longitude, pos.coords.accuracy || 0, pos.timestamp, false);
          }, function () {
            toast("Location was not granted. Duty is active but dispatch will see no fix — stop it or use a simulated duty.", "err");
          }, { enableHighAccuracy: true, maximumAge: 10000, timeout: 15000 });
        } else {
          toast("This browser has no location support. Stop the duty when you finish.");
        }
        return sync();
      })
      .catch(function (error) { toast(error.message, "err"); })
      .finally(function () { state.busy = false; });
  }
  function openDutySheet() {
    openSheet(
      sheetHead("Start a delivery duty", "Sharing is your choice. You can stop it at any time.") +
      '<div class="dl-consent"><input id="dutyConsent" type="checkbox" /><label for="dutyConsent">I agree to share my phone\'s location with Adonai dispatch for this duty (max 12 hours). Only the latest fix is stored — no route history, no phone serial, no IMEI.</label></div>' +
      '<p class="dl-hint">Choose how this preview shares a position. On a real phone, use the device GPS. Simulated fixes are honestly labelled “simulated” on the dispatch map.</p>' +
      '<p class="dl-sheet-error" id="sheetError" hidden></p>' +
      '<div class="dl-btn-row"><button class="dl-btn" type="button" data-close>Cancel</button>' +
      '<button class="dl-btn primary" type="button" id="dutyReal">Use device GPS</button></div>' +
      (state.demo ? '<div class="dl-btn-row"><button class="dl-btn" type="button" id="dutyMock" style="width:100%">Use simulated location (demo)</button></div>' : ""),
      function (sheet) {
        var go = function (mock) {
          var err = sheet.querySelector("#sheetError");
          if (!sheet.querySelector("#dutyConsent").checked) { err.hidden = false; err.textContent = "Tick the consent box to start sharing."; return; }
          err.hidden = true;
          startDuty(mock);
        };
        sheet.querySelector("#dutyReal").addEventListener("click", function () { go(false); });
        var mock = sheet.querySelector("#dutyMock");
        if (mock) mock.addEventListener("click", function () { go(true); });
      }
    );
  }
  function stopDuty() {
    if (state.busy) return;
    state.busy = true;
    stopLocation();
    call("/api/rider/duty/stop", "POST", {})
      .then(function (result) {
        toast(result.ok ? "Location sharing stopped." : (result.data.error || "Could not confirm the stop."), result.ok ? "ok" : "err");
        deskLog("GPS duty stopped");
        return sync();
      })
      .catch(function (error) { toast(error.message, "err"); })
      .finally(function () { state.busy = false; });
  }

  /* --------------------------------------------------------------- render */
  function stepper(stage) {
    var current = STAGES.indexOf(stage);
    if (current < 0) current = stage === "issue" ? 1 : 0;
    return '<ol class="dl-steps">' + STAGES.map(function (s, i) {
      var cls = i < current ? "done" : i === current ? "current" : "";
      return '<li class="dl-step ' + cls + '"><div class="bubble">' + (i < current ? "✓" : "") + "</div><span>" + STAGE_LABEL[s] + "</span></li>";
    }).join("") + "</ol>";
  }
  function jobLinks(o, allowIssue) {
    var phone = digits(o.customer_phone), wa = waNumber(o.customer_phone);
    var query = o.address || o.area || "";
    return '<div class="dl-job-links">' +
      (phone ? '<a href="tel:' + esc(phone) + '">📞 Call</a>' : "") +
      (wa ? '<a href="https://wa.me/' + esc(wa) + '" target="_blank" rel="noopener noreferrer">💬 WhatsApp</a>' : "") +
      (query ? '<a href="https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(query) + '" target="_blank" rel="noopener noreferrer">🗺 Directions</a>' : "") +
      '<a href="#" data-detail="' + esc(o.id) + '">📋 Parcel</a>' +
      (allowIssue ? '<a href="#" data-issue="' + esc(o.id) + '">⚠ Problem</a>' : "") +
      "</div>";
  }
  function actionButtons(stage, id) {
    var p = function (label, next, cls) {
      return '<button type="button" class="dl-btn ' + (cls || "primary") + '" data-progress="' + esc(id) + '" data-stage="' + esc(next) + '">' + label + "</button>";
    };
    if (stage === "assigned")
      return p("Accept delivery ✓", "accepted") + '<button type="button" class="dl-btn danger" data-decline="' + esc(id) + '">Decline</button>';
    if (stage === "accepted") return p("Collected from store", "collected");
    if (stage === "collected") return p("Arrived at destination", "arrived") + p("Delivered", "delivered", "");
    if (stage === "arrived") return p("Confirm delivered ✓", "delivered");
    if (stage === "issue") return p("Resume delivery", "accepted") + p("Delivered", "delivered", "");
    return "";
  }
  function jobCard(o) {
    var stage = stageOf(o);
    var fresh = state.fresh.has(o.id) || stage === "assigned";
    return '<article class="dl-card dl-job ' + (fresh ? "is-new" : "") + '">' +
      '<div class="dl-job-head"><div><span class="dl-job-id">' + esc(o.id) + " · " + esc(timeAgo(o.created_at)) + "</span>" +
      "<h4>" + esc(o.customer_name || "Customer") + "</h4></div>" +
      '<span class="dl-chip ' + stageChip(stage) + '">' + esc(STAGE_LABEL[stage] || stage) + "</span></div>" +
      '<p class="dl-job-addr">📍 ' + esc(o.address || o.area || "Confirm the address with dispatch") + "</p>" +
      '<div class="dl-job-meta"><span class="dl-chip ' + (o.paid ? "green" : "amber") + '">' + (o.paid ? "✓ Paid" : "Payment pending") + "</span>" +
      '<span class="dl-chip slate">' + esc(o.area || "Kampala") + "</span>" +
      '<span class="dl-amount" style="margin-left:auto">UGX ' + money(o.total) + "</span></div>" +
      (o.notes ? '<p class="dl-job-note">📝 ' + esc(o.notes) + "</p>" : "") +
      stepper(stage) + jobLinks(o, stage !== "assigned") +
      '<div class="dl-job-actions">' + actionButtons(stage, o.id) + "</div></article>";
  }
  function statusCard() {
    var r = state.rider || {};
    var status = r.status || "Available";
    var initial = String(r.name || "R").charAt(0).toUpperCase();
    var tracking = state.tracking || {};
    var sharing = tracking.state === "live" || tracking.state === "simulated" || tracking.state === "waiting" || tracking.state === "stale";
    return '<div class="dl-card">' +
      '<div class="dl-profile-top"><div class="dl-avatar">' + esc(initial) + "</div><div style='min-width:0'>" +
      "<strong>" + esc(r.name || "Rider") + "</strong><small>" + esc(r.vehicle || "Motorbike (Boda)") +
      (r.plate ? " · " + esc(r.plate) : "") + (r.zone ? " · " + esc(r.zone) : "") + "</small></div></div>" +
      '<div class="dl-seg">' + ["Available", "On delivery", "Offline"].map(function (s) {
        return '<button type="button" data-status="' + esc(s) + '" aria-pressed="' + (s === status) + '">' + esc(s) + "</button>";
      }).join("") + "</div>" +
      '<div class="dl-duty"><span class="dl-duty-dot ' + (sharing ? "on" : "") + '"></span><div>' +
      "<strong>" + (sharing ? "Sharing location with dispatch" : "Location sharing is off") + "</strong>" +
      "<small>" + (state.gpsPolicy ? (sharing ? "Only your latest fix is kept. Stop whenever you like." : "Start a duty to share your position with dispatch.") :
        "Live tracking is not enabled by dispatch. Deliveries still work normally.") + "</small></div></div>" +
      '<div class="dl-btn-row">' + (sharing ?
        '<button type="button" class="dl-btn" data-duty="stop">■ Stop sharing</button>' :
        '<button type="button" class="dl-btn" data-duty="start"' + (state.gpsPolicy ? "" : " disabled") + '>▶ Start a duty</button>') +
      "</div></div>";
  }
  function renderJobs() {
    var orders = state.orders || [];
    var fresh = orders.filter(function (o) { return stageOf(o) === "assigned"; });
    var working = orders.filter(function (o) { return stageOf(o) !== "assigned"; });
    var html = statusCard();
    if (state.pending.length) {
      html += '<div class="dl-banner warn" style="border-radius:12px;margin-bottom:12px"><span class="dl-banner-ico">⏳</span><span>' +
        state.pending.length + " update" + (state.pending.length > 1 ? "s" : "") + " saved on this phone — waiting for a connection.</span></div>";
    }
    html += '<div class="dl-sec-head"><h3>Waiting for you · ' + fresh.length + "</h3><span>Accept or decline</span></div>";
    html += fresh.length ? fresh.map(jobCard).join("") :
      '<div class="dl-card dl-empty"><div class="dl-empty-ico">📭</div><strong>No new assignments</strong><p>When dispatch sends you a paid delivery it will appear here with an alert.</p></div>';
    if (working.length) {
      html += '<div class="dl-sec-head"><h3>On the way · ' + working.length + "</h3><span>Finish the steps</span></div>" + working.map(jobCard).join("");
    }
    html += '<p class="dl-muted" style="text-align:center;margin:18px 8px 0">Last checked ' +
      (state.lastSync ? esc(timeAgo(state.lastSync.toISOString())) : "just now") + " · refreshes automatically</p>";
    return html;
  }
  function renderActive() {
    var orders = state.orders || [];
    var current = orders.filter(function (o) { return ["accepted", "collected", "arrived", "issue"].indexOf(stageOf(o)) !== -1; })[0] ||
                  orders.filter(function (o) { return stageOf(o) === "assigned"; })[0];
    if (!current) {
      return '<div class="dl-card dl-empty" style="margin-top:26px"><div class="dl-empty-ico">🛵</div>' +
        "<strong>Nothing in progress</strong><p>Accept a job from the Jobs tab and its delivery steps will be pinned here.</p>" +
        '<button type="button" class="dl-btn primary" data-tab-jump="jobs" style="margin-top:14px">See my jobs</button></div>';
    }
    var stage = stageOf(current);
    var next = { assigned: "accepted", accepted: "collected", collected: "arrived", arrived: "delivered", issue: "accepted" }[stage];
    var label = { accepted: "Accept this delivery ✓", collected: "Collected from store", arrived: "Arrived at destination", delivered: "Confirm delivered ✓" }[next] || "Continue";
    return '<div class="dl-active-hero"><p class="dl-eyebrow-sm">IN PROGRESS · ' + esc(current.id) + "</p>" +
      "<h3>" + esc(current.customer_name || "Customer") + "</h3>" +
      "<p>📍 " + esc(current.address || current.area || "Confirm the address with dispatch") + "</p>" + stepper(stage) + "</div>" +
      '<div class="dl-card tight"><div class="dl-row"><span class="k">Order total</span><span class="v">UGX ' + money(current.total) + "</span></div>" +
      '<div class="dl-row"><span class="k">Delivery fee</span><span class="v">UGX ' + money(current.delivery_fee) + "</span></div>" +
      '<div class="dl-row"><span class="k">Payment</span><span class="v">' + (current.paid ? "✓ Paid already" : "Check with dispatch") + "</span></div>" +
      (current.notes ? '<p class="dl-job-note">📝 ' + esc(current.notes) + "</p>" : "") + jobLinks(current, stage !== "assigned") + "</div>" +
      '<button type="button" class="dl-btn primary dl-next" data-progress="' + esc(current.id) + '" data-stage="' + esc(next) + '">' + esc(label) + " <span>→</span></button>" +
      '<p class="dl-muted" style="text-align:center;margin:12px 8px 0">Each step is saved to dispatch. Delivering requires the recipient’s name.</p>';
  }
  function renderHistory() {
    var data = state.history;
    if (!data) {
      return '<div class="dl-card"><div class="dl-skeleton" style="width:60%;margin-bottom:12px"></div>' +
        '<div class="dl-skeleton" style="width:90%;margin-bottom:8px"></div><div class="dl-skeleton" style="width:75%"></div></div>';
    }
    var e = data.earnings || { today: 0, week: 0, all: 0, jobs: 0 };
    var html = '<div class="dl-card"><p class="dl-eyebrow-sm">DELIVERY FEES ON YOUR COMPLETED JOBS</p>' +
      '<h3 class="dl-h2">UGX ' + money(e.all) + "</h3>" +
      '<div class="dl-earn"><div><strong>' + money(e.today) + "</strong><small>Today</small></div>" +
      '<div><strong>' + money(e.week) + "</strong><small>7 days</small></div>" +
      '<div><strong>' + money(e.jobs) + "</strong><small>Jobs</small></div></div>" +
      '<p class="dl-muted" style="margin:11px 0 0">These are the delivery fees attached to orders you completed — an activity record, not a payout statement. Settlements are agreed with dispatch.</p></div>';
    var list = data.history || [];
    html += '<div class="dl-sec-head"><h3>Completed · ' + list.length + "</h3><span>Latest first</span></div>";
    html += list.length ? '<div class="dl-card">' + list.map(function (h) {
      return '<div class="dl-hist"><div class="dl-hist-ico">✓</div><div><strong>' + esc(h.customer_name) + " · " + esc(h.id) + "</strong>" +
        "<small>" + esc(fullTime(h.delivered_at)) + (h.received_by ? " · received by " + esc(h.received_by) : "") + " · " + esc(h.area || "Kampala") + "</small></div>" +
        '<span class="dl-hist-fee">+ ' + money(h.delivery_fee) + "</span></div>";
    }).join("") + "</div>" :
      '<div class="dl-card dl-empty"><div class="dl-empty-ico">🏁</div><strong>No completed deliveries yet</strong><p>Finish a delivery and it will be recorded here with the recipient’s name.</p></div>';
    return html;
  }
  function renderProfile() {
    var r = state.rider || {};
    var connected = state.connectedAt ? fullTime(state.connectedAt) : "this device";
    var rows = [
      ["🔔", "New order alerts", "Sound, banner and optional system pop-ups", "alerts"],
      ["⬇", "Install Adonai Delivery", "Add this app to your home screen", "install"],
      ["🗺", "Dispatch console", "See how assignments reach you", "dispatch"]
    ];
    if (state.demo) rows.push(["🧪", "Send me a demo order", "Preview a new assignment arriving", "demo"]);
    rows.push(["🏬", "Public storefront", "What the customer sees", "store"]);
    return '<div class="dl-card"><p class="dl-eyebrow-sm">SIGNED IN RIDER</p>' +
      '<div class="dl-profile-top"><div class="dl-avatar">' + esc(String(r.name || "R").charAt(0).toUpperCase()) + "</div><div>" +
      "<strong>" + esc(r.name || "Rider") + "</strong><small>" + esc(r.phone || "") + " · " + esc(r.status || "") + "</small></div></div>" +
      '<div class="dl-row" style="margin-top:12px"><span class="k">Device</span><span class="v">' + esc(state.label || "This phone") + "</span></div>" +
      '<div class="dl-row"><span class="k">Connected</span><span class="v">' + esc(connected) + "</span></div>" +
      '<div class="dl-row"><span class="k">Pending updates</span><span class="v">' + state.pending.length + "</span></div></div>" +
      '<div class="dl-card"><p class="dl-eyebrow-sm">APP &amp; TOOLS</p><div class="dl-list">' +
      rows.map(function (row) {
        return '<button type="button" data-profile="' + row[3] + '"><span class="ico">' + row[0] + "</span><span>" + esc(row[1]) +
          '<span class="note" style="display:block">' + esc(row[2]) + '</span></span><span class="arrow">›</span></button>';
      }).join("") + "</div></div>" +
      '<div class="dl-privacy"><strong>Your data, kept narrow.</strong><br />This app stores only its own device session on this phone. It shows the customer details of jobs assigned to you and nobody else. Location is off until you start a duty, and only your latest fix is kept — never a route history. Sign out on shared phones.</div>' +
      '<button type="button" class="dl-btn danger" data-profile="signout" style="width:100%;margin-top:14px">Sign out / replace this phone</button>' +
      '<p class="dl-muted" style="text-align:center;margin:16px 0 0">Adonai Delivery · rider partner app<br />Separate from the storefront and the cashier register</p>';
  }
  function renderDesk() {
    var pulse = $("deskPulse"), title = $("deskState"), sub = $("deskStateSub"), demo = $("deskDemo");
    if (!title) return;
    pulse.classList.toggle("on", !!state.token);
    if (state.token) {
      title.textContent = (state.rider && state.rider.name ? state.rider.name : "Rider") + " · connected";
      var fresh = (state.orders || []).filter(function (o) { return stageOf(o) === "assigned"; }).length;
      sub.textContent = (state.orders || []).length + " active job(s), " + fresh + " waiting for acceptance";
    } else {
      title.textContent = "Waiting for a rider to connect";
      sub.textContent = "The same screen is an installable phone app.";
    }
    demo.hidden = !(DEMO_PARAM || state.demo);
  }
  function render() {
    var connected = !!state.token;
    $("connectScreen").hidden = connected;
    $("appScreen").hidden = !connected;
    renderDesk();
    if (!connected) return;
    var r = state.rider;
    $("topRider").textContent = r && r.name ? r.name : "Rider";
    setOnline(state.online);
    var badge = $("tabBadge"), bell = $("bellBadge");
    var count = state.fresh.size;
    if (badge) { badge.hidden = !count; badge.textContent = count; }
    if (bell) { bell.hidden = !count; bell.textContent = count; }
    var host = $("bannerHost");
    host.innerHTML = count ? '<div class="dl-banner"><span class="dl-banner-ico">🔔</span><span>' +
      "<strong>" + (count === 1 ? "A new delivery is waiting." : count + " new deliveries are waiting.") + "</strong><br />Open Jobs to accept it." +
      '</span><button type="button" data-clear-banner>Dismiss</button></div>' : "";
    if (TABS.indexOf(state.tab) === -1) state.tab = "jobs";
    var html = state.tab === "jobs" ? renderJobs() : state.tab === "active" ? renderActive() :
               state.tab === "history" ? renderHistory() : renderProfile();
    var view = $("view"), top = view.scrollTop;
    view.innerHTML = html;
    view.scrollTop = top;
    global.document.querySelectorAll(".dl-tabs button").forEach(function (btn) {
      btn.classList.toggle("active", btn.getAttribute("data-tab") === state.tab);
    });
  }

  /* --------------------------------------------------------------- events */
  function goTab(tab, push) {
    if (TABS.indexOf(tab) === -1) return;
    state.tab = tab;
    $("view").scrollTop = 0;
    if (push !== false) { try { global.history.replaceState(null, "", "#" + tab); } catch (_) {} }
    if (tab === "history" && !state.history) loadHistory();
    render();
  }
  function signOut() {
    if (state.token) call("/api/rider/duty/stop", "POST", {}).catch(function () {});
    clearSession();
    state.pending = []; savePending();
    state.tab = "jobs";
    render();
    toast("Signed out. This phone no longer has a rider session.");
    deskLog("signed out");
  }
  function installApp() {
    if (state.installPrompt) {
      state.installPrompt.prompt();
      state.installPrompt.userChoice.then(function () { state.installPrompt = null; }).catch(function () {});
    } else {
      try { global.open("/delivery", "_blank", "noopener,noreferrer"); } catch (_) {}
      toast("Open /delivery, then use your browser’s “Add to Home screen / Install app” option.");
    }
  }
  function bind() {
    $("connectForm").addEventListener("submit", connect);
    $("advancedToggle").addEventListener("click", function () {
      var box = $("advancedBox"), open = box.hidden;
      box.hidden = !open;
      this.setAttribute("aria-expanded", String(open));
      this.textContent = open ? "Advanced · store server ▴" : "Advanced · store server ▾";
      if (open && !$("serverUrl").value) $("serverUrl").value = global.location.origin;
    });
    var demoFill = $("demoFill");
    if (demoFill) demoFill.addEventListener("click", function () {
      $("connectCode").value = "DEMORIDERS";
      $("connectCode").focus();
      toast("Demo code filled — tap Connect this phone.");
    });
    if (DEMO_PARAM) $("demoChip").hidden = false;

    global.document.querySelectorAll(".dl-tabs button").forEach(function (btn) {
      btn.addEventListener("click", function () { goTab(btn.getAttribute("data-tab")); });
    });
    $("bellBtn").addEventListener("click", openAlertsSheet);
    $("view").addEventListener("click", function (event) {
      var t = event.target;
      var detail = t.closest("[data-detail]");
      if (detail) { event.preventDefault(); openDetailSheet(detail.getAttribute("data-detail")); return; }
      var issue = t.closest("[data-issue]");
      if (issue) { event.preventDefault(); openIssueSheet(issue.getAttribute("data-issue")); return; }
      var decline = t.closest("[data-decline]");
      if (decline) { openDeclineSheet(decline.getAttribute("data-decline")); return; }
      var progress = t.closest("[data-progress]");
      if (progress) {
        var id = progress.getAttribute("data-progress"), stage = progress.getAttribute("data-stage");
        var order = (state.orders || []).filter(function (o) { return o.id === id; })[0];
        openProgressSheet(id, stage, order && order.customer_name);
        return;
      }
      var status = t.closest("[data-status]");
      if (status) { doStatus(status.getAttribute("data-status")); return; }
      var duty = t.closest("[data-duty]");
      if (duty) { if (duty.getAttribute("data-duty") === "start") openDutySheet(); else stopDuty(); return; }
      var profile = t.closest("[data-profile]");
      if (profile) {
        var action = profile.getAttribute("data-profile");
        if (action === "alerts") openAlertsSheet();
        else if (action === "install") installApp();
        else if (action === "dispatch") global.open("admin.html?view=dispatch", "_blank", "noopener,noreferrer");
        else if (action === "store") global.open("index.html", "_blank", "noopener,noreferrer");
        else if (action === "demo") demoOrder();
        else if (action === "signout") signOut();
        return;
      }
      var jump = t.closest("[data-tab-jump]");
      if (jump) goTab(jump.getAttribute("data-tab-jump"));
    });
    $("bannerHost").addEventListener("click", function (event) {
      if (event.target.closest("[data-clear-banner]")) { state.fresh.clear(); render(); }
    });
    global.document.addEventListener("keydown", function (event) {
      if (event.key === "Escape" && !$("sheetHost").hidden) closeSheet();
    });
    global.addEventListener("online", function () { setOnline(true); if (state.token) sync(); });
    global.addEventListener("offline", function () { setOnline(false); });
    global.addEventListener("hashchange", function () {
      var tab = global.location.hash.replace("#", "");
      if (TABS.indexOf(tab) !== -1 && tab !== state.tab) goTab(tab, false);
    });
    global.addEventListener("beforeinstallprompt", function (event) {
      event.preventDefault(); state.installPrompt = event;
    });
    var deskNew = $("deskNewOrder"), deskInstall = $("deskInstall");
    if (deskNew) deskNew.addEventListener("click", demoOrder);
    if (deskInstall) deskInstall.addEventListener("click", installApp);
  }

  /* ----------------------------------------------------------------- boot */
  function registerWorker() {
    if (!("serviceWorker" in global.navigator)) return;
    if (global.top !== global.self) return;                 // never inside a preview iframe
    if (global.location.pathname.replace(/\/+$/, "") !== "/delivery") return;
    global.navigator.serviceWorker.register("/sw-delivery.js", { scope: "/delivery" }).catch(function () {});
  }
  function bootstrapDemo() {
    // The public capability flag carries no secret. It only tells this UI that
    // the server is a local review sandbox, so the demo code can be offered.
    return call("/api/rider/demo-status")
      .then(function (result) {
        if (!result.ok || !result.data.demo) return;
        state.demo = true;
        var chip = $("demoChip");
        if (chip) chip.hidden = false;
        renderDesk();
        if (!state.token && !$("connectCode").value) $("connectCode").value = "DEMORIDERS";
        deskLog("local demo mode · code DEMORIDERS ready");
      })
      .catch(function () {});
  }
  var booted = false;
  function boot() {
    if (booted) return;
    booted = true;
    bind();
    var saved = readJSON(SESSION_KEY, {});
    if (saved && saved.token) {
      state.token = saved.token;
      state.base = saved.base || global.location.origin;
      state.label = saved.label || "";
      state.connectedAt = saved.connectedAt || null;
      state.rider = saved.rider || null;
    }
    var tab = global.location.hash.replace("#", "");
    if (TABS.indexOf(tab) !== -1) state.tab = tab;
    render();
    bootstrapDemo();
    if (state.token) {
      sync();
      if (state.tab === "history") loadHistory();
    } else if (DEMO_PARAM) {
      $("connectCode").value = "DEMORIDERS";
      deskLog("demo mode · code DEMORIDERS ready");
    }
    global.setInterval(function () {
      if (!global.document.hidden && state.token) sync();
    }, 12000);
    global.document.addEventListener("visibilitychange", function () {
      if (!global.document.hidden && state.token) sync();
    });
    registerWorker();
  }
  if (global.document.readyState === "loading") global.document.addEventListener("DOMContentLoaded", boot);
  else boot();
})(window);
