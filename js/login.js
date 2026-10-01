/* ============ Adonai — Staff & POS Terminal Login Logic ============ */
(function () {
  "use strict";
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));

  const params = new URLSearchParams(location.search);

  function safeNext(rawTarget) {
    const fallback = "pos.html";
    try {
      const target = new URL(rawTarget || fallback, location.href);
      if (target.origin !== location.origin) return fallback;
      const filename = target.pathname.split("/").pop();
      if (!["pos.html", "admin.html"].includes(filename)) return fallback;
      return filename + target.search + target.hash;
    } catch (e) {
      return fallback;
    }
  }

  const next = safeNext(params.get("next"));

  const sessionPane = $("#sessionPane");
  const openPane = $("#openPane");
  const authPane = $("#authPane");
  const pinDisplay = $("#pinDisplay");
  const pinHint = $("#pinHint");
  const keypad = $("#keypad");
  const textKeyInput = $("#textKeyInput");
  const keyInputWrap = $("#keyInputWrap");

  let pin = "";
  let inFlight = false;
  let activeTab = "pin"; // 'pin' or 'key'

  /* ---- 1. Render Active Session if Authenticated ---- */
  const activeMe = Auth.me();
  if (activeMe) {
    sessionPane.hidden = false;
    $("#sessName").textContent = activeMe.name || "Staff Member";
    $("#sessRole").textContent = (activeMe.role || "staff").toUpperCase();
    $("#sessAvatar").textContent = (activeMe.name || "S").charAt(0).toUpperCase();

    const btnSessPos = $("#btnSessPos");
    if (btnSessPos) btnSessPos.href = "pos.html";

    const btnSessAdmin = $("#btnSessAdmin");
    if (btnSessAdmin) {
      // The operations console is available to authenticated terminal staff;
      // protected mutations still require the secondary Admin Master Key.
      btnSessAdmin.hidden = false;
      btnSessAdmin.href = next.includes("admin.html") ? next : "admin.html?view=overview";
    }

    $("#btnSessSignOut").addEventListener("click", () => {
      Auth.signOut();
      sessionPane.hidden = true;
      toastHint("Signed out. Please enter a Staff Terminal Key to log in.", false);
    });
  }

  /* ---- 2. Render Open Access Notice if Lock is OFF ---- */
  const locked = Auth.locked();
  if (!locked) {
    openPane.hidden = false;
    $("#goPos").href = "pos.html";
    $("#goAdmin").href = "admin.html";
  }

  /* ---- 3. Mode Tabs (Touch PIN vs Alphanumeric Key) ---- */
  const tabPin = $("#tabPin");
  const tabKey = $("#tabKey");
  const viewPin = $("#viewPin");
  const viewKey = $("#viewKey");

  function switchTab(mode) {
    activeTab = mode;
    if (mode === "pin") {
      tabPin.classList.add("active");
      tabKey.classList.remove("active");
      viewPin.hidden = false;
      viewKey.hidden = true;
      drawPin();
    } else {
      tabKey.classList.add("active");
      tabPin.classList.remove("active");
      viewPin.hidden = true;
      viewKey.hidden = false;
      if (textKeyInput) {
        textKeyInput.focus();
        if (pin && !textKeyInput.value) textKeyInput.value = pin;
      }
    }
  }

  tabPin.addEventListener("click", () => switchTab("pin"));
  tabKey.addEventListener("click", () => switchTab("key"));

  /* ---- 4. PIN Keypad Setup ---- */
  const keys = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "C", "0", "⌫"];
  keypad.innerHTML = keys.map(k =>
    `<button class="key ${isNaN(Number(k)) ? "fn" : ""}" data-k="${k}" type="button">${k}</button>`
  ).join("");

  function drawPin() {
    if (pin.length > 0) {
      pinDisplay.innerHTML = "•".repeat(pin.length);
      pinDisplay.classList.remove("error", "success");
    } else {
      pinDisplay.innerHTML = `<span class="ph">Enter PIN</span>`;
    }
  }

  function toastHint(msg, isError = false, isSuccess = false) {
    pinHint.textContent = msg;
    pinHint.className = "hint" + (isError ? " error-msg" : (isSuccess ? " success-msg" : ""));
  }

  function fail(msg) {
    pinDisplay.classList.add("error");
    if (keyInputWrap) keyInputWrap.classList.add("error");
    toastHint(msg || "Invalid Staff Terminal Key or PIN — try again", true);
    setTimeout(() => {
      pinDisplay.classList.remove("error");
      if (keyInputWrap) keyInputWrap.classList.remove("error");
    }, 450);
  }

  function enter(staff) {
    Auth.signIn(staff);
    pinDisplay.classList.add("success");
    toastHint(`✓ Verified: ${staff.name} (${staff.role.toUpperCase()}) — loading terminal...`, false, true);

    setTimeout(() => {
      // Return every verified terminal user to the exact drawer destination that
      // requested authentication (including ?view=...). Administrative changes
      // inside that screen remain Master-Key protected.
      location.replace(next);
    }, 350);
  }

  /* ---- 5. Verification Logic (Client DB + Render Backend / Environment) ---- */
  function submitCandidate(candidate, explicit = false) {
    const key = String(candidate || "").trim();
    if (!key) {
      if (explicit) fail("Please enter a Staff Terminal Key or PIN");
      return;
    }

    // 1. Try local DB PIN match
    const localStaff = DB.verifyPin(key);
    if (localStaff) {
      enter(localStaff);
      return;
    }

    // 2. Try local Master Key match
    if (DB.verifyMasterKey(key)) {
      enter({ id: "LOCAL-ADMIN", name: "Store Admin (Master Key)", role: "admin" });
      return;
    }

    // 3. Verify against backend /api/auth/verify (checks Render Environment Variables + Postgres)
    if (inFlight) return;
    inFlight = true;
    toastHint("Verifying credentials with server...", false);

    const authEndpoint = (typeof DB !== "undefined" && DB.apiUrl) ? DB.apiUrl("/api/auth/verify") : "/api/auth/verify";
    fetch(authEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pin: key, key: key, terminal_key: key })
    })
      .then(r => r.json().then(data => ({ ok: r.ok, data })).catch(() => ({ ok: false, data: null })))
      .then(({ ok, data }) => {
        inFlight = false;
        if (ok && data && data.ok && data.staff) {
          // Keep the signed JWT returned by the server. Protected operations
          // such as publishing System Parameters use it on later API calls.
          enter(Object.assign({}, data.staff, { token: data.token || "" }));
          return;
        }
        if (explicit || key.length >= 8) {
          fail((data && data.error) || "Invalid Staff Terminal Key or PIN — try again");
        } else {
          toastHint("Enter your Staff Terminal Key or PIN set in Render or database");
        }
      })
      .catch(() => {
        inFlight = false;
        if (explicit) {
          fail("Could not verify key — check network or try again");
        }
      });
  }

  /* Keypad button clicks */
  keypad.addEventListener("click", e => {
    const b = e.target.closest(".key");
    if (!b) return;
    const k = b.dataset.k;
    if (k === "C") {
      pin = "";
      toastHint("Enter your Staff Terminal Key or PIN set in Render or database");
    } else if (k === "⌫") {
      pin = pin.slice(0, -1);
    } else if (pin.length < 32) {
      pin += k;
    }
    drawPin();
    if (pin.length >= 4) {
      submitCandidate(pin, false);
    }
  });

  $("#btnPinSubmit").addEventListener("click", () => {
    submitCandidate(pin, true);
  });

  /* Alphanumeric Text Key Input */
  $("#btnKeySubmit").addEventListener("click", () => {
    const val = textKeyInput ? textKeyInput.value.trim() : "";
    submitCandidate(val, true);
  });

  if (textKeyInput) {
    textKeyInput.addEventListener("keydown", e => {
      if (e.key === "Enter") {
        e.preventDefault();
        submitCandidate(textKeyInput.value.trim(), true);
      }
    });
  }

  const btnToggleShowKey = $("#btnToggleShowKey");
  if (btnToggleShowKey && textKeyInput) {
    btnToggleShowKey.addEventListener("click", () => {
      const isPass = textKeyInput.type === "password";
      textKeyInput.type = isPass ? "text" : "password";
      btnToggleShowKey.textContent = isPass ? "Hide" : "Show";
    });
  }

  /* Global Keyboard typing support */
  window.addEventListener("keydown", e => {
    // If typing in the text input, let native input handle characters
    if (document.activeElement === textKeyInput) return;

    if (e.key === "Enter") {
      e.preventDefault();
      if (activeTab === "pin") {
        submitCandidate(pin, true);
      } else if (textKeyInput) {
        submitCandidate(textKeyInput.value.trim(), true);
      }
      return;
    }

    if (e.key === "Backspace") {
      if (activeTab === "pin") {
        pin = pin.slice(0, -1);
        drawPin();
      }
      return;
    }

    if (e.key === "Escape") {
      pin = "";
      if (textKeyInput) textKeyInput.value = "";
      drawPin();
      return;
    }

    // If typing digits on PIN tab
    if (/^\d$/.test(e.key) && activeTab === "pin" && pin.length < 32) {
      pin += e.key;
      drawPin();
      if (pin.length >= 4) {
        submitCandidate(pin, false);
      }
    } else if (/^[a-zA-Z0-9_\-]$/.test(e.key) && activeTab === "pin") {
      // If user starts typing alphanumeric letters while on PIN tab, switch to text key tab!
      switchTab("key");
      if (textKeyInput) {
        textKeyInput.value = pin + e.key;
        textKeyInput.focus();
      }
    }
  });

  drawPin();
})();
