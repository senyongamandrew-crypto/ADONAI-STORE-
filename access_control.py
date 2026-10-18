"""Optional, owner-managed POS area passwords.

Passwords are PBKDF2 hashes. Unlock sessions are random, database-backed tokens
(not JWTs or environment keys), so they work across workers and deployments.
Checkout is deliberately never a protectable area.
"""
from datetime import datetime, timedelta
import hashlib
import json
import secrets
import uuid

from sqlalchemy.exc import IntegrityError
from database import get_db
from models import PosAccessKey, PosAccessSession, StoreSetting
from security import hash_pin, verify_pin

OWNER_ID = "OWNER"
POLICY_KEY = "pos_access_protected_areas"
SESSION_SECONDS = 1800
AREAS = {
    "finance": {"label": "Finance & sales analytics", "description": "Financial ledgers, expenses, bale costs, partner settlements and sales analytics.", "views": ["overview", "payments", "partners"]},
    "stock": {"label": "Stock management & intake", "description": "Inventory editing, stock deletion and catalog intake. Checkout and product search stay open.", "views": ["inventory", "intake"]},
    "orders": {"label": "Orders, dispatch & audit", "description": "Order history, fulfillment, delivery dispatch and posting audit logs.", "views": ["sales", "customers", "dispatch"]},
    "settings": {"label": "Store settings", "description": "Changes to store details, contact numbers and delivery fees.", "views": ["settings"]},
}


def _tokens(headers):
    value = next((str(v) for k, v in (headers or {}).items() if k.lower() == "x-pos-access"), "")
    if len(value) > 2048:
        return []
    return [part.strip() for part in value.split(",")[:10] if 32 <= len(part.strip()) <= 128]


def _digest(token):
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _scopes(key):
    if key.is_admin:
        return set(AREAS) | {"security"}
    try:
        return set(json.loads(key.areas)) & set(AREAS)
    except (TypeError, ValueError):
        return set()


def _protected(session):
    row = session.get(StoreSetting, POLICY_KEY)
    if not row:
        return set()
    try:
        values = json.loads(row.value)
        if not isinstance(values, list):
            raise ValueError("invalid policy")
        return set(values) & set(AREAS)
    except (TypeError, ValueError):
        return set(AREAS)  # Corrupt configuration must never silently unlock data.


def _set_protected(session, areas):
    row = session.get(StoreSetting, POLICY_KEY)
    value = json.dumps(sorted(areas))
    if row:
        row.value = value
    else:
        session.add(StoreSetting(key=POLICY_KEY, value=value))


def state(headers=None, session=None, *, token_hashes=None):
    if session is None:
        with get_db() as db:
            return state(headers, db, token_hashes=token_hashes)
    keys = session.query(PosAccessKey).all()
    by_id = {key.id: key for key in keys}
    owner = by_id.get(OWNER_ID)
    granted = set()
    admin = False
    hashes = token_hashes if token_hashes is not None else [_digest(token) for token in _tokens(headers)]
    if hashes:
        rows = session.query(PosAccessSession).filter(
            PosAccessSession.token_hash.in_(hashes),
            PosAccessSession.expires_at > datetime.utcnow(),
        ).all()
        for row in rows:
            key = by_id.get(row.key_id)
            if key and key.enabled and row.key_version == key.version:
                granted.update(_scopes(key))
                admin = admin or key.is_admin
    return {
        "protected": _protected(session), "granted": granted,
        "admin_configured": bool(owner), "admin_unlocked": admin,
        "counts": {area: sum(1 for key in keys if not key.is_admin and key.enabled and area in _scopes(key)) for area in AREAS},
    }


def allowed(area, access):
    if area == "security":
        return not access["admin_configured"] or access["admin_unlocked"]
    return area not in access["protected"] or area in access["granted"]


def public_policy(headers=None, session=None):
    access = state(headers, session)
    return {
        "ok": True, "admin_configured": access["admin_configured"],
        "admin_unlocked": access["admin_unlocked"], "session_seconds": SESSION_SECONDS,
        "protected_areas": sorted(access["protected"]),
        "areas": [dict(info, id=area, protected=area in access["protected"], unlocked=allowed(area, access), password_count=access["counts"][area]) for area, info in AREAS.items()],
    }


def required_area(method, path, body):
    if path == "/api/consignment/partners/choices" and method == "GET":
        return "stock"
    if path.startswith("/api/consignment/"):
        return "finance"
    if path == "/api/exports/prepare" and method == "POST":
        if not isinstance(body.get("kind", "sales"), str): return None
        return {"sales": "orders", "orders": "orders", "customers": "orders", "ledger": "finance", "expenses": "finance", "journal": "finance", "stock": "stock", "staff": "security"}.get(body.get("kind", "sales"))
    if path == "/api/settings" and method in {"POST", "PUT", "PATCH"}:
        return "settings"
    if path.startswith(("/api/products", "/api/media/", "/api/promo-media/")) and method in {"POST", "PUT", "PATCH", "DELETE"}:
        return "stock"
    if path.startswith("/api/finance/"):
        return "finance"
    if path.startswith(("/api/riders", "/api/dispatch/")):
        return "orders"
    if (path == "/api/orders" and method == "GET") or (path.startswith("/api/orders/") and method in {"PUT", "PATCH", "DELETE"}):
        return "orders"
    # POST /api/orders, channel=pos, and inventory reservation calls are never
    # guarded: a customer sale must not become an admin-password operation.
    return None


def locked_response(area):
    label = "Password management" if area == "security" else AREAS[area]["label"]
    return 403, {"ok": False, "code": "AREA_PASSWORD_REQUIRED", "area": area, "error": f"Enter the password set by the admin for {label}."}


def guard_request(method, path, body, headers):
    area = required_area(method, path, body)
    return locked_response(area) if area and not allowed(area, state(headers)) else None


def sanitize_product(data, access):
    if not allowed("stock", access) and "finance" not in access["granted"]:
        data = dict(data)
        for key in ("cost_price", "staff_notes", "stock_lot_id", "lot_grade_id", "profit", "gross_profit"):
            data.pop(key, None)
    return data


# The base-price / transport allocation is an internal costing rule. Cashiers
# and administrators need it in the consoles and the ledger; a shopper must
# never see it. Storefront payloads therefore drop the split inputs entirely
# and carry only the one flat delivery charge that is actually collected.
STOREFRONT_INTERNAL_PRICING = (
    "base_price",
    "total_transport_cost",
    "embedded_transport_portion",
    "checkout_transport_portion",
)

# Internal costing, staff paperwork and lot bookkeeping never belong in a
# shopper-facing payload. They were only removed when the operator had put
# the Stock area behind a password; a store with no area passwords — the
# common case — was publishing its cost price and staff notes on the public
# product list. The public channel always drops them.
STOREFRONT_INTERNAL_FIELDS = (
    "cost_price",
    "profit",
    "gross_profit",
    "staff_notes",
    "stock_lot_id",
    "lot_grade_id",
    "fulfillment_notes",
)


def sanitize_storefront_pricing(data):
    """Replace the internal transport allocation with a single delivery charge."""
    data = dict(data)
    try:
        delivery_fee = round(float(data.get("checkout_transport_portion") or 0), 2)
    except (TypeError, ValueError):
        delivery_fee = 0.0
    for key in STOREFRONT_INTERNAL_PRICING:
        data.pop(key, None)
    data["delivery_fee"] = delivery_fee
    return data


def sanitize_storefront_product(data):
    """Full public-channel scrub for a shopper-facing product payload.

    Drops the internal costing, staff and lot fields, then replaces the
    transport allocation with the single delivery charge a shopper sees.
    """
    data = dict(data or {})
    for key in STOREFRONT_INTERNAL_FIELDS:
        data.pop(key, None)
    return sanitize_storefront_pricing(data)


def sanitize_sale(data, access):
    data = dict(data)
    if not allowed("orders", access):
        for key in ("customer_name", "customer_phone", "customer_address", "customer_email", "delivery_notes", "delivery_address", "customer_notes", "customer_location", "rider", "rider_id", "rider_name", "assigned_rider_id", "assigned_rider_name"):
            data.pop(key, None)
    if not allowed("finance", access) or (not allowed("stock", access) and "finance" not in access["granted"]):
        for key in ("cost_total", "profit_total", "gross_profit", "cost_of_goods_sold", "margin"):
            data.pop(key, None)
        data["items"] = [{k: v for k, v in item.items() if k not in {
            "unit_cost", "cost_price", "cost_total", "consignment_partner_id",
            "partner_name_snapshot", "commission_rate_snapshot", "consignment_gross_amount",
            "consignment_commission_amount", "partner_payable_amount",
        }} for item in data.get("items", [])]
    return data


NOTIFICATION_AREAS = {
    "NEW_ORDER": "orders", "NEW_MESSAGE": "orders", "ORDER_UPDATED": "orders",
    "ORDER_PAID": "orders", "ORDER_EXPIRED": "orders",
    "DELIVERY_ASSIGNED": "orders", "DELIVERY_PROGRESS": "orders",
    "RIDER_ADDED": "orders", "RIDER_UPDATED": "orders", "RIDER_STATUS_UPDATED": "orders",
    "RIDER_ARCHIVED": "orders", "RIDER_PAIRING_CODE_ISSUED": "orders",
    "RIDER_PHONE_PAIRED": "orders", "RIDER_PHONE_REVOKED": "orders",
    "RIDER_DUTY_STARTED": "orders", "RIDER_DUTY_STOPPED": "orders",
    "NEW_EXPENSE": "finance", "EXPENSE_UPDATED": "finance", "EXPENSE_VOIDED": "finance",
    "STOCK_LOT_RECEIVED": "finance", "STOCK_MARKDOWN": "finance", "STOCK_WRITTEN_OFF": "finance",
    "CONSIGNMENT_PARTNER_ADDED": "finance", "CONSIGNMENT_PARTNER_UPDATED": "finance",
    "CONSIGNMENT_PAYOUT": "finance",
    "STOCK_ADDED": "stock", "STOCK_UPDATED": "stock", "STOCK_REMOVED": "stock", "LOW_STOCK": "stock",
    "SETTINGS_UPDATED": "settings",
}


def notification_allowed(event, access):
    area = NOTIFICATION_AREAS.get(str(event.get("type", "")))
    return not area or allowed(area, access)


def sanitize_notification(event, access):
    """Keep the bell useful when locked, without leaking protected details."""
    data = dict(event)
    area = NOTIFICATION_AREAS.get(str(event.get("type", "")))
    data["area"] = area
    data["protected"] = bool(area and not allowed(area, access))
    if not data["protected"]:
        return data
    # Replace ALL free text and payloads: customer notes, amounts, supplier
    # costs, IDs and private settings must never survive in a locked alert.
    titles = {"orders": "New order activity", "finance": "New finance activity",
              "stock": "New stock activity", "settings": "Store settings updated"}
    if data.get("type") == "NEW_ORDER":
        titles["orders"] = "Checkout recorded" if (event.get("payload") or {}).get("channel") == "pos" else "New order received"
    elif str(data.get("type", "")).startswith(("RIDER_", "DELIVERY_")):
        titles["orders"] = "New delivery activity"
    data["title"] = titles[area]
    data["message"] = f"Unlock {AREAS[area]['label']} to view the details."
    data["payload"] = {}
    return data


def filter_stream_frame(frame, staff):
    raw = isinstance(frame, bytes)
    text = frame.decode("utf-8") if raw else frame
    if text.startswith("data: "):
        try:
            event = json.loads(text[6:].strip())
            access = state(token_hashes=staff.get("_pos_access_token_hashes", []))
            filtered = "data: " + json.dumps(sanitize_notification(event, access), ensure_ascii=False) + "\n\n"
            return filtered.encode("utf-8") if raw else filtered
        except (ValueError, TypeError):
            return b": invalid event\n\n" if raw else ": invalid event\n\n"
    return frame


def _password(value):
    if not isinstance(value, str) or not 8 <= len(value.strip()) <= 128:
        raise ValueError("Use a password of 8–128 characters.")
    return value.strip()


def _areas(value):
    if not isinstance(value, list) or not value or any(not isinstance(area, str) or area not in AREAS for area in value):
        raise ValueError("Choose at least one valid protected area. The register cannot be password-locked.")
    return sorted(set(value))


def _name(value):
    if not isinstance(value, str) or not 1 <= len(value.strip()) <= 80:
        raise ValueError("Give each password a name of 1–80 characters.")
    return value.strip()


def _issue(session, key):
    token = secrets.token_urlsafe(32)
    expires = datetime.utcnow() + timedelta(seconds=SESSION_SECONDS)
    session.query(PosAccessSession).filter(PosAccessSession.expires_at <= datetime.utcnow()).delete(synchronize_session=False)
    session.add(PosAccessSession(token_hash=_digest(token), key_id=key.id, key_version=key.version, expires_at=expires))
    session.flush()
    return {"token": token, "expires_at": expires.isoformat() + "Z", "key_id": key.id, "key_name": key.name, "is_admin": key.is_admin, "areas": sorted(_scopes(key))}


def _revoke(session, key):
    key.version += 1
    session.query(PosAccessSession).filter_by(key_id=key.id).delete(synchronize_session=False)


def handle_request(method, path, body, headers, may_bootstrap=True):
    """Returns (status, safe JSON); no response ever includes password hashes."""
    prefix = "/api/pos-access"
    try:
        with get_db() as session:
            access = state(headers, session)
            owner = session.get(PosAccessKey, OWNER_ID)
            if path == prefix + "/policy" and method == "GET":
                return 200, public_policy(headers, session)
            if path == prefix + "/lock" and method == "POST":
                digests = [_digest(token) for token in _tokens(headers)]
                if digests:
                    session.query(PosAccessSession).filter(PosAccessSession.token_hash.in_(digests)).delete(synchronize_session=False)
                return 200, {"ok": True, "policy": public_policy({}, session)}
            if path == prefix + "/unlock" and method == "POST":
                area = body.get("area")
                if area not in set(AREAS) | {"security"}:
                    return 400, {"ok": False, "error": "Unknown protected area."}
                password = _password(body.get("password"))
                candidates = session.query(PosAccessKey).filter_by(enabled=True).all()
                # Try the owner first; never allow an area key to manage passwords.
                candidates.sort(key=lambda key: not key.is_admin)
                for key in candidates:
                    if area in _scopes(key) and verify_pin(password, key.password_hash):
                        unlocked = _issue(session, key)
                        return 200, {"ok": True, "session": unlocked, "policy": public_policy({"x-pos-access": unlocked["token"]}, session)}
                return 403, {"ok": False, "code": "INCORRECT_AREA_PASSWORD", "error": "Incorrect password for this area. Try again."}

            if path == prefix + "/admin" and method == "POST":
                if owner and not access["admin_unlocked"]:
                    return locked_response("security")
                if not owner and not may_bootstrap:
                    return 403, {"ok": False, "error": "Only an admin may set up the initial admin password."}
                password = _password(body.get("password"))
                if any(verify_pin(password, key.password_hash) for key in session.query(PosAccessKey).filter_by(is_admin=False).all()):
                    raise ValueError("The admin password must be different from every area password.")
                if owner:
                    _revoke(session, owner)
                    owner.password_hash = hash_pin(password)
                else:
                    owner = PosAccessKey(id=OWNER_ID, name="Administrator", password_hash=hash_pin(password), areas=json.dumps(list(AREAS)), is_admin=True, enabled=True, version=1)
                    session.add(owner)
                session.flush()
                unlocked = _issue(session, owner)
                return 200, {"ok": True, "session": unlocked, "policy": public_policy({"x-pos-access": unlocked["token"]}, session)}

            if not allowed("security", access):
                return locked_response("security")
            if path == prefix + "/keys" and method == "GET":
                keys = session.query(PosAccessKey).filter_by(is_admin=False).order_by(PosAccessKey.created_at).all()
                return 200, {"ok": True, "keys": [key.to_public() for key in keys], "policy": public_policy(headers, session)}
            if not owner:
                return 409, {"ok": False, "error": "Set your optional admin password first."}

            if path == prefix + "/policy" and method == "PATCH":
                areas = body.get("protected_areas")
                if not isinstance(areas, list) or any(not isinstance(area, str) or area not in AREAS for area in areas):
                    return 400, {"ok": False, "error": "Choose valid areas. Checkout always stays open."}
                _set_protected(session, set(areas))
                session.flush()
                return 200, public_policy(headers, session)

            if path == prefix + "/admin" and method == "DELETE":
                if body.get("confirm") is not True:
                    return 400, {"ok": False, "error": "Confirm removal of all optional passwords."}
                session.query(PosAccessSession).delete(synchronize_session=False)
                session.query(PosAccessKey).delete(synchronize_session=False)
                _set_protected(session, set())
                session.flush()
                return 200, {"ok": True, "policy": public_policy({}, session)}

            if path == prefix + "/keys" and method == "POST":
                supplied = body.get("keys")
                existing = session.query(PosAccessKey).filter_by(is_admin=False).all()
                if not isinstance(supplied, list) or not 1 <= len(supplied) <= 10 or len(existing) + len(supplied) > 20:
                    return 400, {"ok": False, "error": "Save 1–10 passwords at a time, with at most 20 area passwords."}
                prepared = []
                names = {key.name.casefold() for key in existing}
                for item in supplied:
                    if not isinstance(item, dict) or set(item) - {"name", "password", "areas"}:
                        raise ValueError("Invalid password entry.")
                    name, password, areas = _name(item.get("name")), _password(item.get("password")), _areas(item.get("areas"))
                    if name.casefold() in names:
                        raise ValueError("Use a different name for each password.")
                    names.add(name.casefold())
                    if verify_pin(password, owner.password_hash):
                        raise ValueError("Area passwords must be different from your admin password.")
                    prepared.append((name, hash_pin(password), areas))
                created = []
                protected = _protected(session)
                for name, password_hash, areas in prepared:
                    key = PosAccessKey(id=uuid.uuid4().hex, name=name, password_hash=password_hash, areas=json.dumps(areas), is_admin=False, enabled=True, version=1)
                    session.add(key)
                    created.append(key)
                    protected.update(areas)
                _set_protected(session, protected)
                session.flush()
                return 201, {"ok": True, "keys": [key.to_public() for key in created], "policy": public_policy(headers, session)}

            if path.startswith(prefix + "/keys/") and method in {"PATCH", "DELETE"}:
                key = session.get(PosAccessKey, path.rsplit("/", 1)[-1])
                if not key or key.is_admin:
                    return 404, {"ok": False, "error": "Area password not found."}
                if method == "DELETE":
                    _revoke(session, key)
                    session.delete(key)
                else:
                    if not body or set(body) - {"name", "password", "areas", "enabled"}:
                        raise ValueError("Invalid password changes.")
                    if "name" in body:
                        name = _name(body["name"])
                        if session.query(PosAccessKey).filter(PosAccessKey.id != key.id, PosAccessKey.name == name).first():
                            raise ValueError("That password name is already in use.")
                        key.name = name
                    if "password" in body:
                        password = _password(body["password"])
                        if verify_pin(password, owner.password_hash):
                            raise ValueError("Use a different password from the admin password.")
                        key.password_hash = hash_pin(password)
                    if "areas" in body:
                        areas = _areas(body["areas"])
                        key.areas = json.dumps(areas)
                        _set_protected(session, _protected(session) | set(areas))
                    if "enabled" in body:
                        if not isinstance(body["enabled"], bool):
                            raise ValueError("Password status must be enabled or disabled.")
                        key.enabled = body["enabled"]
                    _revoke(session, key)
                session.flush()
                # Revoking a staff password NEVER silently removes area protection;
                # the admin can turn off the area's protection separately.
                return 200, {"ok": True, "policy": public_policy(headers, session)}
            return 404, {"ok": False, "error": "Password settings route not found."}
    except ValueError as error:
        return 400, {"ok": False, "error": str(error)}
    except IntegrityError:
        return 409, {"ok": False, "error": "Password settings changed in another session. Reload and try again."}
