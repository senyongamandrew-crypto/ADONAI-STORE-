/* ============================================================
   ADONAI — DYNAMIC CATEGORY FIELD SCHEMAS (browser engine)
   ------------------------------------------------------------
   Category + sub-category → ONE JSON form schema (category_field_schemas).
   The intake console renders only that schema's inputs, units, validation
   rules, photo angles and inspection points, so an earring is never asked
   for inches and a ring is never asked for fabric texture.

   Data flow
     1. js/catalog-schemas.data.js ships the bundled defaults (offline-safe,
        generated from data/category_field_schemas.json).
     2. load() refreshes from GET /api/catalog/field-schemas (the Supabase /
        PostgreSQL mirror) and notifies subscribers.
     3. mountForm() / mountPhotoProtocol() render + validate; read() returns
        the exact payload the server re-validates into products.attributes.

   The pure helpers (resolve, validate, project, autoTags, formatValue)
   mirror catalog_schemas.py one-for-one; tests keep them in parity.
   ============================================================ */
(function (global) {
  "use strict";

  const esc = value => String(value == null ? "" : value).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const clone = value => JSON.parse(JSON.stringify(value));
  const isEmpty = value => value == null || value === "" || (Array.isArray(value) && !value.length) ||
    (typeof value === "object" && !Array.isArray(value) && !Object.keys(value).length);
  const fmt = number => {
    const text = (Math.round(Number(number) * 100) / 100).toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
    return text || "0";
  };
  const cleanText = (value, limit = 80) => String(value == null ? "" : value).replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s{2,}/g, " ").trim().slice(0, limit);

  /* ---------------- document loading ---------------- */
  function expandDocument(raw) {
    const doc = clone(raw || {});
    const sets = doc.option_sets || {};
    Object.keys(doc.schemas || {}).forEach(key => {
      const schema = doc.schemas[key];
      schema.key = key;
      (schema.sections || []).forEach(section => (section.fields || []).forEach(field => {
        if (field.options_ref) { field.options = (sets[field.options_ref] || []).slice(); delete field.options_ref; }
      }));
      if (schema.inspection && schema.inspection.ratings_ref) {
        schema.inspection.ratings = (sets[schema.inspection.ratings_ref] || []).slice();
        delete schema.inspection.ratings_ref;
      }
    });
    return doc;
  }

  function looksValid(doc) {
    return !!(doc && doc.schemas && doc.taxonomy && typeof doc.schemas === "object" && Object.keys(doc.schemas).length);
  }

  let active = looksValid(global.ADONAI_CATEGORY_FIELD_SCHEMAS) ? expandDocument(global.ADONAI_CATEGORY_FIELD_SCHEMAS) : null;
  let source = active ? "bundled" : "none";
  let loading = null;
  const listeners = [];

  function documentNow() { return active; }

  /** Refresh from the server mirror; bundled defaults stay on any failure. */
  function load(options = {}) {
    if (loading && !options.force) return loading;
    const url = (global.DB && typeof global.DB.apiUrl === "function") ? global.DB.apiUrl("/api/catalog/field-schemas") : "/api/catalog/field-schemas";
    if (typeof global.fetch !== "function") return Promise.resolve(active);
    loading = Promise.resolve()
      .then(() => global.fetch(url, { method: "GET", cache: "no-store" }))
      .then(response => (response && response.ok ? response.json() : null))
      .then(data => {
        if (data && looksValid(data)) {
          const changed = !active || JSON.stringify(active.schemas) !== JSON.stringify(data.schemas) || JSON.stringify(active.taxonomy) !== JSON.stringify(data.taxonomy);
          active = expandDocument(data);
          source = "server";
          if (changed) listeners.slice().forEach(cb => { try { cb(active); } catch (e) { /* keep notifying */ } });
        }
        return active;
      })
      .catch(() => active)
      .finally(() => { loading = null; });
    return loading;
  }

  function onChange(cb) { if (typeof cb === "function") listeners.push(cb); }

  /* ---------------- resolution ---------------- */
  function subcategoriesFor(category, doc) {
    doc = doc || active;
    return ((doc && doc.taxonomy && doc.taxonomy[category]) || []).map(entry => entry[0]);
  }

  /** {key, schema, subcategory} — unknown sub-categories fall back to the first. */
  function resolve(category, subcategory, doc) {
    doc = doc || active;
    const entries = (doc && doc.taxonomy && doc.taxonomy[category]) || [];
    if (!entries.length) return null;
    const wanted = String(subcategory || "").trim().toLowerCase();
    const match = (wanted && entries.find(entry => entry[0].toLowerCase() === wanted)) || entries[0];
    const schema = doc.schemas[match[1]];
    return schema ? { key: match[1], schema, subcategory: match[0] } : null;
  }

  function matches(condition, ctx) {
    if (!condition) return true;
    const sub = (ctx && ctx.subcategory) || "";
    const state = String((ctx && ctx.item_condition) || "").toUpperCase();
    if (condition.subcategory && condition.subcategory.indexOf(sub) === -1) return false;
    if (condition.not_subcategory && condition.not_subcategory.indexOf(sub) !== -1) return false;
    if (condition.condition && condition.condition.indexOf(state) === -1) return false;
    return true;
  }
  const isVisible = (field, ctx) => matches(field.when, ctx);
  const isRequired = (field, ctx) => isVisible(field, ctx) && (!!field.required || (!!field.required_when && matches(field.required_when, ctx)));
  const eachField = (schema, cb) => (schema.sections || []).forEach(section => (section.fields || []).forEach(field => cb(field, section)));
  const photoProtocol = (schema, ctx) => (schema.photo_protocol || []).filter(angle => matches(angle.when, ctx));
  function inspectionApplies(schema, ctx) {
    const inspection = schema.inspection || {};
    return !!(inspection.points && inspection.points.length) && (!inspection.applies_to || inspection.applies_to.indexOf(String((ctx && ctx.item_condition) || "").toUpperCase()) !== -1);
  }

  /** Legacy intake controls a schema takes over (size / fabric / measurement set). */
  function hiddenCoreFields(schema) {
    const hidden = new Set(((schema.core && schema.core.hide) || []).slice());
    hidden.add("measure_set");
    hidden.add("quick_measurements");
    eachField(schema, field => { if (field.projects_to === "fabric") hidden.add("fabric"); if (field.projects_to === "size") hidden.add("size"); });
    return Array.from(hidden);
  }

  /* ---------------- units & values ---------------- */
  function convert(value, from, to, doc) {
    if (from === to) return value;
    const units = ((doc || active) && (doc || active).units) || {};
    const a = units[from] || {}, b = units[to] || {};
    if (a.dimension === "length" && b.dimension === "length") return value * Number(a.per_mm) / Number(b.per_mm);
    throw new Error(`Cannot convert ${from} to ${to}`);
  }

  function coerce(field, raw, doc) {
    const label = field.label || field.key;
    const toNumber = value => {
      if (typeof value === "boolean" || value == null || String(value).trim() === "") return null;
      const number = Number(value);
      return Number.isFinite(number) ? number : null;
    };
    switch (field.type) {
      case "measure": {
        const units = field.units || [];
        const number = toNumber(raw && typeof raw === "object" ? raw.value : raw);
        const unit = (raw && typeof raw === "object" && raw.unit) || units[0];
        if (units.indexOf(unit) === -1) throw new Error(`${label} must be recorded in ${units.join(" or ")}`);
        if (number == null || number <= 0) throw new Error(`${label} must be a positive number`);
        const range = field.range || [0, 1e6];
        const inDefault = convert(number, unit, units[0], doc);
        if (inDefault < range[0] - 1e-9 || inDefault > range[1] + 1e-9) {
          if (unit === units[0]) throw new Error(`${label} must be between ${fmt(range[0])} and ${fmt(range[1])} ${units[0]}`);
          throw new Error(`${label} must be between ${fmt(convert(range[0], units[0], unit, doc))} and ${fmt(convert(range[1], units[0], unit, doc))} ${unit}`);
        }
        return { value: Math.round(number * 100) / 100, unit };
      }
      case "number": {
        let number = toNumber(raw);
        if (number == null) throw new Error(`${label} must be a number`);
        if (field.integer) {
          if (Math.abs(number - Math.round(number)) > 1e-9) throw new Error(`${label} must be a whole number`);
          number = Math.round(number);
        }
        const range = field.range || [0, 1e6];
        if (number < range[0] || number > range[1]) throw new Error(`${label} must be between ${fmt(range[0])} and ${fmt(range[1])}`);
        return number;
      }
      case "select": {
        const text = cleanText(raw);
        const match = (field.options || []).find(option => option.toLowerCase() === text.toLowerCase());
        if (match) return match;
        if (field.allow_other && text) return text;
        throw new Error(`${label}: choose one of the listed options`);
      }
      case "multiselect": {
        const items = Array.isArray(raw) ? raw : String(raw || "").split(",");
        const out = [];
        items.slice(0, 12).forEach(item => {
          const text = cleanText(item);
          if (!text) return;
          const match = (field.options || []).find(option => option.toLowerCase() === text.toLowerCase());
          if (!match && !field.allow_other) throw new Error(`${label}: ${text} is not a listed option`);
          const value = match || text;
          if (out.indexOf(value) === -1) out.push(value);
        });
        return out;
      }
      case "boolean": {
        if (typeof raw === "boolean") return raw;
        const text = String(raw).trim().toLowerCase();
        if (["true", "yes", "1", "y"].indexOf(text) !== -1) return true;
        if (["false", "no", "0", "n"].indexOf(text) !== -1) return false;
        if (field.allow_unknown && ["unknown", "unverified", "not verified"].indexOf(text) !== -1) return "unknown";
        throw new Error(`${label}: answer yes or no`);
      }
      case "size": {
        const scales = field.scales || [];
        const value = cleanText(raw && typeof raw === "object" ? raw.value : raw, 12);
        const scale = (raw && typeof raw === "object" && raw.scale) || scales[0];
        if (scales.indexOf(scale) === -1) throw new Error(`${label}: use the ${scales.join(" / ")} scale`);
        if (!value) throw new Error(`${label} is required`);
        return { value, scale };
      }
      case "text":
        return cleanText(raw, Number(field.max_length) || 120);
      default:
        throw new Error(`Unsupported field type ${field.type}`);
    }
  }

  function formatValue(field, value, doc) {
    if (field.type === "measure" && value && typeof value === "object") {
      let text = `${fmt(value.value)} ${value.unit}`;
      if (value.unit === "in" || value.unit === "cm") {
        const other = value.unit === "in" ? "cm" : "in";
        text += ` (${fmt(Math.round(convert(Number(value.value), value.unit, other, doc) * 10) / 10)} ${other})`;
      }
      return text;
    }
    if (field.type === "size" && value && typeof value === "object") return `${value.scale} ${value.value}`;
    if (field.type === "boolean") {
      if (value === "unknown") return field.unknown_label || "Not verified";
      return value ? (field.true_label || "Yes") : (field.false_label || "No");
    }
    if (field.type === "multiselect" && Array.isArray(value)) return value.join(", ");
    return String(value);
  }

  /** Mirrors catalog_schemas.normalize_attributes (minus server-only checks). */
  function validate(schema, payload, ctx, options = {}) {
    const enforce = options.enforceRequired !== false;
    const supplied = (payload && payload.values) || {};
    const values = {}, errors = {};
    eachField(schema, field => {
      if (!isVisible(field, ctx)) return;
      const incoming = supplied[field.key];
      const blank = isEmpty(incoming) || (incoming && typeof incoming === "object" && !Array.isArray(incoming) && "value" in incoming && isEmpty(incoming.value));
      if (blank) {
        if (enforce && isRequired(field, ctx)) errors[field.key] = `${field.label} is required`;
        return;
      }
      try {
        const value = coerce(field, incoming);
        if (isEmpty(value)) { if (enforce && isRequired(field, ctx)) errors[field.key] = `${field.label} is required`; return; }
        values[field.key] = value;
      } catch (error) { errors[field.key] = error.message; }
    });
    (schema.sections || []).forEach(section => {
      const rule = section.require_any;
      if (!enforce || !rule || !matches(rule.when, ctx)) return;
      const keys = rule.keys || [];
      if (!keys.some(k => k in values) && !keys.some(k => k in errors)) errors[keys[0] || section.id] = rule.message || "Fill at least one measurement";
    });
    const inspection = {};
    if (inspectionApplies(schema, ctx)) {
      const ratings = schema.inspection.ratings || [];
      const given = (payload && payload.inspection) || {};
      schema.inspection.points.forEach(point => {
        const rating = cleanText(given[point.key]);
        const match = ratings.find(r => r.toLowerCase() === rating.toLowerCase());
        if (match) inspection[point.key] = match;
        else if (rating) errors[`inspection.${point.key}`] = `${point.label}: choose a listed rating`;
        else if (enforce && point.required) errors[`inspection.${point.key}`] = `${point.label} must be rated`;
      });
    }
    return { ok: !Object.keys(errors).length, values, inspection, errors };
  }

  function project(schema, values, doc) {
    const fabric = [];
    let size = "";
    const measurements = {};
    eachField(schema, field => {
      const value = values[field.key];
      if (isEmpty(value)) return;
      if (field.projects_to === "fabric" && field.type !== "measure") {
        const text = formatValue(field, value, doc);
        if (text && text.toLowerCase() !== "none" && fabric.indexOf(text) === -1) fabric.push(text);
      } else if (field.projects_to === "size" && !size) {
        size = field.type === "measure" ? `${fmt(value.value)} ${value.unit}` : field.type === "size" ? `${value.scale} ${value.value}` : String(value);
      }
      if (field.flat_lay_key && field.type === "measure") {
        const units = ((doc || active) && (doc || active).units) || {};
        if ((units[value.unit] || {}).dimension === "length") {
          const inches = Math.round(convert(Number(value.value), value.unit, "in", doc) * 100) / 100;
          if (inches > 0 && inches <= 120) measurements[field.flat_lay_key] = inches;
        }
      }
    });
    const out = {};
    if (fabric.length) out.fabric = fabric.join(" · ").slice(0, 255);
    if (size) out.size = size.slice(0, 20);
    if (Object.keys(measurements).length) out.measurements = measurements;
    return out;
  }

  function cleanTags(raw) {
    const items = Array.isArray(raw) ? raw : String(raw || "").split(",");
    const out = [];
    items.forEach(item => {
      const tag = cleanText(item, 40).toLowerCase();
      if (tag && out.indexOf(tag) === -1 && out.length < 24) out.push(tag);
    });
    return out;
  }

  /** Mirrors catalog_schemas.auto_search_tags. */
  function autoTags({ category = "", subcategory = "", brand = "", color = "", item_condition = "", attributes = null } = {}, doc) {
    doc = doc || active;
    const tags = [subcategory, category];
    if (brand && ["unbranded", ""].indexOf(String(brand).trim().toLowerCase()) === -1) tags.push(brand);
    if (color) tags.push(color);
    tags.push(String(item_condition).toUpperCase() === "BRAND_NEW" ? "brand new" : "pre-loved");
    const schema = attributes && doc && doc.schemas[attributes.schema_key];
    const values = (attributes && attributes.values) || {};
    if (schema) eachField(schema, field => {
      const value = values[field.key];
      if (isEmpty(value)) return;
      if (field.type === "boolean" && field.tag_label && value === true) tags.push(field.tag_label);
      else if (field.tag && (field.type === "select" || field.type === "text") && String(value).toLowerCase() !== "none") tags.push(String(value));
      else if (field.tag && field.type === "multiselect") value.forEach(v => tags.push(v));
    });
    return cleanTags(tags);
  }

  /** Display rows for a stored record (client mirror of specifications()). */
  function specifications(attributes, doc) {
    doc = doc || active;
    const schema = attributes && doc && doc.schemas[attributes.schema_key];
    if (!schema || !attributes.values) return [];
    const rows = [];
    eachField(schema, (field, section) => {
      const value = attributes.values[field.key];
      if (!isEmpty(value)) rows.push({ section: section.title || "", key: field.key, label: field.label, value: formatValue(field, value, doc) });
    });
    const inspection = schema.inspection || {};
    (inspection.points || []).forEach(point => {
      const rating = (attributes.inspection || {})[point.key];
      if (rating) rows.push({ section: inspection.title || "Condition inspection", key: `inspection.${point.key}`, label: point.label, value: rating });
    });
    return rows;
  }

  /* ---------------- form renderer ---------------- */
  let mountCounter = 0;

  function fieldControlHTML(field, id, value) {
    const v = value == null ? null : value;
    const opt = (val, label, selected) => `<option value="${esc(val)}"${selected ? " selected" : ""}>${esc(label)}</option>`;
    switch (field.type) {
      case "measure": {
        const units = field.units || [];
        const unit = (v && v.unit) || units[0];
        const number = v && v.value != null ? v.value : "";
        const range = field.range || [];
        const unitControl = units.length > 1
          ? `<select class="csf-unit-select" data-csf-unit aria-label="${esc(field.label)} unit">${units.map(u => opt(u, u, u === unit)).join("")}</select>`
          : `<span class="csf-unit" data-csf-fixed-unit="${esc(units[0])}">${esc(units[0])}</span>`;
        return `<div class="csf-measure"><input class="sel-full" id="${id}" type="number" inputmode="decimal" min="0" step="${esc(field.step || 0.1)}" data-csf-input value="${esc(number)}" placeholder="${range.length ? `${fmt(range[0])}–${fmt(range[1])}` : "0.0"}" />${unitControl}</div>`;
      }
      case "number":
        return `<input class="sel-full" id="${id}" type="number" inputmode="numeric" min="${esc((field.range || [0])[0])}" step="${field.integer ? 1 : esc(field.step || 0.1)}" data-csf-input value="${esc(v == null ? "" : v)}" />`;
      case "select": {
        const options = field.options || [];
        const isOther = v != null && v !== "" && options.indexOf(v) === -1;
        return `<select class="sel-full" id="${id}" data-csf-input>${opt("", "Choose…", v == null || v === "")}${options.map(o => opt(o, o, o === v)).join("")}${field.allow_other ? opt("__other__", "Other…", isOther) : ""}</select>` +
          (field.allow_other ? `<input class="sel-full csf-other" data-csf-other placeholder="Type the ${esc(String(field.label).toLowerCase())}" maxlength="80" value="${isOther ? esc(v) : ""}" ${isOther ? "" : "hidden"} />` : "");
      }
      case "multiselect": {
        const selected = Array.isArray(v) ? v : [];
        return `<div class="csf-chips" id="${id}" role="group">${(field.options || []).map(o => `<label class="csf-chip"><input type="checkbox" data-csf-check value="${esc(o)}" ${selected.indexOf(o) !== -1 ? "checked" : ""} /><span>${esc(o)}</span></label>`).join("")}</div>`;
      }
      case "boolean": {
        const current = v === true ? "true" : v === false ? "false" : v === "unknown" ? "unknown" : "";
        return `<select class="sel-full" id="${id}" data-csf-input>${opt("", "Choose…", current === "")}${opt("true", field.true_label || "Yes", current === "true")}${opt("false", field.false_label || "No", current === "false")}${field.allow_unknown ? opt("unknown", field.unknown_label || "Not verified", current === "unknown") : ""}</select>`;
      }
      case "size": {
        const scales = field.scales || [];
        const scale = (v && v.scale) || scales[0];
        const listId = `${id}-presets`;
        const presets = (field.presets && field.presets[scale]) || [];
        return `<div class="csf-measure"><select class="csf-unit-select" data-csf-scale aria-label="${esc(field.label)} scale">${scales.map(s => opt(s, s, s === scale)).join("")}</select><input class="sel-full" id="${id}" data-csf-input list="${listId}" maxlength="12" value="${esc((v && v.value) || "")}" placeholder="${esc(presets[Math.floor(presets.length / 2)] || "")}" /><datalist id="${listId}">${presets.map(p => `<option value="${esc(p)}"></option>`).join("")}</datalist></div>`;
      }
      default:
        return `<input class="sel-full" id="${id}" data-csf-input maxlength="${esc(field.max_length || 120)}" placeholder="${esc(field.placeholder || "")}" value="${esc(v == null ? "" : v)}" />`;
    }
  }

  function unitBadge(field) {
    // Single-unit fields already show a fixed unit chip beside the input.
    if (field.type !== "measure" || (field.units || []).length < 2) return "";
    return `<span class="csf-unit-hint">${esc((field.units || []).join(" / "))}</span>`;
  }

  /**
   * Render a schema form into `root`.
   * options: { schema, context:{subcategory,item_condition}, values:{values,inspection}, onChange }
   */
  function mountForm(root, options = {}) {
    if (!root) throw new Error("Schema form container is missing");
    const schema = options.schema;
    const uid = `csf${++mountCounter}`;
    let context = Object.assign({}, options.context || {});
    const initial = options.values || {};
    const initialValues = initial.values || {};
    const initialInspection = initial.inspection || {};

    const sectionsHTML = (schema.sections || []).map(section => `
      <fieldset class="csf-section" data-csf-section="${esc(section.id)}">
        <legend>${esc(section.title)}</legend>
        ${section.note ? `<p class="csf-note">${esc(section.note)}</p>` : ""}
        <p class="csf-section-error" data-csf-section-error hidden></p>
        <div class="csf-grid">
          ${(section.fields || []).map(field => {
            const id = `${uid}-${field.key}`;
            return `<div class="field csf-field" data-csf-key="${esc(field.key)}" data-csf-type="${esc(field.type)}">
              <label for="${id}">${esc(field.label)}<span class="csf-req" data-csf-req hidden aria-hidden="true">*</span>${unitBadge(field)}</label>
              ${fieldControlHTML(field, id, initialValues[field.key])}
              ${field.hint ? `<span class="fhint">${esc(field.hint)}</span>` : ""}
              <span class="csf-error" data-csf-error role="alert" hidden></span>
            </div>`;
          }).join("")}
        </div>
      </fieldset>`).join("");

    const inspection = schema.inspection;
    const inspectionHTML = inspection && inspection.points && inspection.points.length ? `
      <fieldset class="csf-section csf-inspection" data-csf-inspection>
        <legend>${esc(inspection.title || "Condition inspection")}</legend>
        <p class="csf-note">Rate each point on this exact piece. Shown to shoppers with the condition grade.</p>
        <div class="csf-grid">
          ${inspection.points.map(point => {
            const id = `${uid}-insp-${point.key}`;
            const current = initialInspection[point.key] || "";
            return `<div class="field csf-field" data-csf-point="${esc(point.key)}">
              <label for="${id}">${esc(point.label)}${point.required ? '<span class="csf-req" aria-hidden="true">*</span>' : ""}</label>
              <select class="sel-full" id="${id}" data-csf-rating><option value="">Rate…</option>${(inspection.ratings || []).map(r => `<option${r === current ? " selected" : ""}>${esc(r)}</option>`).join("")}</select>
              <span class="csf-error" data-csf-error role="alert" hidden></span>
            </div>`;
          }).join("")}
        </div>
      </fieldset>` : "";

    root.innerHTML = `<div class="csf" data-schema="${esc(schema.key)}">${sectionsHTML}${inspectionHTML}</div>`;
    const fieldEl = key => root.querySelector(`[data-csf-key="${key}"]`);

    function readField(field) {
      const wrap = fieldEl(field.key);
      if (!wrap) return null;
      const input = wrap.querySelector("[data-csf-input]");
      switch (field.type) {
        case "measure": {
          const unitEl = wrap.querySelector("[data-csf-unit]");
          const value = input.value.trim();
          return value === "" ? null : { value: Number(value), unit: unitEl ? unitEl.value : (field.units || [])[0] };
        }
        case "number": return input.value.trim() === "" ? null : Number(input.value);
        case "select": {
          if (input.value === "__other__") { const other = wrap.querySelector("[data-csf-other]"); return other ? other.value.trim() : ""; }
          return input.value;
        }
        case "multiselect": return Array.from(wrap.querySelectorAll("[data-csf-check]:checked")).map(box => box.value);
        case "boolean": return input.value === "" ? null : (input.value === "unknown" ? "unknown" : input.value === "true");
        case "size": {
          const value = input.value.trim();
          return value === "" ? null : { value, scale: wrap.querySelector("[data-csf-scale]").value };
        }
        default: return input.value.trim();
      }
    }

    function applyVisibility() {
      eachField(schema, field => {
        const wrap = fieldEl(field.key);
        if (!wrap) return;
        wrap.hidden = !isVisible(field, context);
        const req = wrap.querySelector("[data-csf-req]");
        if (req) req.hidden = !isRequired(field, context);
      });
      root.querySelectorAll("[data-csf-section]").forEach(sectionEl => {
        sectionEl.hidden = !Array.from(sectionEl.querySelectorAll("[data-csf-key]")).some(wrap => !wrap.hidden);
      });
      const inspectionEl = root.querySelector("[data-csf-inspection]");
      if (inspectionEl) inspectionEl.hidden = !inspectionApplies(schema, context);
    }

    /** Payload in the server shape. Hidden fields never leak stale values. */
    function read() {
      const values = {};
      eachField(schema, field => {
        if (!isVisible(field, context)) return;
        const value = readField(field);
        if (!isEmpty(value)) values[field.key] = value;
      });
      const payload = { schema_key: schema.key, values };
      if (inspectionApplies(schema, context)) {
        const ratings = {};
        root.querySelectorAll("[data-csf-point]").forEach(wrap => {
          const value = wrap.querySelector("[data-csf-rating]").value;
          if (value) ratings[wrap.dataset.csfPoint] = value;
        });
        payload.inspection = ratings;
      }
      return payload;
    }

    function showErrors(errors) {
      errors = errors || {};
      root.querySelectorAll("[data-csf-key], [data-csf-point]").forEach(wrap => {
        const key = wrap.dataset.csfKey || `inspection.${wrap.dataset.csfPoint}`;
        const box = wrap.querySelector("[data-csf-error]");
        const message = errors[key];
        wrap.classList.toggle("csf-invalid", !!message);
        wrap.querySelectorAll("input, select").forEach(el => { if (message) el.setAttribute("aria-invalid", "true"); else el.removeAttribute("aria-invalid"); });
        if (box) { box.hidden = !message; box.textContent = message || ""; }
      });
      return Object.keys(errors).length;
    }

    function validateNow(opts) {
      const result = validate(schema, read(), context, opts);
      showErrors(result.errors);
      return result;
    }

    function focusFirstError() {
      const target = root.querySelector(".csf-invalid input, .csf-invalid select");
      if (target) { try { target.focus({ preventScroll: false }); target.scrollIntoView({ block: "center", behavior: "smooth" }); } catch (e) { /* jsdom */ } }
    }

    const changed = () => { if (typeof options.onChange === "function") options.onChange(); };
    const onInput = event => {
      const wrap = event.target.closest("[data-csf-key], [data-csf-point]");
      if (wrap && wrap.classList.contains("csf-invalid")) {
        wrap.classList.remove("csf-invalid");
        const box = wrap.querySelector("[data-csf-error]"); if (box) box.hidden = true;
      }
      changed();
    };
    const onChangeEvent = event => {
      const target = event.target;
      if (target.matches("[data-csf-input]") && target.tagName === "SELECT") {
        const other = target.parentElement.querySelector("[data-csf-other]");
        if (other) { other.hidden = target.value !== "__other__"; if (!other.hidden) other.focus(); }
      }
      if (target.matches("[data-csf-scale]")) {
        const wrap = target.closest("[data-csf-key]");
        const field = (schema.sections || []).reduce((found, s) => found || (s.fields || []).find(f => f.key === wrap.dataset.csfKey), null);
        const list = wrap.querySelector("datalist");
        const presets = (field && field.presets && field.presets[target.value]) || [];
        if (list) list.innerHTML = presets.map(p => `<option value="${esc(p)}"></option>`).join("");
      }
      onInput(event);
    };
    root.addEventListener("input", onInput);
    root.addEventListener("change", onChangeEvent);
    applyVisibility();

    return {
      schema,
      get context() { return Object.assign({}, context); },
      setContext(next) { context = Object.assign({}, context, next || {}); applyVisibility(); changed(); },
      read,
      validate: validateNow,
      showErrors,
      focusFirstError,
      projections() { return project(schema, validate(schema, read(), context, { enforceRequired: false }).values); },
      requiredStatus() {
        let total = 0, done = 0;
        const payload = read();
        eachField(schema, field => { if (isRequired(field, context)) { total += 1; if (!isEmpty(payload.values[field.key])) done += 1; } });
        if (inspectionApplies(schema, context)) schema.inspection.points.forEach(point => { if (point.required) { total += 1; if ((payload.inspection || {})[point.key]) done += 1; } });
        return { total, done };
      },
      reset() {
        root.querySelectorAll("[data-csf-input], [data-csf-other], [data-csf-rating]").forEach(el => { el.value = ""; });
        root.querySelectorAll("[data-csf-check]").forEach(el => { el.checked = false; });
        root.querySelectorAll("[data-csf-other]").forEach(el => { el.hidden = true; });
        showErrors({});
        changed();
      },
      destroy() { root.removeEventListener("input", onInput); root.removeEventListener("change", onChangeEvent); root.innerHTML = ""; }
    };
  }

  /* ---------------- photo angle protocol ---------------- */
  /**
   * Category-specific angle checklist mapped onto the uploaded gallery.
   * Mappings follow photos by URL, so reordering or a new cover keeps them.
   */
  function mountPhotoProtocol(root, options = {}) {
    if (!root) throw new Error("Photo protocol container is missing");
    const schema = options.schema;
    let context = Object.assign({}, options.context || {});
    let photos = (options.photos || []).slice();
    const byUrl = {};             // angle key -> photo URL
    const initial = options.angles || {};
    Object.keys(initial).forEach(key => { const url = photos[initial[key]]; if (url) byUrl[key] = url; });
    let touched = Object.keys(byUrl).length > 0;

    const angles = () => photoProtocol(schema, context);
    function autoMap() {
      // Until staff map anything by hand, follow the protocol order: photo 1
      // is the first angle, photo 2 the second…
      if (touched) return;
      angles().forEach((angle, index) => { if (photos[index]) byUrl[angle.key] = photos[index]; else delete byUrl[angle.key]; });
    }
    function indices() {
      const out = {};
      angles().forEach(angle => { const index = photos.indexOf(byUrl[angle.key]); if (index !== -1) out[angle.key] = index; });
      return out;
    }
    function status() {
      const map = indices();
      const visible = angles();
      const required = visible.filter(angle => angle.required);
      return {
        mapped: Object.keys(map).length, total: visible.length,
        requiredMapped: required.filter(angle => angle.key in map).length, required: required.length,
        missing: required.filter(angle => !(angle.key in map)).map(angle => angle.label)
      };
    }
    function render() {
      autoMap();
      const map = indices();
      const s = status();
      root.innerHTML = `
        <div class="cpp" data-photo-protocol="${esc(schema.key)}">
          <div class="cpp-head"><div><span class="cpp-eyebrow">INTAKE PHOTO PROTOCOL · ${esc(String(schema.label).toUpperCase())}</span>
            <p>Shoot these single-angle views in order. Each one is mapped to a gallery photo below.</p></div>
            <span class="cpp-count ${s.requiredMapped === s.required ? "done" : ""}" data-cpp-count>${s.requiredMapped} / ${s.required} required angles</span></div>
          <ol class="cpp-list">
            ${angles().map(angle => `
              <li class="cpp-angle ${angle.key in map ? "mapped" : ""}" data-cpp-angle="${esc(angle.key)}">
                <span class="cpp-dot" aria-hidden="true"></span>
                <div class="cpp-copy"><strong>${esc(angle.label)}</strong>${angle.required ? "" : ' <em class="cpp-optional">Optional</em>'}${angle.hint ? `<span>${esc(angle.hint)}</span>` : ""}</div>
                <select class="sel-mini" data-cpp-select aria-label="Photo for ${esc(angle.label)}">
                  <option value="-1">Not captured yet</option>
                  ${photos.map((url, i) => `<option value="${i}" ${map[angle.key] === i ? "selected" : ""}>Photo ${i + 1}${i === 0 ? " · Cover" : ""}</option>`).join("")}
                </select>
              </li>`).join("")}
          </ol>
        </div>`;
      if (typeof options.onChange === "function") options.onChange(s);
    }
    root.addEventListener("change", event => {
      const select = event.target.closest("[data-cpp-select]");
      if (!select) return;
      const key = select.closest("[data-cpp-angle]").dataset.cppAngle;
      const index = Number(select.value);
      touched = true;
      if (index >= 0 && photos[index]) byUrl[key] = photos[index]; else delete byUrl[key];
      render();
    });
    render();
    return {
      schema,
      setPhotos(urls) { photos = (urls || []).slice(); Object.keys(byUrl).forEach(key => { if (photos.indexOf(byUrl[key]) === -1) delete byUrl[key]; }); render(); },
      setContext(next) { context = Object.assign({}, context, next || {}); render(); },
      read: indices,
      status,
      reset() { Object.keys(byUrl).forEach(key => delete byUrl[key]); touched = false; photos = []; render(); },
      destroy() { root.innerHTML = ""; }
    };
  }

  global.CatalogSchemas = {
    get document() { return documentNow(); },
    get source() { return source; },
    load, onChange, expandDocument,
    resolve, subcategoriesFor, isVisible, isRequired, photoProtocol, inspectionApplies, hiddenCoreFields,
    coerce, validate, project, convert, formatValue, autoTags, cleanTags, specifications,
    mountForm, mountPhotoProtocol
  };
})(typeof window !== "undefined" ? window : globalThis);
