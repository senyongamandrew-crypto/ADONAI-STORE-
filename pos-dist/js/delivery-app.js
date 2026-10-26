/* =====================================================================
   Adonai Delivery — rider partner application
   ---------------------------------------------------------------------
   A third, standalone entity in the Adonai system:
     storefront  -> shopper
     pos/admin   -> cashier & dispatcher
     delivery    -> the rider partner (this app)
   A rider moves through four stages, enforced by the server and mirrored
   here so the screen always matches what dispatch will accept:
     1. sign in / create account (phone + password)     -> account token
     2. daily check-in: selfie + drawn signature        -> one per Kampala day
     3. dispatch's one-time App code                    -> device token, linked rider
     4. the job inbox: assigned orders, one-tap accept
   Everything displayed comes from /api/rider-account/* and /api/rider/* on
   this server. The app never reads the cashier session, the shopper's cart,
   or another rider's customer details.
   ===================================================================== */
(function (global) {
  "use strict";

  var $ = function (id) { return global.document.getElementById(id); };
  var esc = function (value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  };
  var ACCOUNT_KEY = "adonai.delivery.account.v1";
  var SESSION_KEY = "adonai.delivery.session.v1";
  var PENDING_KEY = "adonai.delivery.pending.v1";
  var DEMO_PARAM = new URLSearchParams(global.location.search).get("demo") === "1";
  var STEPS = ["signin", "checkin", "connect"];
  var SELFIE_MAX_BYTES = 300 * 1024;
  var SIGNATURE_MAX_BYTES = 120 * 1024;
  var STAGES = ["assigned", "accepted", "collected", "arrived", "delivered"];
  var STAGE_LABEL = {
    assigned: "Assigned", accepted: "Accepted", collected: "Collected",
    arrived: "Arrived", delivered: "Delivered", issue: "Problem", declined: "Declined"
  };
  var TABS = ["jobs", "active", "history", "profile"];
  var DECLINE_REASONS = ["Too far for this trip", "Vehicle problem", "Customer unreachable", "Finishing another job", "Other"];
  var ISSUE_HINTS = ["Customer not answering", "Address is unclear", "Heavy traffic delay", "Parcel needs checking"];
  var NO_SESSION_PATHS = ["/api/rider-account/login", "/api/rider-account/signup"];
  var LIVE_STORE_ORIGIN = "https://www.adonaithrift-store.online";

  /* The API base. On the web/PWA this page is served by the store server, so
   * the API is same-origin. Inside the Adonai Delivery Android APK the page
   * is served from the app-assets host instead, which is not a server at
   * all: default to the live store origin there. The rider can still point
   * the app elsewhere under "Advanced · store server", and a saved choice
   * always wins over the default. */
  function defaultBase() {
    return global.location.hostname === "appassets.androidplatform.net"
      ? LIVE_STORE_ORIGIN
      : global.location.origin;
  }
  function sanitizeBase(base) {
    // An app-assets origin saved by an older build can never reach the API.
    return typeof base === "string" && base.indexOf("appassets.androidplatform.net") !== -1
      ? defaultBase()
      : base;
  }

  function readJSON(key, fallback) {
    try { return JSON.parse(global.localStorage.getItem(key) || "null") || fallback; }
    catch (_) { return fallback; }
  }
  function writeJSON(key, value) {
    try { global.localStorage.setItem(key, JSON.stringify(value)); } catch (_) {}
  }
  function removeKey(key) {
    try { global.localStorage.removeItem(key); } catch (_) {}
  }

  var state = {
    accountToken: "", account: null, attendance: null, day: "", authMode: "signin",
    token: "", deviceAccountId: "", label: "", connectedAt: null, base: defaultBase(),
    rider: null, orders: [], tracking: null, history: null, gate: { required: false, checkedIn: true },
    gpsPolicy: false, demo: false, online: global.navigator.onLine !== false,
    tab: "jobs", known: new Set(), fresh: new Set(), pending: readJSON(PENDING_KEY, []),
    busy: false, syncing: false, detail: {}, watchId: null, mockTimer: null, seq: 0,
    installPrompt: null, lastSync: null, checkinOverlay: false, selfie: null
  };
  var ink = false;          // the signature pad has at least one stroke
  var drawing = false;
  var last = null;

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
  function formatPhone(phone) {
    var d = String(phone || "").replace(/\D/g, "");
    if (/^2567\d{8}$/.test(d)) return "+256 " + d.slice(3, 6) + " " + d.slice(6, 9) + " " + d.slice(9);
    return phone || "";
  }
  function stageOf(order) { return (order && order.progress && order.progress.stage) || "assigned"; }
  function stageChip(stage) {
    if (stage === "assigned") return "lime";
    if (stage === "delivered") return "green";
    if (stage === "issue" || stage === "declined") return "red";
    return "slate";
  }
  function currentStage() {
    if (!state.accountToken) return "signin";
    if (!state.token) return state.attendance ? "connect" : "checkin";
    return "app";
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
  function dataUrlBytes(url) {
    var comma = String(url).indexOf(",");
    var payload = String(url).slice(comma + 1);
    var padding = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0;
    return Math.ceil(payload.length * 3 / 4) - padding;
  }

  /* ------------------------------------------------------------------ api */
  function call(path, method, body, opts) {
    opts = opts || {};
    method = method || "GET";
    var token = opts.anon ? "" : opts.account ? state.accountToken : state.token;
    var controller = typeof AbortController === "function" ? new AbortController() : null;
    var timer = controller ? global.setTimeout(function () { controller.abort(); }, 16000) : null;
    var headers = { "Content-Type": "application/json" };
    if (token) headers.Authorization = "Bearer " + token;
    return global.fetch(state.base + path, {
      method: method, headers: headers, cache: "no-store",
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller ? controller.signal : undefined
    }).then(function (response) {
      return response.json().catch(function () { return {}; }).then(function (data) {
        return { status: response.status, ok: response.ok && (data || {}).ok !== false, data: data || {} };
      });
    }).then(function (result) {
      setOnline(true);
      if (result.status === 401 && NO_SESSION_PATHS.indexOf(path) === -1) return handleUnauthorized(path, opts, result);
      return result;
    }).catch(function (error) {
      if (error && error.name === "AbortError") throw new Error("The server took too long. Check your connection and try again.");
      // Browsers reject a dead network with a TypeError, a DOMException or a
      // bare "Failed to fetch" depending on the engine. Treat them all as
      // offline so a delivery update can be queued instead of lost.
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

  function handleUnauthorized(path, opts, result) {
    if (opts.account) {
      expireAccount("Your sign-in expired. Sign in again.");
      return { status: 401, ok: false, data: { ok: false, error: "Your sign-in expired. Sign in again." } };
    }
    if (path.indexOf("/api/rider/") === 0 && path !== "/api/rider/demo-status") {
      var message = "This phone's connection expired. Enter a new App code from dispatch.";
      expireDevice(message);
      return { status: 401, ok: false, data: { ok: false, error: message } };
    }
    return result;
  }

  /* -------------------------------------------------------------- storage */
  function saveAccount() {
    writeJSON(ACCOUNT_KEY, {
      token: state.accountToken, account: state.account, attendance: state.attendance,
      day: state.day, base: state.base
    });
  }
  function saveDevice() {
    writeJSON(SESSION_KEY, {
      token: state.token, base: state.base, label: state.label, connectedAt: state.connectedAt,
      rider: state.rider, accountId: state.deviceAccountId
    });
  }
  function clearDevice() {
    state.token = ""; state.deviceAccountId = ""; state.rider = null; state.orders = []; state.history = null;
    state.known = new Set(); state.fresh = new Set(); state.detail = {}; state.gate = { required: false, checkedIn: true };
    removeKey(SESSION_KEY);
    stopLocation();
  }
  function clearAccount() {
    state.accountToken = ""; state.account = null; state.attendance = null; state.day = "";
    state.checkinOverlay = false; state.selfie = null; state.tab = "jobs";
    clearDevice();
    state.pending = []; writeJSON(PENDING_KEY, state.pending);
    removeKey(ACCOUNT_KEY);
  }
  function savePending() { writeJSON(PENDING_KEY, state.pending); }

  function expireAccount(message) {
    clearAccount();
    render();
    showAuthError(message);
  }
  function expireDevice(message) {
    clearDevice();
    render();
    showConnectError(message);
  }

  /* ------------------------------------------------------ account sign-in */
  function paintAuthMode() {
    var signup = state.authMode === "signup";
    document.querySelectorAll("[data-auth]").forEach(function (btn) {
      btn.setAttribute("aria-pressed", String(btn.getAttribute("data-auth") === state.authMode));
    });
    $("nameField").hidden = !signup;
    $("authName").required = signup;
    $("authBtn").innerHTML = (signup ? "Create account" : "Sign in") + " <span>→</span>";
    $("passwordHint").textContent = signup ? "At least 8 characters. Keep it private." : "Your password for this app.";
    $("authPassword").setAttribute("autocomplete", signup ? "new-password" : "current-password");
  }
  function setAuthMode(mode) {
    state.authMode = mode === "signup" ? "signup" : "signin";
    paintAuthMode();
    showAuthError("");
  }
  function readServer() {
    var raw = ($("serverUrl").value || "").trim().replace(/\/+$/, "");
    return sanitizeBase(raw) || defaultBase();
  }
  function showAuthError(text) {
    var box = $("authError");
    if (!box) return;
    box.hidden = !text;
    box.textContent = text || "";
  }
  function submitAuth(event) {
    event.preventDefault();
    if (state.busy) return;
    var signup = state.authMode === "signup";
    var phone = $("authPhone").value.trim();
    var password = $("authPassword").value;
    var name = $("authName").value.trim();
    if (signup && !name) return showAuthError("Enter your full name.");
    if (!phone) return showAuthError("Enter your mobile number.");
    if (!password) return showAuthError("Enter your password.");
    if (signup && password.length < 8) return showAuthError("Choose a password of at least 8 characters.");
    state.base = readServer();
    state.busy = true;
    showAuthError("");
    $("authBtn").disabled = true;
    var body = signup ? { name: name, phone: phone, password: password } : { phone: phone, password: password };
    call(signup ? "/api/rider-account/signup" : "/api/rider-account/login", "POST", body, { anon: true })
      .then(function (result) {
        if (!result.ok) { showAuthError(result.data.error || "Could not sign you in. Try again."); return null; }
        state.accountToken = result.data.session_token;
        state.account = result.data.account || null;
        state.attendance = null;
        $("authPassword").value = "";
        saveAccount();
        return refreshAccount().then(function () {
          render();
          toast(signup ? "Account created. Next: check in for today." : "Signed in. Next: check in for today.", "ok");
          deskLog((signup ? "account created" : "signed in") + " · " + formatPhone(state.account && state.account.phone));
          if (currentStage() === "app") return sync();
        });
      })
      .catch(function (error) { showAuthError(error.message || "Could not reach dispatch."); })
      .finally(function () { state.busy = false; $("authBtn").disabled = false; });
  }
  function refreshAccount() {
    if (!state.accountToken) return Promise.resolve();
    return call("/api/rider-account/me", "GET", undefined, { account: true }).then(function (result) {
      if (result.ok) applyAccount(result.data);
    }).catch(function () {});
  }
  function applyAccount(data) {
    state.account = data.account || state.account;
    state.attendance = data.attendance || null;
    state.day = data.day || state.day;
    // A device session only belongs to the account that linked it.
    if (state.token && (!state.account || state.deviceAccountId !== state.account.id)) clearDevice();
    saveAccount();
  }
  function signOutAccount() {
    if (state.busy) return;
    var go = state.accountToken ? call("/api/rider-account/logout", "POST", {}, { account: true }) : Promise.resolve();
    go.catch(function () {}).then(function () {
      clearAccount();
      render();
      toast("Signed out. This phone no longer has a rider session.");
      deskLog("signed out");
    });
  }

  /* ------------------------------------------------------- daily check-in */
  function openCheckinOverlay(message) {
    state.checkinOverlay = true;
    render();
    showCheckinError(message || "");
  }
  function closeCheckinOverlay() {
    state.checkinOverlay = false;
    clearCheckinForm();
    render();
  }
  function showCheckinError(text) {
    var box = $("checkinError");
    if (!box) return;
    box.hidden = !text;
    box.textContent = text || "";
  }
  function clearCheckinForm() {
    state.selfie = null;
    var img = $("selfiePreview");
    if (img) { img.removeAttribute("src"); img.hidden = true; }
    $("selfieEmpty").hidden = false;
    $("selfieInput").value = "";
    $("checkinConsent").checked = false;
    clearSignature();
  }
  function prepareSelfie(file) {
    return new Promise(function (resolve, reject) {
      if (!file || !/^image\//.test(file.type || "image/x")) return reject(new Error("Choose a photo file."));
      var url = global.URL.createObjectURL(file);
      var img = new global.Image();
      img.onload = function () {
        try {
          var w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
          if (!w || !h) throw new Error("That picture could not be read. Take it again.");
          var canvas = global.document.createElement("canvas");
          var scale = Math.min(1, 800 / Math.max(w, h));
          canvas.width = Math.max(1, Math.round(w * scale));
          canvas.height = Math.max(1, Math.round(h * scale));
          var ctx = canvas.getContext("2d");
          if (!ctx) throw new Error("This browser cannot prepare the photo. Try another browser.");
          ctx.fillStyle = "#FFFFFF";
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          var qualities = [0.86, 0.76, 0.66, 0.56, 0.46, 0.36];
          for (var i = 0; i < qualities.length; i++) {
            var candidate = canvas.toDataURL("image/jpeg", qualities[i]);
            if (candidate.indexOf("data:image/jpeg") !== 0) throw new Error("This browser cannot save a JPEG photo.");
            if (dataUrlBytes(candidate) <= SELFIE_MAX_BYTES) return resolve(candidate);
          }
          throw new Error("That photo is too large even when compressed. Take it again.");
        } catch (error) {
          reject(error);
        } finally {
          global.URL.revokeObjectURL(url);
        }
      };
      img.onerror = function () {
        global.URL.revokeObjectURL(url);
        reject(new Error("That picture could not be read. Take it again."));
      };
      img.src = url;
    });
  }
  function onSelfieChosen() {
    var input = $("selfieInput");
    var file = input.files && input.files[0];
    if (!file) return;
    showCheckinError("");
    prepareSelfie(file).then(function (dataUrl) {
      state.selfie = dataUrl;
      var img = $("selfiePreview");
      img.src = dataUrl;
      img.hidden = false;
      $("selfieEmpty").hidden = true;
    }).catch(function (error) {
      state.selfie = null;
      showCheckinError(error.message);
    }).finally(function () { input.value = ""; });
  }
  function initSignPad() {
    var canvas = $("signPad");
    if (!canvas) return;
    $("signClear").addEventListener("click", clearSignature);
    var ctx = canvas.getContext ? canvas.getContext("2d") : null;
    clearSignature();
    if (!ctx) return;
    function point(event) {
      var rect = canvas.getBoundingClientRect();
      var sx = rect.width ? canvas.width / rect.width : 1;
      var sy = rect.height ? canvas.height / rect.height : 1;
      return { x: ((event.clientX || 0) - rect.left) * sx, y: ((event.clientY || 0) - rect.top) * sy };
    }
    canvas.addEventListener("pointerdown", function (event) {
      drawing = true;
      last = point(event);
      ctx.fillStyle = "#0B1F16";
      ctx.beginPath();
      ctx.arc(last.x, last.y, 2.2, 0, Math.PI * 2);
      ctx.fill();
      ink = true;
      try { canvas.setPointerCapture(event.pointerId); } catch (_) {}
      event.preventDefault();
    });
    canvas.addEventListener("pointermove", function (event) {
      if (!drawing) return;
      var p = point(event);
      ctx.strokeStyle = "#0B1F16";
      ctx.lineWidth = 3.4;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.beginPath();
      ctx.moveTo(last.x, last.y);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
      last = p;
      event.preventDefault();
    });
    ["pointerup", "pointerleave", "pointercancel"].forEach(function (type) {
      canvas.addEventListener(type, function () { drawing = false; });
    });
  }
  function clearSignature() {
    var canvas = $("signPad");
    ink = false;
    drawing = false;
    if (!canvas || !canvas.getContext) return;
    var ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.fillStyle = "#FFFFFF";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  function signatureDataUrl() {
    if (!ink) return null;
    var url = $("signPad").toDataURL("image/png");
    if (url.indexOf("data:image/png") !== 0) throw new Error("This browser cannot save the signature. Try another browser.");
    if (dataUrlBytes(url) > SIGNATURE_MAX_BYTES) throw new Error("The signature is too large. Sign more simply and try again.");
    return url;
  }
  function submitCheckin(event) {
    event.preventDefault();
    if (state.busy) return;
    showCheckinError("");
    if (!state.selfie) return showCheckinError("Take a selfie first.");
    var signature;
    try { signature = signatureDataUrl(); } catch (error) { return showCheckinError(error.message); }
    if (!signature) return showCheckinError("Sign in the box to confirm your attendance.");
    if (!$("checkinConsent").checked) return showCheckinError("Tick the consent box to check in.");
    state.busy = true;
    $("checkinBtn").disabled = true;
    call("/api/rider-account/attendance", "POST", {
      consent: true, selfie: state.selfie, signature: signature, device_label: "Adonai Delivery phone"
    }, { account: true }).then(function (result) {
      if (!result.ok) return showCheckinError(result.data.error || "Could not save your check-in. Try again.");
      state.attendance = result.data.attendance || null;
      state.day = (state.attendance && state.attendance.day) || state.day;
      saveAccount();
      clearCheckinForm();
      toast(result.data.already ? "You are already checked in for today." : "Checked in for today. Thank you.", "ok");
      deskLog("attendance · checked in");
      if (state.checkinOverlay) {
        state.checkinOverlay = false;
        render();
        return sync();
      }
      render();
    }).catch(function (error) { showCheckinError(error.message); })
      .finally(function () { state.busy = false; $("checkinBtn").disabled = false; });
  }

  /* ----------------------------------------------------- connect to dispatch */
  function showConnectError(text) {
    var box = $("connectError");
    if (!box) return;
    box.hidden = !text;
    box.textContent = text || "";
  }
  function submitConnect(event) {
    event.preventDefault();
    if (state.busy) return;
    var code = $("connectCode").value.trim();
    var label = $("deviceLabel").value.trim() || "My delivery phone";
    if (!code) return showConnectError("Enter the connection code from dispatch.");
    state.busy = true;
    showConnectError("");
    $("connectBtn").disabled = true;
    call("/api/rider-account/connect", "POST", { code: code, device_label: label }, { account: true })
      .then(function (result) {
        if (!result.ok) {
          if (result.data.code === "ATTENDANCE_REQUIRED") {
            state.attendance = null;
            saveAccount();
            render();
            toast("Check in for today first.", "err");
            return null;
          }
          showConnectError(result.data.error || "Could not connect this phone. Check the code and try again.");
          return null;
        }
        state.token = result.data.session_token;
        state.rider = result.data.rider || null;
        state.label = label;
        state.deviceAccountId = state.account ? state.account.id : "";
        state.connectedAt = new Date().toISOString();
        state.gpsPolicy = !!result.data.gps_policy;
        state.demo = !!result.data.demo;
        state.known = new Set(); state.fresh = new Set();
        if (state.account) state.account.linked = true;
        saveDevice();
        saveAccount();
        $("connectCode").value = "";
        render();
        toast("Connected. Loading your assigned deliveries.", "ok");
        deskLog("phone linked" + (state.rider ? " · " + state.rider.name : ""));
        return sync();
      })
      .catch(function (error) { showConnectError(error.message || "Could not reach dispatch."); })
      .finally(function () { state.busy = false; $("connectBtn").disabled = false; });
  }
  function unlinkPhone() {
    if (state.busy) return;
    var stop = state.token ? call("/api/rider/duty/stop", "POST", {}) : Promise.resolve();
    stop.catch(function () {}).then(function () {
      clearDevice();
      state.tab = "jobs";
      render();
      toast("This phone is unlinked. Enter a new App code from dispatch to reconnect.");
      deskLog("phone unlinked");
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
    state.fresh.forEach(function (id) { if (!ids.has(id)) state.fresh.delete(id); });
  }
  function flushPending() {
    if (!state.pending.length || !state.online || !state.token) return Promise.resolve();
    var queue = state.pending.slice();
    return queue.reduce(function (chain, item) {
      return chain.then(function () {
        return call(item.path, "POST", item.body).then(function (result) {
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
        if (!result.ok) {
          if (result.status === 401) return null;
          throw new Error(result.data.error || "Could not load your deliveries.");
        }
        var data = result.data;
        state.rider = data.rider || state.rider;
        state.tracking = data.tracking || null;
        state.gpsPolicy = !!data.gps_policy;
        state.demo = !!data.demo;
        state.gate = { required: !!data.attendance_required, checkedIn: data.checked_in_today !== false };
        state.orders = data.orders || [];
        state.lastSync = new Date();
        ingest(state.orders);
        saveDevice();
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
  function acceptJob(orderId) {
    if (state.gate.required && !state.gate.checkedIn) {
      return openCheckinOverlay("Check in for today before you accept deliveries. It takes under a minute.");
    }
    return doProgress(orderId, "accepted", {});
  }
  function doProgress(orderId, stage, extra) {
    if (state.busy) return;
    state.busy = true;
    var body = Object.assign({ stage: stage }, extra || {});
    return call("/api/rider/orders/" + encodeURIComponent(orderId) + "/progress", "POST", body)
      .then(function (result) {
        if (!result.ok) {
          if (result.data.code === "ATTENDANCE_REQUIRED") {
            state.gate = { required: true, checkedIn: false };
            closeSheet();
            return openCheckinOverlay(result.data.error);
          }
          toast(result.data.error || "That update could not be saved.", "err");
          return;
        }
        closeSheet();
        toast(stage === "delivered" ? "Delivery confirmed. Nice work!" : stage === "accepted" ? "Accepted. Head to the store to collect." : "Update saved · " + STAGE_LABEL[stage], "ok");
        deskLog(orderId + " → " + stage);
        if (stage === "delivered") loadHistory();
        return sync();
      })
      .catch(function (error) {
        if (/offline/i.test(error.message)) {
          queueProgress(orderId, stage, extra);
          closeSheet();
          toast("Saved on this phone. It will send when you are back online.", "ok");
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
        saveDevice();
        toast("You are now " + status + ".", "ok");
        deskLog("availability → " + status);
        render();
      })
      .catch(function (error) { toast(error.message, "err"); })
      .finally(function () { state.busy = false; });
  }
  function demoOrder() {
    if (!state.token) { toast("Link this phone first, then send a demo order."); return; }
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
      '<p class="dl-hint">Quick notes. Tap one or write your own:</p>' +
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
      '<div class="dl-consent"><strong style="font-size:14px">🔔</strong><label style="font-size:12px">New jobs also appear with a sound, a vibration and a banner inside this app. No browser permission needed. System pop-ups additionally work when the app is in the background.</label></div>' +
      '<p class="dl-hint">Current status: <strong>' + esc(label) + "</strong></p>" +
      '<div class="dl-btn-row"><button class="dl-btn" type="button" data-close>Close</button>' +
      (permission === "default" ? '<button class="dl-btn primary" type="button" id="sheetGo">Allow pop-ups</button>' : "") + "</div>",
      function (sheet) {
        var go = sheet.querySelector("#sheetGo");
        if (!go) return;
        go.addEventListener("click", function () {
          global.Notification.requestPermission().then(function (result) {
            closeSheet();
            toast(result === "granted" ? "Pop-ups are on for new deliveries." : "Pop-ups were not enabled. In-app alerts still work.", result === "granted" ? "ok" : "");
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
        toast(mock ? "Duty started. Sending simulated Kampala fixes." : "Duty started. Sharing your latest fix only.", "ok");
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
            toast("Location was not granted. Duty is active but dispatch will see no fix. Stop it or use a simulated duty.", "err");
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
      '<div class="dl-consent"><input id="dutyConsent" type="checkbox" /><label for="dutyConsent">I agree to share my phone\'s location with Adonai dispatch for this duty (max 12 hours). Only the latest fix is stored. No route history, no phone serial, no IMEI.</label></div>' +
      '<p class="dl-hint">On a real phone, use the device GPS. Simulated fixes are honestly labelled “simulated” on the dispatch map.</p>' +
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
    var current = ["assigned", "accepted", "collected", "arrived", "delivered"].indexOf(stage);
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
    var p = function (label, next, cls, extra) {
      return '<button type="button" class="dl-btn ' + (cls || "primary") + '" data-progress="' + esc(id) + '" data-stage="' + esc(next) + '"' + (extra || "") + ">" + label + "</button>";
    };
    if (stage === "assigned") {
      var blocked = state.gate.required && !state.gate.checkedIn;
      return p(blocked ? "Check in to accept" : "Accept ✓", "accepted", "primary big") +
        '<button type="button" class="dl-btn danger" data-decline="' + esc(id) + '">Decline</button>';
    }
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
        '<button type="button" class="dl-btn" data-duty="start"' + (state.gpsPolicy ? "" : " disabled") + ">▶ Start a duty</button>") +
      "</div></div>";
  }
  function checkinBanner() {
    if (!(state.gate.required && !state.gate.checkedIn)) return "";
    return '<div class="dl-checkin-card"><div><strong>Check in for today to accept jobs</strong>' +
      "<p>Take a selfie and sign once per day. It takes under a minute.</p></div>" +
      '<button type="button" class="dl-btn primary" data-open-checkin="1">Check in</button></div>';
  }
  function renderJobs() {
    var orders = state.orders || [];
    var fresh = orders.filter(function (o) { return stageOf(o) === "assigned"; });
    var working = orders.filter(function (o) { return stageOf(o) !== "assigned"; });
    var html = checkinBanner() + statusCard();
    if (state.pending.length) {
      html += '<div class="dl-banner warn" style="border-radius:12px;margin-bottom:12px"><span class="dl-banner-ico">⏳</span><span>' +
        state.pending.length + " update" + (state.pending.length > 1 ? "s" : "") + " saved on this phone, waiting for a connection.</span></div>";
    }
    html += '<div class="dl-sec-head"><h3>Waiting for you · ' + fresh.length + "</h3><span>Tap to accept</span></div>";
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
    var label = { assigned: "Accept delivery ✓", accepted: "Collected from store", collected: "Arrived at destination", arrived: "Confirm delivered ✓", issue: "Resume delivery" }[stage] || "Continue";
    if (stage === "assigned" && state.gate.required && !state.gate.checkedIn) label = "Check in to accept";
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
      "<div><strong>" + money(e.week) + "</strong><small>7 days</small></div>" +
      "<div><strong>" + money(e.jobs) + "</strong><small>Jobs</small></div></div>" +
      '<p class="dl-muted" style="margin:11px 0 0">These are the delivery fees attached to orders you completed. An activity record, not a payout statement. Settlements are agreed with dispatch.</p></div>';
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
    var a = state.account || {};
    var connected = state.connectedAt ? fullTime(state.connectedAt) : "this device";
    var checked = state.gate.required ? (state.gate.checkedIn ? "✓ Done today" : "Not yet today") : (state.attendance ? "✓ Done today" : "Not yet today");
    var rows = [
      ["🔔", "New order alerts", "Sound, banner and optional system pop-ups", "alerts"],
      ["⬇", "Install Adonai Delivery", "Add this app to your home screen", "install"],
      ["🗺", "Dispatch console", "See how assignments reach you", "dispatch"]
    ];
    if (state.demo) rows.push(["🧪", "Send me a demo order", "Preview a new assignment arriving", "demo"]);
    rows.push(["🏬", "Public storefront", "What the customer sees", "store"]);
    return '<div class="dl-card"><p class="dl-eyebrow-sm">SIGNED IN RIDER</p>' +
      '<div class="dl-profile-top"><div class="dl-avatar">' + esc(String(r.name || a.name || "R").charAt(0).toUpperCase()) + "</div><div>" +
      "<strong>" + esc(r.name || a.name || "Rider") + "</strong><small>" + esc(formatPhone(a.phone || r.phone || "")) + " · " + esc(r.status || "") + "</small></div></div>" +
      '<div class="dl-row" style="margin-top:12px"><span class="k">Today\'s check-in</span><span class="v">' + esc(checked) + "</span></div>" +
      '<div class="dl-row"><span class="k">Device</span><span class="v">' + esc(state.label || "This phone") + "</span></div>" +
      '<div class="dl-row"><span class="k">Linked</span><span class="v">' + esc(connected) + "</span></div>" +
      '<div class="dl-row"><span class="k">Pending updates</span><span class="v">' + state.pending.length + "</span></div></div>" +
      '<div class="dl-card"><p class="dl-eyebrow-sm">APP &amp; TOOLS</p><div class="dl-list">' +
      rows.map(function (row) {
        return '<button type="button" data-profile="' + row[3] + '"><span class="ico">' + row[0] + "</span><span>" + esc(row[1]) +
          '<span class="note" style="display:block">' + esc(row[2]) + '</span></span><span class="arrow">›</span></button>';
      }).join("") + "</div></div>" +
      '<div class="dl-privacy"><strong>Your data, kept narrow.</strong><br />This app stores only its own sign-in on this phone. It shows the customer details of jobs assigned to you and nobody else. Location is off until you start a duty, and only your latest fix is kept. Sign out on shared phones.</div>' +
      '<button type="button" class="dl-btn" data-profile="unpair" style="width:100%;margin-top:14px">Replace this phone (new App code)</button>' +
      '<button type="button" class="dl-btn danger" data-profile="signout" style="width:100%;margin-top:10px">Sign out of Adonai Delivery</button>' +
      '<p class="dl-muted" style="text-align:center;margin:16px 0 0">Adonai Delivery · rider partner app<br />Separate from the storefront and the cashier register</p>';
  }
  function renderDesk() {
    var pulse = $("deskPulse"), title = $("deskState"), sub = $("deskStateSub"), demo = $("deskDemo");
    if (!title) return;
    var stage = currentStage();
    pulse.classList.toggle("on", stage === "app");
    var name = (state.account && state.account.name) || (state.rider && state.rider.name) || "Rider";
    if (stage === "signin") {
      title.textContent = "Waiting for a rider to sign in";
      sub.textContent = "The same screen is an installable phone app.";
    } else if (stage === "checkin") {
      title.textContent = name + " · signed in";
      sub.textContent = "Next: a selfie and signature check-in for today.";
    } else if (stage === "connect") {
      title.textContent = name + " · checked in";
      sub.textContent = "Next: link this phone with the App code from dispatch.";
    } else {
      var fresh = (state.orders || []).filter(function (o) { return stageOf(o) === "assigned"; }).length;
      title.textContent = (state.rider && state.rider.name ? state.rider.name : "Rider") + " · connected";
      sub.textContent = (state.orders || []).length + " active job(s), " + fresh + " waiting for acceptance";
    }
    demo.hidden = !(DEMO_PARAM || state.demo);
  }
  function paintSteps(index) {
    document.querySelectorAll(".dl-onboard li[data-step]").forEach(function (item) {
      var pos = STEPS.indexOf(item.getAttribute("data-step"));
      var done = pos < index, current = pos === index;
      item.classList.toggle("done", done);
      item.classList.toggle("current", current);
      var badge = item.querySelector("span");
      if (badge) badge.textContent = done ? "✓" : String(pos + 1);
    });
  }
  function render() {
    var stage = currentStage();
    var screen = (stage === "app" && state.checkinOverlay) ? "checkin" : stage;
    $("authScreen").hidden = screen !== "signin";
    $("checkinScreen").hidden = screen !== "checkin";
    $("connectScreen").hidden = screen !== "connect";
    $("appScreen").hidden = screen !== "app";
    $("checkinBack").hidden = !(stage === "app" && state.checkinOverlay);
    $("checkinEyebrow").textContent = stage === "app" ? "TODAY'S CHECK-IN" : "STEP 2 OF 3 · TODAY'S CHECK-IN";
    paintSteps(screen === "app" ? 3 : STEPS.indexOf(screen));
    var demoChip = $("demoChip"), connectChip = $("connectDemoChip");
    if (demoChip) demoChip.hidden = !(DEMO_PARAM || state.demo) || stage !== "signin";
    if (connectChip) connectChip.hidden = !(DEMO_PARAM || state.demo) || stage !== "connect";
    renderDesk();
    if (screen === "signin") paintAuthMode();
    document.querySelectorAll("#checkinScreen .dl-onboard").forEach(function (list) { list.hidden = stage === "app"; });
    if (screen === "connect") {
      var a = state.account || {};
      $("connectName").textContent = a.name || "—";
      $("connectPhone").textContent = formatPhone(a.phone) || "—";
    }
    if (screen !== "app") return;

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
  function installApp() {
    if (state.installPrompt) {
      state.installPrompt.prompt();
      state.installPrompt.userChoice.then(function () { state.installPrompt = null; }).catch(function () {});
    } else {
      try { global.open("/delivery", "_blank", "noopener,noreferrer"); } catch (_) {}
      toast("Open /delivery, then use your browser’s “Add to Home screen / Install app” option.");
    }
  }
  function fillDemoSignIn() {
    setAuthMode("signin");
    $("authPhone").value = "0772555010";
    $("authPassword").value = "rider-demo-1";
    $("authPhone").focus();
    toast("Demo sign-in filled. Tap Sign in.");
  }
  function bind() {
    $("authForm").addEventListener("submit", submitAuth);
    document.querySelectorAll("[data-auth]").forEach(function (btn) {
      btn.addEventListener("click", function () { setAuthMode(btn.getAttribute("data-auth")); });
    });
    $("advancedToggle").addEventListener("click", function () {
      var box = $("advancedBox"), open = box.hidden;
      box.hidden = !open;
      this.setAttribute("aria-expanded", String(open));
      this.textContent = open ? "Advanced · store server ▴" : "Advanced · store server ▾";
      if (open && !$("serverUrl").value) $("serverUrl").value = state.base || defaultBase();
    });
    $("demoFill").addEventListener("click", fillDemoSignIn);
    $("checkinForm").addEventListener("submit", submitCheckin);
    $("selfieInput").addEventListener("change", onSelfieChosen);
    $("checkinBack").addEventListener("click", closeCheckinOverlay);
    $("connectForm").addEventListener("submit", submitConnect);
    $("connectDemoFill").addEventListener("click", function () {
      $("connectCode").value = "DEMORIDERS";
      $("connectCode").focus();
      toast("Demo code filled. Tap Connect this phone.");
    });
    $("connectSignOut").addEventListener("click", signOutAccount);

    global.document.querySelectorAll(".dl-tabs button").forEach(function (btn) {
      btn.addEventListener("click", function () { goTab(btn.getAttribute("data-tab")); });
    });
    $("bellBtn").addEventListener("click", openAlertsSheet);
    $("view").addEventListener("click", function (event) {
      var t = event.target;
      var openCheckin = t.closest("[data-open-checkin]");
      if (openCheckin) { event.preventDefault(); openCheckinOverlay(""); return; }
      var detail = t.closest("[data-detail]");
      if (detail) { event.preventDefault(); openDetailSheet(detail.getAttribute("data-detail")); return; }
      var issue = t.closest("[data-issue]");
      if (issue) { event.preventDefault(); openIssueSheet(issue.getAttribute("data-issue")); return; }
      var decline = t.closest("[data-decline]");
      if (decline) { openDeclineSheet(decline.getAttribute("data-decline")); return; }
      var progress = t.closest("[data-progress]");
      if (progress) {
        var id = progress.getAttribute("data-progress"), stage = progress.getAttribute("data-stage");
        if (stage === "accepted") return acceptJob(id);
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
        else if (action === "unpair") unlinkPhone();
        else if (action === "signout") signOutAccount();
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
    $("deskNewOrder").addEventListener("click", demoOrder);
    $("deskInstall").addEventListener("click", installApp);
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
    // the server is a local review sandbox, so the demo sign-in can be offered.
    return call("/api/rider/demo-status", "GET", undefined, { anon: true })
      .then(function (result) {
        if (!result.ok || !result.data.demo) return;
        state.demo = true;
        deskLog("local demo mode · sign-in 0772555010 ready");
        render();
        prefillDemo();
      })
      .catch(function () {});
  }
  function prefillDemo() {
    if (!(DEMO_PARAM || state.demo)) return;
    var stage = currentStage();
    if (stage === "signin" && !$("authPhone").value) {
      $("authPhone").value = "0772555010";
      $("authPassword").value = "rider-demo-1";
    }
    if (stage === "connect" && !$("connectCode").value) $("connectCode").value = "DEMORIDERS";
  }
  var booted = false;
  function boot() {
    if (booted) return;
    booted = true;
    bind();
    initSignPad();
    var acc = readJSON(ACCOUNT_KEY, null);
    if (acc && acc.token) {
      state.accountToken = acc.token;
      state.account = acc.account || null;
      state.attendance = acc.attendance || null;
      state.day = acc.day || "";
      if (acc.base) state.base = sanitizeBase(acc.base);
    }
    var saved = readJSON(SESSION_KEY, null);
    if (saved && saved.token && state.accountToken) {
      state.token = saved.token;
      state.base = sanitizeBase(saved.base) || state.base;
      state.label = saved.label || "";
      state.connectedAt = saved.connectedAt || null;
      state.rider = saved.rider || null;
      state.deviceAccountId = saved.accountId || "";
      if (!state.account || state.deviceAccountId !== state.account.id) clearDevice();
    } else if (saved && saved.token) {
      clearDevice();
    }
    var tab = global.location.hash.replace("#", "");
    if (TABS.indexOf(tab) !== -1) state.tab = tab;
    setAuthMode("signin");
    render();
    bootstrapDemo();
    refreshAccount().then(function () {
      render();
      prefillDemo();
      if (currentStage() === "app") {
        sync();
        if (state.tab === "history") loadHistory();
      }
    });
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
