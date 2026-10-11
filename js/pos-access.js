/* Optional passwords for selected POS areas. Checkout never needs a password. */
(function (global) {
  "use strict";
  const TOKEN_STORE = "adonai-area-sessions-v1";
  const POLICY_STORE = "adonai-area-policy-v1";
  const URL_ROOT = "/api/pos-access";
  let policy = null, freshAt = 0, pending = null, promptPending = null;
  let channel = null;
  let rowCounter = 0;
  const esc = value => String(value == null ? "" : value).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const apiUrl = path => typeof DB !== "undefined" && DB.apiUrl ? DB.apiUrl(path) : path;
  const $ = (selector, root = document) => root.querySelector(selector);
  function sessions() {
    try { return JSON.parse(sessionStorage.getItem(TOKEN_STORE) || "[]").filter(item => item.token && Date.parse(item.expires_at) > Date.now()); }
    catch (e) { return []; }
  }
  function saveSession(item) {
    const list = sessions().filter(old => old.key_id !== item.key_id);
    list.push(item);
    try { sessionStorage.setItem(TOKEN_STORE, JSON.stringify(list)); } catch (e) {}
  }
  function headers() {
    const values = sessions().map(item => item.token);
    return values.length ? { "X-Pos-Access": values.join(",") } : {};
  }
  async function request(path, method = "GET", body) {
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), 30000) : null;
    try {
      const auth = typeof Auth !== "undefined" && Auth.authHeaders ? Auth.authHeaders() : {};
      const result = await fetch(apiUrl(URL_ROOT + path), {
        method, cache: "no-store", signal: controller ? controller.signal : undefined,
        headers: Object.assign({ "Content-Type": "application/json" }, auth, headers()),
        body: body === undefined ? undefined : JSON.stringify(body)
      });
      const data = await result.json();
      if (!result.ok || !data.ok) {
        const error = new Error(data.error || "Could not update password settings.");
        error.status = result.status; error.data = data;
        throw error;
      }
      return data;
    } catch (error) {
      if (error.name === "AbortError") throw new Error("The server took too long. Check your connection and try again.");
      throw error;
    } finally { if (timer) clearTimeout(timer); }
  }
  function applyPolicy(data) {
    const before = policy && JSON.stringify(policy);
    policy = data; freshAt = Date.now();
    try { sessionStorage.setItem(POLICY_STORE, JSON.stringify(policy)); } catch (e) {}
    if (before !== JSON.stringify(policy)) global.dispatchEvent(new CustomEvent("pos-access-change", { detail: policy }));
  }
  async function ready(force = false) {
    if (!force && policy && Date.now() - freshAt < 10000) return policy;
    if (pending) return force ? pending.then(() => ready(true)) : pending;
    pending = request("/policy").then(data => { applyPolicy(data); return policy; }).finally(() => { pending = null; });
    return pending;
  }
  function areaInfo(area) {
    if (area === "security") return { id: area, label: "Password management", protected: !!(policy && policy.admin_configured), unlocked: !!(policy && policy.admin_unlocked) };
    return policy && policy.areas.find(item => item.id === area);
  }
  function canUse(area) {
    const info = areaInfo(area);
    return !!(info && (!info.protected || info.unlocked));
  }
  function areaForView(view) {
    const info = policy && policy.areas.find(item => item.views.includes(view));
    return info ? info.id : null;
  }
  function notify(message, error = false) {
    const toast = $("#toast");
    if (!toast) return;
    toast.textContent = message; toast.classList.toggle("err", error); toast.classList.add("show");
    setTimeout(() => toast.classList.remove("show"), 4000);
  }
  function announceChange() {
    if (channel) channel.postMessage({ type: "POLICY_CHANGED" });
  }
  async function changed(data, notice) {
    if (data.session) saveSession(data.session);
    await ready(true);
    announceChange();
    if (typeof DB !== "undefined" && DB.refreshOperationalData) DB.refreshOperationalData();
    await renderSettings();
    if (notice) notify(notice);
    return data;
  }

  function passwordDialog(area) {
    if (promptPending) return promptPending;
    promptPending = new Promise(resolve => {
      let closed = false;
      const info = areaInfo(area) || { label: "Protected area" };
      const previous = document.activeElement;
      const overlay = document.createElement("div");
      overlay.className = "pos-access-overlay";
      overlay.innerHTML = `<section class="pos-access-dialog" role="dialog" aria-modal="true" aria-labelledby="areaPasswordTitle">
        <div class="pa-dialog-icon" aria-hidden="true">${typeof Icons !== "undefined" ? Icons.svg("lock", "ico-24") : ""}</div>
        <p class="pa-eyebrow">OPTIONAL AREA PROTECTION</p><h2 id="areaPasswordTitle">${esc(info.label)}</h2>
        <p>The admin has protected this area. Enter its password or the admin password. The cashier register stays open.</p>
        <form id="areaPasswordForm"><label for="areaPassword">Area password</label>
          <div class="pa-password-input"><input id="areaPassword" type="password" autocomplete="current-password" maxlength="128" required /><button type="button" data-pa-show>Show</button></div>
          <p class="pa-error" id="areaPasswordError" role="alert"></p>
          <div class="pa-dialog-actions"><button class="btn" type="button" data-pa-cancel>Cancel</button><button class="btn primary" id="areaPasswordSubmit" type="submit">Unlock area</button></div>
        </form><p class="pa-dialog-foot">Access lasts 30 minutes on this tab. Passwords are verified by the server.</p>
      </section>`;
      document.body.appendChild(overlay);
      const input = $("#areaPassword", overlay), button = $("#areaPasswordSubmit", overlay), error = $("#areaPasswordError", overlay);
      const finish = result => {
        if (closed) return;
        closed = true;
        document.removeEventListener("keydown", keydown);
        overlay.remove(); promptPending = null;
        if (previous && previous.isConnected) previous.focus();
        resolve(result);
      };
      const keydown = event => {
        if (event.key === "Escape") { event.preventDefault(); finish(false); }
        if (event.key === "Tab") {
          const controls = Array.from(overlay.querySelectorAll("input, button")).filter(el => !el.disabled);
          if (event.shiftKey && document.activeElement === controls[0]) { event.preventDefault(); controls.at(-1).focus(); }
          if (!event.shiftKey && document.activeElement === controls.at(-1)) { event.preventDefault(); controls[0].focus(); }
        }
      };
      document.addEventListener("keydown", keydown);
      $("[data-pa-cancel]", overlay).addEventListener("click", () => finish(false));
      overlay.addEventListener("click", event => { if (event.target === overlay) finish(false); });
      $("[data-pa-show]", overlay).addEventListener("click", event => {
        input.type = input.type === "password" ? "text" : "password";
        event.currentTarget.textContent = input.type === "password" ? "Show" : "Hide";
      });
      $("#areaPasswordForm", overlay).addEventListener("submit", async event => {
        event.preventDefault(); error.textContent = ""; button.disabled = true; button.textContent = "Checking…";
        try {
          const data = await request("/unlock", "POST", { area, password: input.value });
          if (closed) return;
          saveSession(data.session);
          await ready(true);
          input.value = "";
          if (typeof DB !== "undefined" && DB.refreshOperationalData) DB.refreshOperationalData();
          finish(true);
        } catch (failure) {
          error.textContent = failure.message;
          input.focus(); input.select();
        } finally { button.disabled = false; button.textContent = "Unlock area"; }
      });
      setTimeout(() => input.focus(), 0);
    });
    return promptPending;
  }
  // Synchronous answer from the cached policy: true/false when known, null when no policy is cached yet.
  // Lets navigation switch views at once instead of waiting for a network round trip on every tap.
  function fastViewAllowed(view) {
    if (!policy) return null;
    const area = areaForView(view);
    return !area || canUse(area);
  }
  async function ensure(area) {
    if (!area) return true;
    await ready();
    if (canUse(area)) return true;
    if (!await passwordDialog(area)) return false;
    await ready(true);
    return canUse(area) ? true : ensure(area);
  }
  async function lock() {
    try { await request("/lock", "POST", {}); }
    finally {
      try { sessionStorage.removeItem(TOKEN_STORE); } catch (e) {}
      await ready(true);
      notify("Protected areas locked. Checkout is still open.");
    }
  }

  function checks(selected = [], prefix = "") {
    return (policy ? policy.areas : []).map(area => `<label class="pa-choice"><input type="checkbox" value="${area.id}" ${selected.includes(area.id) ? "checked" : ""} ${prefix ? `data-pa-policy="${area.id}"` : ""} /><span><strong>${esc(area.label)}</strong>${prefix ? `<small>${esc(area.description)}</small>` : ""}</span></label>`).join("");
  }
  function newRow() {
    const row = document.createElement("fieldset"); row.className = "pa-password-row";
    const id = ++rowCounter;
    row.innerHTML = `<div class="pa-row-top"><legend>Area password</legend><button class="mini-link" type="button" data-pa-remove-row>Remove</button></div>
      <div class="pa-two-fields"><div class="field"><label for="paName-${id}">Password name</label><input class="sel-full" id="paName-${id}" data-pa-name maxlength="80" placeholder="e.g. Accounts team" required /></div><div class="field"><label for="paPassword-${id}">New password <span class="fhint">8–128 characters</span></label><input class="sel-full" id="paPassword-${id}" data-pa-password type="password" autocomplete="new-password" minlength="8" maxlength="128" required /></div></div>
      <div class="pa-assign-label">Choose the areas this password may unlock</div><div class="pa-key-areas">${checks()}</div>`;
    $("[data-pa-remove-row]", row).addEventListener("click", () => {
      if (row.parentElement.children.length > 1) row.remove();
      else notify("Keep at least one password row, or leave the form unsaved.", true);
    });
    return row;
  }
  async function runButton(button, work) {
    const text = button.textContent;
    button.disabled = true; button.textContent = "Saving…";
    try { await work(); } catch (error) { notify(error.message, true); }
    finally { button.disabled = false; button.textContent = text; }
  }
  function ownerForm(title, actionId) {
    return `<form id="${actionId}" class="pa-owner-form"><h4>${title}</h4><div class="pa-two-fields"><div class="field"><label for="${actionId}Password">Admin password</label><input class="sel-full" id="${actionId}Password" name="password" type="password" autocomplete="new-password" minlength="8" maxlength="128" required /></div><div class="field"><label for="${actionId}Confirm">Confirm admin password</label><input class="sel-full" id="${actionId}Confirm" name="confirm" type="password" autocomplete="new-password" minlength="8" maxlength="128" required /></div></div><button class="btn primary" type="submit">${actionId === "paSetupAdmin" ? "Set up optional passwords" : "Change admin password"}</button></form>`;
  }
  function bindOwnerForm(form) {
    form.addEventListener("submit", event => {
      event.preventDefault();
      const password = form.elements.password.value;
      if (password !== form.elements.confirm.value) { notify("The two admin passwords do not match.", true); return; }
      runButton($("button[type=submit]", form), async () => {
        await changed(await request("/admin", "POST", { password }), "Admin password saved. Checkout remains password-free.");
      });
    });
  }
  async function editKey(key) {
    const selected = key.areas;
    const overlay = document.createElement("div"); overlay.className = "pos-access-overlay";
    overlay.innerHTML = `<section class="pos-access-dialog pa-edit-dialog" role="dialog" aria-modal="true" aria-labelledby="paEditTitle"><h2 id="paEditTitle">Edit area password</h2><form id="paEditForm"><div class="field"><label for="paEditName">Password name</label><input class="sel-full" id="paEditName" name="name" value="${esc(key.name)}" maxlength="80" required /></div><div class="field"><label for="paEditPassword">New password <span class="fhint">Leave blank to keep the current password</span></label><input class="sel-full" id="paEditPassword" name="password" type="password" autocomplete="new-password" minlength="8" maxlength="128" /></div><div class="pa-key-areas">${checks(selected)}</div><p class="muted small">Saving revokes this password’s current unlock sessions. The admin password remains available as a backup.</p><p class="pa-error" role="alert"></p><div class="pa-dialog-actions"><button class="btn" type="button" data-pa-cancel>Cancel</button><button class="btn primary" type="submit">Save password changes</button></div></form></section>`;
    document.body.appendChild(overlay);
    const form = $("#paEditForm", overlay);
    $("[data-pa-cancel]", overlay).addEventListener("click", () => overlay.remove());
    form.addEventListener("submit", async event => {
      event.preventDefault();
      const payload = { name: form.elements.name.value, areas: Array.from(form.querySelectorAll("input[type=checkbox]:checked")).map(el => el.value) };
      if (form.elements.password.value) payload.password = form.elements.password.value;
      const button = $("button[type=submit]", form); button.disabled = true;
      try {
        await changed(await request("/keys/" + encodeURIComponent(key.id), "PATCH", payload), "Password updated; its old sessions have been revoked.");
        overlay.remove();
      } catch (error) { $(".pa-error", overlay).textContent = error.message; }
      finally { button.disabled = false; }
    });
  }

  let renderId = 0;
  async function renderSettings() {
    const root = $("#posPasswordSettings");
    if (!root) return;
    const id = ++renderId;
    try {
      await ready();
      if (id !== renderId) return;
      const status = $("#posPasswordStatus");
      if (status) status.textContent = policy.protected_areas.length ? `${policy.protected_areas.length} areas protected` : "Optional · currently off";
      if (!policy.admin_configured) {
        root.innerHTML = `<div class="pa-setup-intro"><span class="pa-status-dot"></span><div><strong>No passwords have been set</strong><p>Keep everything open, or set an admin password below and then create passwords for the areas you choose. This never adds a password to the cashier register.</p></div></div>${ownerForm("1. Set your admin password (optional)", "paSetupAdmin")}<p class="pa-footnote">Set this up on a trusted terminal. Your admin password protects these rules and can unlock every protected area. There are no default passwords and no environment variables to configure.</p>`;
        bindOwnerForm($("#paSetupAdmin", root));
        return;
      }
      if (!policy.admin_unlocked) {
        root.innerHTML = `<div class="pa-setup-intro"><div><strong>Password management is protected</strong><p>Only the admin password can create, change or remove area passwords. Normal store settings remain usable unless you have also protected them.</p></div></div><button class="btn primary" type="button" id="paUnlockAdmin">Unlock password management</button>`;
        $("#paUnlockAdmin", root).addEventListener("click", async () => {
          if (await ensure("security")) await renderSettings();
        });
        return;
      }
      const data = await request("/keys");
      if (id !== renderId) return;
      root.innerHTML = `<div class="pa-admin-banner"><div><strong>Admin access unlocked</strong><span>Only your admin password can manage these rules.</span></div><button class="btn sm" id="paLock" type="button">Lock protected areas</button></div>
        <section class="pa-section"><h4>Protected areas</h4><p>Choose which workspaces need a password. Leaving a box unchecked keeps that area open.</p><div class="pa-policy-grid">${checks(policy.protected_areas, "policy")}</div><button class="btn" type="button" id="paSaveAreas">Save area protection</button></section>
        <section class="pa-section"><div class="pa-section-heading"><div><h4>Create area passwords</h4><p>Add one password or a batch. Each password can cover one or several areas.</p></div></div><form id="paBatchForm"><div id="paBatchRows"></div><div class="pa-batch-actions"><button class="btn" type="button" id="paAddRow">+ Add another password</button><button class="btn primary" type="submit">Save area passwords</button></div></form><p class="pa-footnote">Saving turns protection on for the selected areas. Use an area password different from the admin password.</p></section>
        <section class="pa-section"><h4>Saved area passwords</h4><div id="paSavedKeys">${data.keys.length ? data.keys.map(key => `<article class="pa-key-card" data-key-id="${esc(key.id)}"><div><strong>${esc(key.name)}</strong><span class="pa-key-state ${key.enabled ? "enabled" : ""}">${key.enabled ? "Enabled" : "Disabled"}</span><p>${key.areas.map(area => esc((areaInfo(area) || {}).label || area)).join(" · ")}</p></div><div class="pa-key-actions"><button class="btn sm" type="button" data-pa-edit="${esc(key.id)}">Edit / change password</button><button class="btn sm" type="button" data-pa-toggle="${esc(key.id)}">${key.enabled ? "Disable" : "Enable"}</button><button class="btn ghost sm" type="button" data-pa-delete="${esc(key.id)}">Delete</button></div></article>`).join("") : `<p class="pa-empty">No area passwords yet. Add them above, or protect an area with only the admin password.</p>`}</div><p class="pa-footnote">Disabling or deleting a staff password revokes its sessions but does not open the protected area. Use the area checkboxes above to turn protection off.</p></section>
        <details class="pa-section pa-admin-controls"><summary>Admin password & reset controls</summary>${ownerForm("Change admin password", "paChangeAdmin")}<button class="btn ghost" id="paRemoveAll" type="button">Remove all optional passwords</button></details>`;
      $("#paBatchRows", root).appendChild(newRow());
      $("#paLock", root).addEventListener("click", async () => { await lock(); await renderSettings(); });
      $("#paSaveAreas", root).addEventListener("click", event => runButton(event.currentTarget, async () => {
        const protected_areas = Array.from(root.querySelectorAll("[data-pa-policy]:checked")).map(el => el.value);
        await changed(await request("/policy", "PATCH", { protected_areas }), "Area protection updated. Checkout stays open.");
      }));
      $("#paAddRow", root).addEventListener("click", () => {
        const rows = $("#paBatchRows", root);
        if (rows.children.length >= 10) { notify("Save up to 10 passwords in one batch.", true); return; }
        rows.appendChild(newRow());
      });
      $("#paBatchForm", root).addEventListener("submit", event => {
        event.preventDefault();
        const keys = Array.from(root.querySelectorAll(".pa-password-row")).map(row => ({ name: $("[data-pa-name]", row).value, password: $("[data-pa-password]", row).value, areas: Array.from(row.querySelectorAll("input[type=checkbox]:checked")).map(el => el.value) }));
        if (keys.some(key => !key.areas.length)) { notify("Choose at least one area for every password.", true); return; }
        runButton($("button[type=submit]", event.currentTarget), async () => {
          await changed(await request("/keys", "POST", { keys }), "Area passwords saved and protection is active.");
        });
      });
      root.querySelectorAll("[data-pa-edit]").forEach(button => button.addEventListener("click", () => editKey(data.keys.find(key => key.id === button.dataset.paEdit))));
      root.querySelectorAll("[data-pa-toggle]").forEach(button => button.addEventListener("click", () => runButton(button, async () => {
        const key = data.keys.find(item => item.id === button.dataset.paToggle);
        await changed(await request("/keys/" + encodeURIComponent(key.id), "PATCH", { enabled: !key.enabled }), "Password status updated; old sessions have been revoked.");
      })));
      root.querySelectorAll("[data-pa-delete]").forEach(button => button.addEventListener("click", () => {
        if (!global.confirm("Delete this area password and revoke its sessions? Area protection will stay on.")) return;
        runButton(button, async () => { await changed(await request("/keys/" + encodeURIComponent(button.dataset.paDelete), "DELETE"), "Area password deleted."); });
      }));
      bindOwnerForm($("#paChangeAdmin", root));
      $("#paRemoveAll", root).addEventListener("click", event => {
        if (!global.confirm("Remove the admin password, every area password and all area protection? This cannot be undone.")) return;
        runButton(event.currentTarget, async () => {
          const result = await request("/admin", "DELETE", { confirm: true });
          try { sessionStorage.removeItem(TOKEN_STORE); } catch (e) {}
          await changed(result, "Optional passwords removed. All areas are open.");
        });
      });
    } catch (error) {
      if (id !== renderId) return;
      root.innerHTML = `<p class="pa-error" role="alert">${esc(error.message)}</p><button class="btn" type="button" id="paRetrySettings">Try again</button>`;
      $("#paRetrySettings", root).addEventListener("click", () => { freshAt = 0; renderSettings(); });
    }
  }
  try {
    const cached = sessionStorage.getItem(POLICY_STORE);
    if (cached) policy = JSON.parse(cached);
    if (typeof BroadcastChannel === "function") {
      channel = new BroadcastChannel("adonai-area-access");
      channel.onmessage = () => ready(true).catch(() => {});
    }
  } catch (e) {}
  global.PosAccess = { ready, headers, ensure, lock, canUse, areaForView, areaInfo, renderSettings, getPolicy: () => policy, fastViewAllowed };
  setInterval(() => { if (!document.hidden) ready(true).catch(() => {}); }, 15000);
})(window);
