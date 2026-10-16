/* Adonai rider app — BROWSER DEMO of the Android native bridge.
 *
 * The real rider app talks to Java code inside the installed APK
 * (android/app/src/main/java/com/adonaithrift/pos/MainActivity.java), which owns
 * the session token and the GPS foreground service. This file only SIMULATES
 * that bridge in a desktop browser so the dispatch/rider flow can be walked
 * through against the real backend API. GPS points are clearly sent with
 * mock:true, so the dispatch console honestly labels them "simulated".
 */
(function (global) {
  "use strict";
  const state = {
    base: global.location.origin,
    token: null,
    rider: null,
    paired: false,
    running: false,
    dutyUntil: null,
    message: "Demo bridge ready. Pair this phone with the demo code.",
    timer: null,
    sequence: 0,
  };

  function result(id, payload) {
    if (typeof global.__adonaiRiderResult === "function") {
      global.__adonaiRiderResult(id, JSON.stringify(payload));
    }
  }

  async function call(path, options) {
    const response = await fetch(state.base + path, options);
    let data;
    try { data = await response.json(); }
    catch (_) { data = { ok: false, error: "Dispatch sent an unreadable response (" + response.status + ")." }; }
    return data;
  }

  function riderHeaders() {
    return { "Content-Type": "application/json", "Authorization": "Bearer " + state.token };
  }

  function paint(message) {
    if (message) state.message = message;
    global.dispatchEvent(new Event("adonai-rider-demo-state"));
  }

  async function sendLocation() {
    if (!state.running || !state.token) return;
    // Wander gently around Kampala central so the dispatch map visibly moves.
    const fix = Date.now();
    const lat = 0.3136 + (Math.random() - 0.5) * 0.012;
    const lng = 32.5822 + (Math.random() - 0.5) * 0.012;
    try {
      await call("/api/rider/location", {
        method: "POST",
        headers: riderHeaders(),
        body: JSON.stringify({
          latitude: lat, longitude: lng, accuracy_m: 12 + Math.random() * 20,
          sequence: ++state.sequence, fix_time_ms: fix, mock: true,
        }),
      });
      paint("Simulated GPS fix sent to dispatch (" + lat.toFixed(4) + ", " + lng.toFixed(4) + ").");
    } catch (error) {
      paint("Could not send the simulated GPS fix: " + error.message);
    }
  }

  global.Android = {
    /* --- interface expected by js/rider-app.js ------------------------- */
    pairRiderPhone: function (id, base, code, label) {
      (async () => {
        try {
          state.base = String(base || "").replace(/\/+$/, "") || global.location.origin;
          const data = await call("/api/rider/pair", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ code: code, device_label: label }),
          });
          if (data.ok) {
            state.token = data.session_token;
            state.rider = data.rider || null;
            state.paired = true;
            paint("Phone paired in the demo. GPS stays off until duty starts.");
          }
          result(id, data);
        } catch (error) {
          result(id, { ok: false, error: "Could not reach the demo server: " + error.message });
        }
      })();
    },

    riderCommand: function (id, action, bodyJson) {
      (async () => {
        try {
          let data;
          if (action === "me") {
            data = await call("/api/rider/me", { headers: riderHeaders() });
          } else if (action === "progress") {
            const body = JSON.parse(bodyJson || "{}");
            data = await call("/api/rider/orders/" + encodeURIComponent(body.order_id) + "/progress", {
              method: "POST",
              headers: riderHeaders(),
              body: JSON.stringify({ stage: body.stage, received_by: body.received_by || "", note: body.note || "" }),
            });
          } else {
            data = { ok: false, error: "Demo bridge does not know the command: " + action };
          }
          result(id, data);
        } catch (error) {
          result(id, { ok: false, error: "Demo request failed: " + error.message });
        }
      })();
    },

    startRiderTracking: function () {
      if (!state.paired) { paint("Pair this phone before starting duty."); return; }
      const consent = global.confirm(
        "ANDROID CONSENT DIALOG (simulated)\n\nShare this phone's location with Adonai dispatch for this delivery duty?\n\n" +
        "The real APK shows a native dialog and runs a visible foreground service with a Stop action, for at most 12 hours. " +
        "Here the GPS points are simulated around Kampala and flagged mock:true."
      );
      if (!consent) { paint("Sharing declined. Duty did not start."); return; }
      (async () => {
        try {
          const data = await call("/api/rider/duty/start", {
            method: "POST", headers: riderHeaders(), body: JSON.stringify({ consent: true }),
          });
          if (data.ok) {
            state.running = true;
            state.dutyUntil = data.duty_until;
            paint("Duty started. Sending simulated GPS fixes every 5 seconds.");
            await sendLocation();
            state.timer = setInterval(sendLocation, 5000);
          } else {
            paint(data.error || "Could not start duty.");
          }
        } catch (error) {
          paint("Could not start duty: " + error.message);
        }
      })();
    },

    stopRiderTracking: function () {
      if (state.timer) { clearInterval(state.timer); state.timer = null; }
      state.running = false;
      paint("Stop requested. Confirming with dispatch…");
      (async () => {
        try {
          await call("/api/rider/duty/stop", { method: "POST", headers: riderHeaders(), body: "{}" });
          paint("Duty stopped. Dispatch will show the last fix as stale, not new movement.");
        } catch (error) {
          paint("Stop sent, but dispatch could not confirm: " + error.message);
        }
      })();
    },

    riderTrackingState: function () {
      return JSON.stringify({
        paired: state.paired,
        rider_name: state.rider ? state.rider.name : null,
        running: state.running,
        state: state.running ? "sharing" : "idle",
        message: state.message,
        base: state.base,
      });
    },
  };
})(window);
