/* ============ Adonai — staff login logic ============ */
(function () {
  "use strict";
  const $ = (s, r) => (r || document).querySelector(s);

  const locked = Auth.locked();
  const params = new URLSearchParams(location.search);
  const next = params.get("next") || "pos.html";

  if (!locked) {
    /* ---- open access mode: no PINs configured yet ---- */
    $("#openPane").hidden = false;
    $("#goPos").href = "pos.html";
    $("#goAdmin").href = "admin.html";
    return;
  }

  /* ---- locked mode: PIN keypad ---- */
  $("#pinPane").hidden = false;
  let pin = "";

  const keys = ["1","2","3","4","5","6","7","8","9","C","0","⌫"];
  $("#keypad").innerHTML = keys.map(k =>
    `<button class="key ${isNaN(Number(k)) ? "fn" : ""}" data-k="${k}">${k}</button>`).join("");

  function draw() {
    $("#pinDisplay").innerHTML = pin.length
      ? "•".repeat(pin.length)
      : `<span class="ph">Enter PIN</span>`;
  }

  function fail(msg) {
    const d = $("#pinDisplay");
    d.classList.add("error");
    $("#pinHint").textContent = msg;
    pin = ""; draw();
    setTimeout(() => d.classList.remove("error"), 350);
  }

  function enter(staff) {
    Auth.signIn(staff);
    // cashiers always land on the terminal; admins go where they were headed
    location.replace(staff.role === "cashier" ? "pos.html" : next);
  }

  /* ---- server fallback: verifies against the backend, which checks
     the ADMIN_ACCESS_PIN environment variable (owner's master PIN,
     configured in the Render dashboard) and the staff roster in the
     real database. Rescues access even when the PINs stored in this
     browser are lost or forgotten. ---- */
  let inFlight = false;
  function serverVerify(candidate, explicit) {
    if (inFlight) return;
    inFlight = true;
    fetch("/api/auth/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pin: candidate })
    })
      .then(r => r.json().then(data => ({ ok: r.ok, data })).catch(() => ({ ok: false, data: null })))
      .then(({ ok, data }) => {
        inFlight = false;
        if (ok && data && data.ok && data.staff) { enter(data.staff); return; }
        if (pin !== candidate) { checkOrSubmit(false); return; }   // user kept typing — re-check
        if (explicit || pin.length >= 8) fail("Wrong PIN — try again");
      })
      .catch(() => {
        inFlight = false;
        // offline / static hosting — behave exactly like before
        if (explicit || pin.length >= 8) fail("Wrong PIN — try again");
      });
  }

  function checkOrSubmit(explicit = false) {
    if (!pin) return;
    const staff = DB.verifyPin(pin);
    if (staff) { enter(staff); return; }
    if (pin.length >= 4) { serverVerify(pin, explicit); return; }
    if (explicit || pin.length >= 8) {
      fail("Wrong PIN — try again");
    }
  }

  $("#keypad").addEventListener("click", e => {
    const b = e.target.closest(".key"); if (!b) return;
    const k = b.dataset.k;
    if (k === "C") { pin = ""; $("#pinHint").textContent = "Ask the store admin for your staff PIN"; }
    else if (k === "⌫") pin = pin.slice(0, -1);
    else if (pin.length < 8) pin += k;
    draw();
    checkOrSubmit(false);
  });

  window.addEventListener("keydown", e => {
    if (/^\d$/.test(e.key) && pin.length < 8) {
      pin += e.key;
      draw();
      checkOrSubmit(false);
    }
    if (e.key === "Backspace") { pin = pin.slice(0, -1); draw(); }
    if (e.key === "Enter") { checkOrSubmit(true); }
  });

  draw();
})();
