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

  function submit() {
    const staff = DB.verifyPin(pin);
    if (!staff) return fail("Wrong PIN — try again");
    Auth.signIn(staff);
    // cashiers always land on the terminal; admins go where they were headed
    location.replace(staff.role === "cashier" ? "pos.html" : next);
  }

  $("#keypad").addEventListener("click", e => {
    const b = e.target.closest(".key"); if (!b) return;
    const k = b.dataset.k;
    if (k === "C") pin = "";
    else if (k === "⌫") pin = pin.slice(0, -1);
    else if (pin.length < 8) pin += k;
    draw();
    if (pin.length >= 4) submit();
  });

  window.addEventListener("keydown", e => {
    if (/^\d$/.test(e.key) && pin.length < 8) { pin += e.key; draw(); if (pin.length >= 4) submit(); }
    if (e.key === "Backspace") { pin = pin.slice(0, -1); draw(); }
  });

  draw();
})();
