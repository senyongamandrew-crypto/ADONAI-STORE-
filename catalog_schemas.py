"""
Adonai Store — Dynamic category field schemas
=============================================

Catalog intake is schema-driven: the selected category + sub-category resolve
to ONE JSON schema that lists only the inputs, units, validation rules, photo
angles and inspection points that belong to that product class. An earring is
measured in millimetres and grams and is never asked for inches or fabric; a
shirt is measured flat in inches / centimetres and is never asked for a
backing type.

Source of truth
---------------
``data/category_field_schemas.json`` is the canonical, hand-edited document.
At boot it is seeded into the ``category_field_schemas`` table (one row per
schema, ``definition`` stored as JSONB on PostgreSQL), and the API serves the
table back to every client. A row an operator edits directly in SQL is marked
``source = 'custom'`` and is never overwritten by a later seed.

Product storage
---------------
``products.attributes`` (JSONB) holds the category-specific record::

    {
      "schema_key": "earrings", "schema_version": 1, "complete": true,
      "values": {"length": {"value": 12.5, "unit": "mm"}, "backing_type": "Lever-Back"},
      "inspection": {"tread_wear": "Light wear"},
      "photo_angles": {"macro_front": 0, "backing_closure": 1}
    }

Global columns stay first-class (name, sku, brand, stock_lot_id, lot_grade_id,
cost_price, base_price, in_stock_count, desc, search_tags_json,
fulfillment_notes). Schema fields can *project* into legacy columns so older
screens keep working: ``projects_to: "fabric" | "size"`` and ``flat_lay_key``
(garment / shoe flat-lay measurements, converted to inches for the PDP card).

This module never imports ``models`` at import time (models imports it).
"""
from __future__ import annotations

import copy
import json
import logging
import os
import re
import threading
import time

logger = logging.getLogger("adonai.catalog_schemas")

ROOT = os.path.dirname(os.path.abspath(__file__))
DEFAULTS_PATH = os.path.join(ROOT, "data", "category_field_schemas.json")

FIELD_TYPES = {"measure", "number", "select", "multiselect", "boolean", "size", "text"}
PROJECTION_TARGETS = {"fabric", "size"}
MAX_PHOTO_INDEX = 11
CACHE_SECONDS = 60

_lock = threading.Lock()
_defaults_cache: dict | None = None
_active: dict | None = None
_active_loaded_at = 0.0


class SchemaValidationError(ValueError):
    """Raised when an attributes payload does not satisfy its schema."""

    def __init__(self, message: str, field_errors: dict | None = None):
        super().__init__(message)
        self.field_errors = field_errors or {}


# ---------------------------------------------------------------------------
# Loading
# ---------------------------------------------------------------------------
def expand_document(raw: dict) -> dict:
    """Resolve ``options_ref`` / ``ratings_ref`` so every schema is self-contained."""
    doc = copy.deepcopy(raw)
    option_sets = doc.get("option_sets") or {}
    for key, schema in (doc.get("schemas") or {}).items():
        schema["key"] = key
        for section in schema.get("sections") or []:
            for field in section.get("fields") or []:
                ref = field.pop("options_ref", None)
                if ref:
                    if ref not in option_sets:
                        raise ValueError(f"Schema {key}.{field.get('key')} references unknown option set {ref}")
                    field["options"] = list(option_sets[ref])
        inspection = schema.get("inspection")
        if inspection:
            ref = inspection.pop("ratings_ref", None)
            if ref:
                inspection["ratings"] = list(option_sets[ref])
    return doc


def validate_document(doc: dict) -> list[str]:
    """Structural checks for a schema document. Returns human-readable problems."""
    problems = []
    units = doc.get("units") or {}
    schemas = doc.get("schemas") or {}
    for key, schema in schemas.items():
        seen = set()
        for section in schema.get("sections") or []:
            for field in section.get("fields") or []:
                fkey = field.get("key")
                if not fkey or not re.fullmatch(r"[a-z][a-z0-9_]{0,39}", fkey):
                    problems.append(f"{key}: invalid field key {fkey!r}")
                if fkey in seen:
                    problems.append(f"{key}: duplicate field key {fkey}")
                seen.add(fkey)
                ftype = field.get("type")
                if ftype not in FIELD_TYPES:
                    problems.append(f"{key}.{fkey}: unknown type {ftype}")
                if ftype == "measure":
                    for unit in field.get("units") or []:
                        if unit not in units:
                            problems.append(f"{key}.{fkey}: unknown unit {unit}")
                    if not field.get("units"):
                        problems.append(f"{key}.{fkey}: measure fields need units")
                if ftype in {"select", "multiselect"} and not field.get("options"):
                    problems.append(f"{key}.{fkey}: choice fields need options")
                if ftype == "size" and not field.get("scales"):
                    problems.append(f"{key}.{fkey}: size fields need scales")
                target = field.get("projects_to")
                if target and target not in PROJECTION_TARGETS:
                    problems.append(f"{key}.{fkey}: unknown projection {target}")
        for angle in schema.get("photo_protocol") or []:
            if not angle.get("key") or not angle.get("label"):
                problems.append(f"{key}: photo angles need key and label")
    for category, entries in (doc.get("taxonomy") or {}).items():
        names = [entry[0] for entry in entries]
        if len(names) != len(set(names)):
            problems.append(f"taxonomy {category}: duplicate sub-category")
        for name, schema_key in entries:
            if schema_key not in schemas:
                problems.append(f"taxonomy {category}/{name}: unknown schema {schema_key}")
    return problems


def load_defaults() -> dict:
    """The expanded canonical document from disk (cached, returned as a copy)."""
    global _defaults_cache
    with _lock:
        if _defaults_cache is None:
            with open(DEFAULTS_PATH, "r", encoding="utf-8") as handle:
                doc = expand_document(json.load(handle))
            problems = validate_document(doc)
            if problems:
                raise ValueError("Invalid category field schemas: " + "; ".join(problems[:5]))
            _defaults_cache = doc
        return copy.deepcopy(_defaults_cache)


def document() -> dict:
    """The active registry (DB-backed after seeding/refresh, defaults otherwise)."""
    global _active
    with _lock:
        if _active is not None:
            return _active
    doc = load_defaults()
    with _lock:
        if _active is None:
            _active = doc
        return _active


def _set_active(doc: dict) -> None:
    global _active, _active_loaded_at
    with _lock:
        _active = doc
        _active_loaded_at = time.time()


def public_document(doc: dict | None = None) -> dict:
    """The payload served to browsers / the Android console."""
    doc = doc or document()
    return {
        "version": doc.get("version"),
        "units": doc.get("units") or {},
        "global_fields": doc.get("global_fields") or [],
        "taxonomy": doc.get("taxonomy") or {},
        "schemas": doc.get("schemas") or {},
    }


# ---------------------------------------------------------------------------
# Database mirror (category_field_schemas)
# ---------------------------------------------------------------------------
def _applies_to(doc: dict) -> dict[str, list[dict]]:
    out: dict[str, list[dict]] = {}
    position = 0
    for category, entries in (doc.get("taxonomy") or {}).items():
        for name, schema_key in entries:
            out.setdefault(schema_key, []).append({"category": category, "subcategory": name, "position": position})
            position += 1
    return out


def seed_schemas(session) -> int:
    """Upsert system schemas into category_field_schemas. Returns rows written."""
    from models import CategoryFieldSchema  # local import: models imports this module

    doc = load_defaults()
    applies = _applies_to(doc)
    written = 0
    for key, schema in doc["schemas"].items():
        mapping = applies.get(key, [])
        definition = {k: v for k, v in schema.items() if k not in {"key"}}
        row = session.query(CategoryFieldSchema).filter_by(schema_key=key).first()
        values = dict(
            version=int(schema.get("version") or 1),
            label=str(schema.get("label") or key)[:120],
            category_group=str(schema.get("group") or "")[:120],
            profile=str(schema.get("profile") or "")[:30],
            categories=sorted({entry["category"] for entry in mapping}),
            subcategories=[entry["subcategory"] for entry in mapping],
            applies_to=mapping,
            definition=definition,
        )
        if row is None:
            session.add(CategoryFieldSchema(schema_key=key, source="system", active=True, **values))
            written += 1
            continue
        if (row.source or "system") != "system":
            continue  # operator-customised rows are never overwritten
        if (int(row.version or 0) < values["version"] or row.definition != definition
                or row.applies_to != mapping):
            for attr, value in values.items():
                setattr(row, attr, value)
            written += 1
    session.flush()
    refresh_from_db(session)
    if written:
        logger.info("Seeded %s category field schema row(s).", written)
    return written


def refresh_from_db(session, force: bool = True) -> dict:
    """Rebuild the active registry from the table; falls back to defaults."""
    if not force and _active is not None and time.time() - _active_loaded_at < CACHE_SECONDS:
        return _active
    from models import CategoryFieldSchema

    base = load_defaults()
    try:
        rows = session.query(CategoryFieldSchema).filter(CategoryFieldSchema.active.is_(True)).all()
    except Exception as exc:  # pragma: no cover - table missing on a half-migrated DB
        logger.warning("category_field_schemas unavailable, using bundled defaults: %s", exc)
        _set_active(base)
        return base
    if not rows:
        _set_active(base)
        return base
    schemas, placements = {}, []
    for row in rows:
        definition = copy.deepcopy(row.definition or {})
        if not isinstance(definition, dict) or not definition.get("sections"):
            continue
        definition["key"] = row.schema_key
        definition["version"] = int(row.version or definition.get("version") or 1)
        schemas[row.schema_key] = definition
        for entry in row.applies_to or []:
            if isinstance(entry, dict) and entry.get("category") and entry.get("subcategory"):
                placements.append((int(entry.get("position", 0)), entry["category"], entry["subcategory"], row.schema_key))
    taxonomy: dict[str, list] = {}
    for _, category, name, schema_key in sorted(placements):
        taxonomy.setdefault(category, []).append([name, schema_key])
    doc = dict(base, schemas=schemas, taxonomy=taxonomy)
    problems = validate_document(doc)
    if problems:
        logger.error("Ignoring invalid category_field_schemas rows: %s", "; ".join(problems[:5]))
        doc = base
    _set_active(doc)
    return doc


# ---------------------------------------------------------------------------
# Resolution
# ---------------------------------------------------------------------------
def subcategories_for(category: str, doc: dict | None = None) -> list[str]:
    doc = doc or document()
    return [entry[0] for entry in (doc.get("taxonomy") or {}).get(str(category or ""), [])]


def resolve(category: str, subcategory: str = "", doc: dict | None = None):
    """Return ``(schema_key, schema, subcategory)`` for a category pair.

    An empty sub-category resolves to the category's first entry. An unknown
    sub-category raises ``SchemaValidationError`` so typos never silently land
    on the wrong form. Categories without a taxonomy return ``(None, None, "")``.
    """
    doc = doc or document()
    entries = (doc.get("taxonomy") or {}).get(str(category or ""), [])
    if not entries:
        return None, None, ""
    wanted = str(subcategory or "").strip()
    if not wanted:
        name, key = entries[0]
        return key, doc["schemas"].get(key), name
    for name, key in entries:
        if name.lower() == wanted.lower():
            return key, doc["schemas"].get(key), name
    raise SchemaValidationError(
        f'"{wanted}" is not a sub-category of {category}. Choose one of: ' + ", ".join(e[0] for e in entries),
        {"subcategory": "Unknown sub-category"},
    )


def _condition_matches(condition: dict | None, context: dict) -> bool:
    if not condition:
        return True
    sub = context.get("subcategory") or ""
    state = context.get("item_condition") or ""
    if "subcategory" in condition and sub not in condition["subcategory"]:
        return False
    if "not_subcategory" in condition and sub in condition["not_subcategory"]:
        return False
    if "condition" in condition and state not in condition["condition"]:
        return False
    return True


def field_visible(field: dict, context: dict) -> bool:
    return _condition_matches(field.get("when"), context)


def field_required(field: dict, context: dict) -> bool:
    if not field_visible(field, context):
        return False
    if field.get("required"):
        return True
    when = field.get("required_when")
    return bool(when) and _condition_matches(when, context)


def iter_fields(schema: dict):
    for section in schema.get("sections") or []:
        for field in section.get("fields") or []:
            yield section, field


def visible_photo_protocol(schema: dict, context: dict) -> list[dict]:
    return [angle for angle in schema.get("photo_protocol") or [] if _condition_matches(angle.get("when"), context)]


def inspection_applies(schema: dict, context: dict) -> bool:
    inspection = schema.get("inspection") or {}
    applies_to = inspection.get("applies_to")
    return bool(inspection.get("points")) and (not applies_to or context.get("item_condition") in applies_to)


# ---------------------------------------------------------------------------
# Value coercion
# ---------------------------------------------------------------------------
def _clean_text(value, limit: int = 80) -> str:
    text = re.sub(r"[\x00-\x1f\x7f]+", " ", str(value or "")).strip()
    return re.sub(r"\s{2,}", " ", text)[:limit]


def _number(value):
    if isinstance(value, bool):
        return None
    try:
        number = float(str(value).strip()) if isinstance(value, str) else float(value)
    except (TypeError, ValueError):
        return None
    if number != number or number in (float("inf"), float("-inf")):
        return None
    return number


def _fmt(number: float) -> str:
    text = f"{number:.2f}".rstrip("0").rstrip(".")
    return text or "0"


def convert(value: float, from_unit: str, to_unit: str, units: dict) -> float:
    """Convert between length units; other dimensions must match exactly."""
    if from_unit == to_unit:
        return value
    a, b = units.get(from_unit) or {}, units.get(to_unit) or {}
    if a.get("dimension") == b.get("dimension") == "length":
        return value * float(a["per_mm"]) / float(b["per_mm"])
    raise ValueError(f"Cannot convert {from_unit} to {to_unit}")


def _empty(value) -> bool:
    return value is None or value == "" or value == [] or value == {}


def coerce_value(field: dict, raw, units: dict):
    """Return the normalized stored value for one field, or raise ValueError."""
    ftype = field["type"]
    label = field.get("label") or field["key"]
    if ftype == "measure":
        allowed = field.get("units") or []
        if isinstance(raw, dict):
            number, unit = _number(raw.get("value")), str(raw.get("unit") or allowed[0])
        else:
            number, unit = _number(raw), allowed[0]
        if unit not in allowed:
            raise ValueError(f"{label} must be recorded in {' or '.join(allowed)}")
        if number is None or number <= 0:
            raise ValueError(f"{label} must be a positive number")
        low, high = (field.get("range") or [0, 10 ** 6])
        in_default = convert(number, unit, allowed[0], units)
        if in_default < low - 1e-9 or in_default > high + 1e-9:
            if unit == allowed[0]:
                raise ValueError(f"{label} must be between {_fmt(low)} and {_fmt(high)} {allowed[0]}")
            low_u, high_u = convert(low, allowed[0], unit, units), convert(high, allowed[0], unit, units)
            raise ValueError(f"{label} must be between {_fmt(low_u)} and {_fmt(high_u)} {unit}")
        return {"value": round(number, 2), "unit": unit}
    if ftype == "number":
        number = _number(raw)
        if number is None:
            raise ValueError(f"{label} must be a number")
        if field.get("integer"):
            if abs(number - round(number)) > 1e-9:
                raise ValueError(f"{label} must be a whole number")
            number = int(round(number))
        low, high = (field.get("range") or [0, 10 ** 6])
        if number < low or number > high:
            raise ValueError(f"{label} must be between {_fmt(low)} and {_fmt(high)}")
        return number
    if ftype == "select":
        text = _clean_text(raw)
        options = field.get("options") or []
        match = next((option for option in options if option.lower() == text.lower()), None)
        if match:
            return match
        if field.get("allow_other") and text:
            return text
        raise ValueError(f"{label}: choose one of the listed options")
    if ftype == "multiselect":
        items = raw if isinstance(raw, list) else [part for part in str(raw or "").split(",")]
        options = field.get("options") or []
        out = []
        for item in items[:12]:
            text = _clean_text(item)
            if not text:
                continue
            match = next((option for option in options if option.lower() == text.lower()), None)
            if not match and not field.get("allow_other"):
                raise ValueError(f"{label}: {text} is not a listed option")
            value = match or text
            if value not in out:
                out.append(value)
        return out
    if ftype == "boolean":
        if isinstance(raw, bool):
            return raw
        text = str(raw).strip().lower()
        if text in {"true", "yes", "1", "y"}:
            return True
        if text in {"false", "no", "0", "n"}:
            return False
        if field.get("allow_unknown") and text in {"unknown", "unverified", "not verified"}:
            return "unknown"
        raise ValueError(f"{label}: answer yes or no")
    if ftype == "size":
        scales = field.get("scales") or []
        if isinstance(raw, dict):
            value, scale = _clean_text(raw.get("value"), 12), str(raw.get("scale") or scales[0])
        else:
            value, scale = _clean_text(raw, 12), scales[0]
        if scale not in scales:
            raise ValueError(f"{label}: use the {' / '.join(scales)} scale")
        if not value:
            raise ValueError(f"{label} is required")
        return {"value": value, "scale": scale}
    if ftype == "text":
        return _clean_text(raw, int(field.get("max_length") or 120))
    raise ValueError(f"Unsupported field type {ftype}")


def display_value(field: dict, value, units: dict | None = None) -> str:
    """Shopper/staff friendly rendering of a stored value."""
    units = units or document().get("units") or {}
    ftype = field.get("type")
    if ftype == "measure" and isinstance(value, dict):
        number, unit = float(value.get("value") or 0), value.get("unit")
        text = f"{_fmt(number)} {unit}"
        if unit in {"in", "cm"}:
            other = "cm" if unit == "in" else "in"
            text += f" ({_fmt(round(convert(number, unit, other, units), 1))} {other})"
        return text
    if ftype == "size" and isinstance(value, dict):
        return f"{value.get('scale')} {value.get('value')}"
    if ftype == "boolean":
        if value == "unknown":
            return field.get("unknown_label") or "Not verified"
        return (field.get("true_label") or "Yes") if value else (field.get("false_label") or "No")
    if ftype == "multiselect" and isinstance(value, list):
        return ", ".join(value)
    return str(value)


# ---------------------------------------------------------------------------
# Normalization (validate + project)
# ---------------------------------------------------------------------------
def _summary(errors: dict) -> str:
    items = list(errors.values())
    head = "; ".join(items[:3]) + (f"; and {len(items) - 3} more" if len(items) > 3 else "")
    return f"Fix {len(items)} category detail{'s' if len(items) != 1 else ''}: {head}"


def normalize_attributes(raw, category: str, subcategory: str = "", item_condition: str = "",
                         enforce_required: bool = True, doc: dict | None = None) -> dict:
    """Validate an attributes payload against the resolved schema.

    Returns ``{"schema_key", "subcategory", "attributes", "projections"}``.
    Hidden / unknown keys are dropped (stale values never leak), visible
    values are coerced, and required fields are enforced when asked. Raises
    ``SchemaValidationError`` with per-field messages on failure.
    """
    doc = doc or document()
    units = doc.get("units") or {}
    key, schema, sub = resolve(category, subcategory, doc)
    if schema is None:
        return {"schema_key": None, "subcategory": sub, "attributes": {}, "projections": {}}
    raw = raw if isinstance(raw, dict) else {}
    declared = str(raw.get("schema_key") or "").strip()
    if declared and declared != key:
        raise SchemaValidationError(
            f'These details were captured on the "{declared}" form, but {category} / {sub} uses the "{key}" form. Reopen the item and fill its details again.',
            {"schema_key": "Schema mismatch"},
        )
    context = {"subcategory": sub, "item_condition": str(item_condition or "").upper()}
    supplied = raw.get("values") if isinstance(raw.get("values"), dict) else {}
    values, errors = {}, {}

    for section, field in iter_fields(schema):
        fkey = field["key"]
        if not field_visible(field, context):
            continue
        incoming = supplied.get(fkey)
        if _empty(incoming) or (isinstance(incoming, dict) and _empty(incoming.get("value"))):
            if enforce_required and field_required(field, context):
                errors[fkey] = f"{field.get('label')} is required"
            continue
        try:
            value = coerce_value(field, incoming, units)
        except ValueError as exc:
            errors[fkey] = str(exc)
            continue
        if _empty(value):
            if enforce_required and field_required(field, context):
                errors[fkey] = f"{field.get('label')} is required"
            continue
        values[fkey] = value

    for section in schema.get("sections") or []:
        rule = section.get("require_any")
        if enforce_required and rule and _condition_matches(rule.get("when"), context):
            keys = rule.get("keys") or []
            if not any(k in values for k in keys) and not any(k in errors for k in keys):
                errors[keys[0] if keys else section.get("id", "section")] = rule.get("message") or "Fill at least one measurement"

    inspection_values = {}
    if inspection_applies(schema, context):
        inspection = schema["inspection"]
        ratings = inspection.get("ratings") or []
        supplied_inspection = raw.get("inspection") if isinstance(raw.get("inspection"), dict) else {}
        for point in inspection.get("points") or []:
            rating = _clean_text(supplied_inspection.get(point["key"]))
            match = next((r for r in ratings if r.lower() == rating.lower()), None)
            if match:
                inspection_values[point["key"]] = match
            elif rating:
                errors[f"inspection.{point['key']}"] = f"{point['label']}: choose a listed rating"
            elif enforce_required and point.get("required"):
                errors[f"inspection.{point['key']}"] = f"{point['label']} must be rated"

    angles = {}
    protocol_keys = {angle["key"] for angle in visible_photo_protocol(schema, context)}
    supplied_angles = raw.get("photo_angles") if isinstance(raw.get("photo_angles"), dict) else {}
    for angle_key, index in supplied_angles.items():
        if angle_key not in protocol_keys:
            continue
        number = _number(index)
        if number is not None and float(number).is_integer() and 0 <= number <= MAX_PHOTO_INDEX:
            angles[angle_key] = int(number)

    if errors:
        raise SchemaValidationError(_summary(errors), errors)

    complete = all(
        not field_required(field, context) or field["key"] in values for _, field in iter_fields(schema)
    ) and (not inspection_applies(schema, context) or all(
        point["key"] in inspection_values for point in schema["inspection"].get("points") or [] if point.get("required")
    ))
    attributes = {"schema_key": key, "schema_version": int(schema.get("version") or 1), "complete": bool(complete), "values": values}
    if inspection_values:
        attributes["inspection"] = inspection_values
    if angles:
        attributes["photo_angles"] = angles
    return {"schema_key": key, "subcategory": sub, "attributes": attributes,
            "projections": project(schema, values, units)}


def project(schema: dict, values: dict, units: dict | None = None) -> dict:
    """Legacy-column projections: fabric, size and inch flat-lay measurements."""
    units = units or document().get("units") or {}
    fabric_parts, size_text, flat_lay = [], "", {}
    for _, field in iter_fields(schema):
        value = values.get(field["key"])
        if _empty(value):
            continue
        target = field.get("projects_to")
        if target == "fabric":
            text = display_value(field, value, units) if field["type"] != "measure" else ""
            if text and text.lower() != "none" and text not in fabric_parts:
                fabric_parts.append(text)
        elif target == "size" and not size_text:
            if field["type"] == "measure":
                size_text = f"{_fmt(value['value'])} {value['unit']}"
            elif field["type"] == "size":
                size_text = f"{value['scale']} {value['value']}"
            else:
                size_text = str(value)
        flat_key = field.get("flat_lay_key")
        if flat_key and field["type"] == "measure":
            unit = value.get("unit")
            if (units.get(unit) or {}).get("dimension") == "length":
                inches = round(convert(float(value["value"]), unit, "in", units), 2)
                if 0 < inches <= 120:
                    flat_lay[flat_key] = inches
    out = {}
    if fabric_parts:
        out["fabric"] = " · ".join(fabric_parts)[:255]
    if size_text:
        out["size"] = size_text[:20]
    if flat_lay:
        out["measurements"] = flat_lay
    return out


# ---------------------------------------------------------------------------
# Search tags & specifications
# ---------------------------------------------------------------------------
def clean_tags(raw) -> list[str]:
    items = raw if isinstance(raw, list) else str(raw or "").split(",")
    out = []
    for item in items:
        tag = _clean_text(item, 40).lower()
        if tag and tag not in out:
            out.append(tag)
        if len(out) >= 24:
            break
    return out


def auto_search_tags(*, category: str = "", subcategory: str = "", brand: str = "", color: str = "",
                     item_condition: str = "", attributes: dict | None = None, doc: dict | None = None) -> list[str]:
    """Deterministic tags for storefront / POS search (mirrored in the browser)."""
    doc = doc or document()
    tags = [subcategory, category]
    if brand and brand.strip().lower() not in {"unbranded", ""}:
        tags.append(brand)
    if color:
        tags.append(color)
    tags.append("brand new" if str(item_condition).upper() == "BRAND_NEW" else "pre-loved")
    attributes = attributes or {}
    schema = (doc.get("schemas") or {}).get(attributes.get("schema_key") or "")
    values = attributes.get("values") or {}
    if schema:
        for _, field in iter_fields(schema):
            value = values.get(field["key"])
            if _empty(value):
                continue
            if field["type"] == "boolean" and field.get("tag_label") and value is True:
                tags.append(field["tag_label"])
            elif field.get("tag") and field["type"] in {"select", "text"} and str(value).lower() != "none":
                tags.append(str(value))
            elif field.get("tag") and field["type"] == "multiselect":
                tags.extend(value)
    return clean_tags(tags)


def specifications(attributes, doc: dict | None = None) -> list[dict]:
    """Display-ready rows (section, label, value) for PDP / POS / exports."""
    if not isinstance(attributes, dict) or not attributes.get("values"):
        return []
    doc = doc or document()
    schema = (doc.get("schemas") or {}).get(attributes.get("schema_key") or "")
    if not schema:
        return []
    units = doc.get("units") or {}
    values = attributes.get("values") or {}
    rows = []
    for section, field in iter_fields(schema):
        value = values.get(field["key"])
        if _empty(value):
            continue
        try:
            text = display_value(field, value, units)
        except Exception:
            continue
        rows.append({"section": section.get("title") or "", "key": field["key"], "label": field.get("label") or field["key"], "value": text})
    inspection = schema.get("inspection") or {}
    for point in inspection.get("points") or []:
        rating = (attributes.get("inspection") or {}).get(point["key"])
        if rating:
            rows.append({"section": inspection.get("title") or "Condition inspection", "key": f"inspection.{point['key']}", "label": point["label"], "value": rating})
    return rows


def photo_angle_labels(attributes) -> dict:
    """``{photo_index: angle label}`` so galleries can caption mapped shots."""
    if not isinstance(attributes, dict):
        return {}
    schema = (document().get("schemas") or {}).get(attributes.get("schema_key") or "")
    if not schema:
        return {}
    labels = {angle["key"]: angle["label"] for angle in schema.get("photo_protocol") or []}
    out = {}
    for key, index in (attributes.get("photo_angles") or {}).items():
        if key in labels and isinstance(index, int):
            out[str(index)] = labels[key]
    return out
