"""
Adonai Thrift Store — REST API & Service Layer
Dual-target architecture supporting Public Web Storefront & Native Android POS App.
Provides RESTful JSON endpoints connected to PostgreSQL / SQLite database with
atomic stock decrements, live synchronization, and JWT / Terminal Key authentication.
"""
import base64
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo
import hashlib
import hmac
import json
import logging
import os
from sqlalchemy import and_, func, inspect, or_, text
import time
import uuid

from database import DATABASE_URL, IS_POSTGRES, engine, get_db
from pricing import transport_allocation, whole_money
from models import (
    AccountingJournalEntry,
    AccountingJournalLine,
    Category,
    ExpenseRecord,
    Inventory,
    InventoryAdjustment,
    InventoryLock,
    LedgerEntry,
    Order,
    OrderItem,
    Product,
    Rider,
    StockLot,
    StoreSetting,
    User,
)

logger = logging.getLogger("adonai.api")

# Configuration for JWT & Terminal Key Signatures
JWT_SECRET = os.environ.get("JWT_SECRET") or os.environ.get("ADMIN_ACCESS_PIN") or os.environ.get("STAFF_TERMINAL_KEY") or "adonai-pos-terminal-signing-secret-key-2026"

ADMIN_ENV_VARS = [
    "ADMIN_ACCESS_PIN", "ADMIN_PIN", "ADMIN_KEY", "ADMIN_ACCESS_KEY",
    "ADMIN_MASTER_KEY", "MASTER_KEY", "MASTER_PIN", "STORE_MASTER_KEY",
    "RENDER_ADMIN_KEY", "TERMINAL_ADMIN_KEY"
]

STAFF_ENV_VARS = [
    "STAFF_TERMINAL_KEY", "STAFF_ACCESS_KEY", "STAFF_KEY", "TERMINAL_KEY",
    "STAFF_ACCESS_PIN", "STAFF_PIN", "STAFF_TERMINAL_PIN",
    "POS_TERMINAL_KEY", "POS_ACCESS_KEY", "POS_ACCESS_PIN",
    "POS_KEY", "POS_PIN", "TERMINAL_PIN", "POS_MASTER_KEY"
]

# Settings that may be read by the public storefront. Authentication keys and
# operational flags are intentionally excluded from public API responses.
PUBLIC_STORE_SETTING_KEYS = {
    "store_name", "tagline", "address", "whatsapp", "whatsapp_display",
    "phone", "hotline", "email", "tiktok", "instagram", "hours",
    "delivery_scope", "base_delivery_fee", "boda_base_fee", "currency",
    "receipt_footer", "website_url", "app_url"
}

# Parameters accepted from the protected System Parameters screen. Secret keys
# can be updated by an authorized admin but are never returned publicly.
EDITABLE_STORE_SETTING_KEYS = PUBLIC_STORE_SETTING_KEYS | {
    "master_key", "admin_key"
}


def public_store_settings(rows) -> dict:
    """Serialize only settings that are safe and useful on the storefront."""
    return {row.key: row.value for row in rows if row.key in PUBLIC_STORE_SETTING_KEYS}


# ============================================================================
# JWT & Authentication Helpers
# ============================================================================
def b64url_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("utf-8").rstrip("=")


def b64url_decode(s: str) -> bytes:
    padding = 4 - (len(s) % 4)
    if padding < 4:
        s += "=" * padding
    return base64.urlsafe_b64decode(s)


def create_jwt_token(payload: dict, expires_in_sec: int = 86400 * 30) -> str:
    """Generates standard HMAC-SHA256 JWT token for staff terminal sessions."""
    header = {"alg": "HS256", "typ": "JWT"}
    body = dict(payload)
    now = int(time.time())
    body["iat"] = now
    body["exp"] = now + expires_in_sec
    h_enc = b64url_encode(json.dumps(header).encode("utf-8"))
    p_enc = b64url_encode(json.dumps(body).encode("utf-8"))
    msg = f"{h_enc}.{p_enc}".encode("utf-8")
    sig = hmac.new(JWT_SECRET.encode("utf-8"), msg, hashlib.sha256).digest()
    sig_enc = b64url_encode(sig)
    return f"{h_enc}.{p_enc}.{sig_enc}"


def verify_jwt_token(token: str) -> dict | None:
    """Verifies HMAC-SHA256 signature and expiration on incoming JWT token."""
    try:
        parts = str(token or "").strip().split(".")
        if len(parts) != 3:
            return None
        h_enc, p_enc, sig_enc = parts
        msg = f"{h_enc}.{p_enc}".encode("utf-8")
        expected_sig = hmac.new(JWT_SECRET.encode("utf-8"), msg, hashlib.sha256).digest()
        actual_sig = b64url_decode(sig_enc)
        if not hmac.compare_digest(expected_sig, actual_sig):
            return None
        payload = json.loads(b64url_decode(p_enc).decode("utf-8"))
        if payload.get("exp", 0) < int(time.time()):
            return None
        return payload
    except Exception:
        return None


def is_authenticated_staff(headers: dict = None, body: dict = None, query_params: dict = None) -> tuple[bool, dict | None]:
    """
    Validates if incoming request comes from an authenticated POS terminal or Admin.
    Checks Bearer JWT header, X-Terminal-Key header, query token, or body key.
    """
    headers = headers or {}
    body = body or {}
    query_params = query_params or {}

    auth_header = str(headers.get("authorization", "") or "").strip()
    terminal_header = str(headers.get("x-terminal-key", "") or headers.get("x-staff-token", "") or "").strip()
    query_token = (query_params.get("token") or query_params.get("key") or [""])[0].strip()

    candidate = ""
    if auth_header.lower().startswith("bearer "):
        candidate = auth_header[7:].strip()
    elif terminal_header:
        candidate = terminal_header
    elif query_token:
        candidate = query_token
    elif body.get("token") or body.get("terminal_key") or body.get("key") or body.get("pin"):
        candidate = str(body.get("token") or body.get("terminal_key") or body.get("key") or body.get("pin")).strip()

    if not candidate:
        return False, None

    # 1. Check JWT token
    jwt_payload = verify_jwt_token(candidate)
    if jwt_payload:
        return True, {
            "id": jwt_payload.get("sub", "STF-TOKEN"),
            "name": jwt_payload.get("name", "Staff Member"),
            "role": jwt_payload.get("role", "cashier")
        }

    # 2. Check Admin Environment Variables
    for var in ADMIN_ENV_VARS:
        val = str(os.environ.get(var) or "").strip()
        if val and (candidate == val or candidate.lower() == val.lower()):
            return True, {"id": "ENV-ADMIN", "name": "Store Owner / Admin", "role": "admin"}

    # 3. Check Staff Environment Variables
    for var in STAFF_ENV_VARS:
        val = str(os.environ.get(var) or "").strip()
        if val and (candidate == val or candidate.lower() == val.lower()):
            return True, {"id": "ENV-STAFF", "name": "POS Staff Terminal", "role": "cashier"}

    # 4. Check Default Sandbox Master Key
    if candidate == "ADONAI-MASTER-2026" or candidate.lower() == "adonai-master-2026":
        return True, {"id": "ENV-ADMIN", "name": "Store Owner / Admin", "role": "admin"}

    # 5. Check Database Seed Users
    pin_hash = hashlib.sha256(candidate.encode("utf-8")).hexdigest()
    try:
        with get_db() as session:
            user = (
                session.query(User)
                .filter(User.active.is_(True))
                .filter(or_(User.pin_hash == pin_hash, User.pin_hash == candidate))
                .first()
            )
            if user:
                return True, {"id": user.id, "name": user.name, "role": user.role}
    except Exception:
        pass

    return False, None


def generate_uid(prefix: str = "ID") -> str:
    """Generates unique collision-safe identifier with millisecond timestamp + random suffix."""
    return f"{prefix}-{int(time.time() * 1000)}-{uuid.uuid4().hex[:6].upper()}"


def json_response(data, status=200):
    """Formats Python data into standard HTTP JSON payload."""
    payload = json.dumps(data, default=str)
    return status, "application/json; charset=utf-8", payload.encode("utf-8")


KAMPALA_TZ = ZoneInfo("Africa/Kampala")
FINANCE_MANAGER_ROLES = {"admin", "manager"}
ACCOUNT_NAMES = {
    "1000": "Cash Drawer",
    "1010": "Mobile Money",
    "1020": "Bank Account",
    "1100": "Accounts Receivable",
    "1200": "Inventory Asset",
    "1300": "Logistics / Transport Expense",
    "4000": "Sales Revenue",
    "5000": "Cost of Goods Sold",
    "5100": "Operating Expense",
    "5200": "Inventory Write-Off Loss",
}


def payment_account(method: str) -> tuple[str, str]:
    value = str(method or "cash").strip().lower().replace("-", "_").replace(" ", "_")
    if value in {"mtn", "airtel", "mobile", "mobile_money", "momo"}:
        return "1010", ACCOUNT_NAMES["1010"]
    if value in {"bank", "bank_transfer", "card"}:
        return "1020", ACCOUNT_NAMES["1020"]
    return "1000", ACCOUNT_NAMES["1000"]


def parse_positive_int(value, field: str, allow_zero: bool = False) -> int:
    try:
        result = int(value)
    except (TypeError, ValueError):
        raise ValueError(f"{field} must be a whole number")
    if result < 0 or (result == 0 and not allow_zero):
        raise ValueError(f"{field} must be {'zero or greater' if allow_zero else 'greater than zero'}")
    return result


def parse_operator_datetime(value) -> datetime:
    """Convert a browser datetime (Kampala local) or ISO UTC value to naive UTC."""
    if not value:
        return datetime.utcnow()
    raw = str(value).strip().replace("Z", "+00:00")
    parsed = datetime.fromisoformat(raw)
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=KAMPALA_TZ)
    return parsed.astimezone(timezone.utc).replace(tzinfo=None)


def date_bounds_utc(date_value: str | None) -> tuple[datetime, datetime, str]:
    if date_value:
        local_date = datetime.strptime(str(date_value), "%Y-%m-%d").date()
    else:
        local_date = datetime.now(KAMPALA_TZ).date()
    start_local = datetime.combine(local_date, datetime.min.time(), tzinfo=KAMPALA_TZ)
    end_local = start_local + timedelta(days=1)
    return (
        start_local.astimezone(timezone.utc).replace(tzinfo=None),
        end_local.astimezone(timezone.utc).replace(tzinfo=None),
        local_date.isoformat(),
    )


def authenticated_or_response(headers, body, query_params, manager=False):
    is_authed, staff = is_authenticated_staff(headers, body, query_params)
    if not is_authed:
        return None, json_response({
            "ok": False,
            "error": "Sign in to the staff terminal to use Financial Ledgers",
        }, status=401)
    if manager and str((staff or {}).get("role", "")).lower() not in FINANCE_MANAGER_ROLES:
        return None, json_response({
            "ok": False,
            "error": "Manager or administrator authorization is required",
        }, status=403)
    return staff or {}, None


def create_journal_entry(session, *, reference, source, description, occurred_at,
                         staff, lines, reversal_of_id=None):
    """Post one balanced, immutable double-entry journal transaction."""
    normalised = []
    debit_total = 0
    credit_total = 0
    for line in lines:
        debit = max(0, int(line.get("debit", 0) or 0))
        credit = max(0, int(line.get("credit", 0) or 0))
        if (debit > 0) == (credit > 0):
            raise ValueError("Each journal line must contain exactly one debit or credit")
        debit_total += debit
        credit_total += credit
        normalised.append((line, debit, credit))
    if not normalised or debit_total != credit_total:
        raise ValueError("Journal entry is not balanced")

    entry = AccountingJournalEntry(
        id=generate_uid("JRN"),
        reference=str(reference)[:100],
        source=str(source)[:50],
        description=str(description or "")[:2000],
        status="POSTED",
        occurred_at=occurred_at or datetime.utcnow(),
        created_by_id=(staff or {}).get("id"),
        created_by_name=(staff or {}).get("name"),
        reversal_of_id=reversal_of_id,
    )
    session.add(entry)
    for line, debit, credit in normalised:
        code = str(line["account_code"])
        session.add(AccountingJournalLine(
            id=generate_uid("JLN"),
            journal_entry_id=entry.id,
            account_code=code,
            account_name=line.get("account_name") or ACCOUNT_NAMES.get(code, code),
            debit=debit,
            credit=credit,
            memo=str(line.get("memo", ""))[:2000],
        ))
    return entry


def reverse_journal_entry(session, original, *, source, description, staff, occurred_at=None):
    if not original:
        raise ValueError("Original journal entry was not found")
    lines = [{
        "account_code": line.account_code,
        "account_name": line.account_name,
        "debit": line.credit,
        "credit": line.debit,
        "memo": f"Reversal of {original.reference}",
    } for line in original.lines]
    reversal = create_journal_entry(
        session,
        reference=f"REV-{original.reference}"[:100],
        source=source,
        description=description,
        occurred_at=occurred_at or datetime.utcnow(),
        staff=staff,
        lines=lines,
        reversal_of_id=original.id,
    )
    original.status = "REVERSED"
    return reversal


def sale_journal_lines(total: int, cogs: int, tender_type: str):
    payment_code, payment_name = payment_account(tender_type)
    lines = [
        {"account_code": payment_code, "account_name": payment_name, "debit": total},
        {"account_code": "4000", "account_name": ACCOUNT_NAMES["4000"], "credit": total},
    ]
    if cogs:
        lines.extend([
            {"account_code": "5000", "account_name": ACCOUNT_NAMES["5000"], "debit": cogs},
            {"account_code": "1200", "account_name": ACCOUNT_NAMES["1200"], "credit": cogs},
        ])
    return lines


def handle_api_request(method: str, path: str, query_params: dict, body_bytes: bytes, headers: dict = None) -> tuple[int, str, bytes]:
    """
    Unified router for backend /api/* endpoints.
    Distinguishes public e-commerce storefront traffic from protected POS terminal traffic.
    Returns (status_code, content_type, response_body_bytes).
    """
    try:
        headers = headers or {}
        body = {}
        if body_bytes and method in ("POST", "PUT", "PATCH"):
            try:
                body = json.loads(body_bytes.decode("utf-8"))
            except Exception:
                body = {}

        # Strip trailing slashes from path
        clean_path = path.rstrip("/")

        # ----------------------------------------------------
        # 1. Health & Status (Public)
        # ----------------------------------------------------
        if clean_path == "/api/health" and method == "GET":
            inspector = inspect(engine)
            tables = inspector.get_table_names()
            pool_info = {}
            if hasattr(engine.pool, "size"):
                pool_info = {
                    "size": engine.pool.size(),
                    "checkedin": engine.pool.checkedin(),
                    "checkedout": engine.pool.checkedout(),
                    "overflow": engine.pool.overflow()
                }

            return json_response({
                "status": "healthy",
                "database": "connected",
                "dialect": engine.dialect.name,
                "is_postgres": IS_POSTGRES,
                "tables_count": len(tables),
                "tables": tables,
                "pool": pool_info,
                "timestamp": datetime.utcnow().isoformat()
            })

        # ----------------------------------------------------
        # 2. Products API (Public Catalog Read, Protected Intake)
        # ----------------------------------------------------
        if clean_path == "/api/products" and method == "GET":
            with get_db() as session:
                q = session.query(Product)
                
                # Search filter
                search = query_params.get("search", [""])[0].strip().lower()
                if search:
                    pattern = f"%{search}%"
                    q = q.filter(or_(
                        Product.name.ilike(pattern),
                        Product.brand.ilike(pattern),
                        Product.sku.ilike(pattern),
                        Product.barcode_id.ilike(pattern),
                        Product.desc.ilike(pattern)
                    ))
                
                # Demographic filter
                demo = query_params.get("demographic", [""])[0]
                if demo and demo != "All":
                    q = q.filter(Product.demographic == demo)

                # Category filter
                cat = query_params.get("category", [""])[0]
                if cat and cat != "All":
                    q = q.filter(Product.category == cat)

                # Condition filter
                cond = query_params.get("condition", [""])[0]
                if cond and cond != "All":
                    q = q.filter(Product.condition == cond)

                # Max price filter
                if "max_price" in query_params:
                    try:
                        max_p = int(query_params["max_price"][0])
                        q = q.filter(Product.selling_price <= max_p)
                    except ValueError:
                        pass

                public_availability = query_params.get("availability", [""])[0] == "public"
                if public_availability:
                    q = q.filter(Product.inventory_status.notin_(["ARCHIVED", "WRITTEN_OFF"]))

                # Sort: in-stock first, then newest. Public availability subtracts
                # unexpired POS holds without changing the authoritative count.
                q = q.order_by(Product.in_stock_count.desc(), Product.created_at.desc())
                products = q.all()
                held = {}
                if public_availability and products:
                    rows = (
                        session.query(InventoryLock.product_id, func.sum(InventoryLock.quantity))
                        .filter(InventoryLock.expires_at > datetime.utcnow())
                        .group_by(InventoryLock.product_id)
                        .all()
                    )
                    held = {product_id: int(quantity or 0) for product_id, quantity in rows}
                # Social proof must come from real commerce data.  Never invent
                # reviews or a five-star score: expose completed-unit counts and
                # leave review fields empty until verified reviews exist.
                sold_rows = (
                    session.query(OrderItem.product_id, func.sum(OrderItem.qty))
                    .join(Order, Order.id == OrderItem.order_id)
                    .filter(Order.status == "completed")
                    .group_by(OrderItem.product_id)
                    .all()
                )
                sold_counts = {product_id: int(quantity or 0) for product_id, quantity in sold_rows}
                prods = []
                for product in products:
                    data = product.to_dict()
                    data["authoritative_stock_count"] = data["in_stock_count"]
                    data["in_stock_count"] = max(0, data["in_stock_count"] - held.get(product.id, 0))
                    data["available_count"] = data["in_stock_count"]
                    data["sales_count"] = sold_counts.get(product.id, 0)
                    data["average_rating"] = None
                    data["review_count"] = 0
                    prods.append(data)
                return json_response({"count": len(prods), "products": prods, "as_of": datetime.utcnow().isoformat() + "Z"})

        if clean_path == "/api/products" and method == "POST":
            # Protected endpoint: Product Intake requires Staff Terminal authentication
            is_authed, staff_info = is_authenticated_staff(headers, body, query_params)
            if not is_authed:
                return json_response({
                    "ok": False,
                    "error": "Unauthorized: Staff terminal authentication required for product intake"
                }, status=401)

            try:
                supplied_base = body.get("base_price", body.get("selling_price"))
                base_price = parse_positive_int(supplied_base, "Base price")
                transport_cost = parse_positive_int(body.get("total_transport_cost", 0), "Total transport cost", allow_zero=True)
                allocation = transport_allocation(base_price, transport_cost)
                selling_price = whole_money(allocation["final_selling_price"])
                stock_count = parse_positive_int(body.get("in_stock_count", 1), "Stock quantity", allow_zero=True)
                supplied_cost = parse_positive_int(body.get("cost_price", 0), "Cost price", allow_zero=True)
                compare_price = parse_positive_int(body.get("compare_price", 0), "Compare price", allow_zero=True)
            except ValueError as exc:
                return json_response({"ok": False, "error": str(exc)}, status=400)

            with get_db() as session:
                pid = body.get("id") or generate_uid("PRD")
                sku = body.get("sku") or generate_uid("ADN-GEN")
                barcode_id = body.get("barcode_id") or generate_uid("ADT")
                lot_id = str(body.get("stock_lot_id") or "").strip() or None
                lot = None
                if lot_id:
                    lot = session.query(StockLot).filter_by(id=lot_id).with_for_update().first()
                    if not lot:
                        return json_response({"ok": False, "error": "Selected stock lot was not found"}, status=404)
                    if lot.allocated_count + stock_count > lot.item_count:
                        return json_response({"ok": False, "error": "Selected stock lot does not have enough unallocated items"}, status=409)
                    lot.allocated_count += stock_count
                    if lot.allocated_count >= lot.item_count:
                        lot.status = "ALLOCATED"
                    if supplied_cost <= 0:
                        supplied_cost = lot.unit_cost
                    # Bale breakdowns allocate the lot's transport evenly per
                    # item when intake did not provide an item-level override.
                    if "total_transport_cost" not in body:
                        transport_cost = (lot.shipping_cost or 0) / max(1, lot.item_count)
                        allocation = transport_allocation(base_price, transport_cost)
                        selling_price = whole_money(allocation["final_selling_price"])

                prod = Product(
                    id=pid,
                    sku=sku,
                    barcode_id=barcode_id,
                    name=str(body.get("name", "Untitled Piece")).strip() or "Untitled Piece",
                    brand=body.get("brand", "Vintage"),
                    color=body.get("color", ""),
                    demographic=body.get("demographic", "Men"),
                    category=body.get("category", "Outerwear & Jackets"),
                    size=body.get("size", "-"),
                    condition=body.get("condition", "Grade A — Excellent"),
                    cost_price=supplied_cost,
                    base_price=allocation["base_price"],
                    total_transport_cost=allocation["total_transport_cost"],
                    selling_price=selling_price,
                    compare_price=compare_price,
                    in_stock_count=stock_count,
                    desc=body.get("desc", ""),
                    image_url=body.get("image_url", ""),
                    images=body.get("images", []),
                    rack_location=body.get("rack_location", "Rail A-1"),
                    stock_lot_id=lot_id,
                    inventory_status="AVAILABLE",
                )
                session.add(prod)

                session.add(Inventory(
                    id=generate_uid("INV"),
                    product_id=pid,
                    sku=sku,
                    rack_location=body.get("rack_location", "Rail A-1"),
                    quantity=stock_count,
                    batch_reference=(lot.lot_code if lot else body.get("batch_reference", "BATCH-INTAKE")),
                    intake_staff_id=(staff_info or {}).get("id", "STF-01"),
                    notes=body.get("notes", "New product intake via POS")
                ))
                session.flush()
                return json_response({"status": "created", "product": prod.to_dict()}, status=201)

        if clean_path.startswith("/api/products/") and method in ("PUT", "PATCH", "DELETE"):
            staff_info, auth_error = authenticated_or_response(headers, body, query_params)
            if auth_error:
                return auth_error
            pid = clean_path.split("/")[-1]
            with get_db() as session:
                prod = session.query(Product).filter_by(id=pid).with_for_update().first()
                if not prod:
                    return json_response({"ok": False, "error": "Product not found"}, status=404)
                if method == "DELETE":
                    prod.inventory_status = "ARCHIVED"
                    prod.in_stock_count = 0
                    session.query(InventoryLock).filter_by(product_id=pid).delete(synchronize_session=False)
                    return json_response({"ok": True, "status": "archived", "product": prod.to_dict()})

                text_fields = {
                    "name", "brand", "color", "demographic", "category", "size",
                    "condition", "desc", "image_url", "rack_location", "inventory_status",
                }
                integer_fields = {"cost_price", "selling_price", "compare_price", "in_stock_count"}
                for key in text_fields:
                    if key in body:
                        setattr(prod, key, str(body[key] or "").strip())
                for key in integer_fields:
                    if key in body:
                        try:
                            value = int(body[key])
                        except (TypeError, ValueError):
                            return json_response({"ok": False, "error": f"{key} must be a whole number"}, status=400)
                        if value < 0 or (key == "selling_price" and value == 0):
                            return json_response({"ok": False, "error": f"Invalid {key}"}, status=400)
                        setattr(prod, key, value)
                if "images" in body:
                    prod.images = body.get("images") or []
                if "base_price" in body or "total_transport_cost" in body or "selling_price" in body:
                    try:
                        base = body.get("base_price", prod.base_price or prod.selling_price)
                        transport = body.get("total_transport_cost", prod.total_transport_cost or 0)
                        allocation = transport_allocation(base, transport)
                    except (ValueError, TypeError) as exc:
                        return json_response({"ok": False, "error": str(exc)}, status=400)
                    prod.base_price = allocation["base_price"]
                    prod.total_transport_cost = allocation["total_transport_cost"]
                    prod.selling_price = whole_money(allocation["final_selling_price"])
                if prod.in_stock_count > 0 and prod.inventory_status == "SOLD":
                    prod.inventory_status = "AVAILABLE"
                session.flush()
                return json_response({"ok": True, "status": "updated", "product": prod.to_dict()})

        if clean_path.startswith("/api/products/") and method == "GET":
            pid = clean_path.split("/")[-1]
            with get_db() as session:
                prod = session.query(Product).filter_by(id=pid).first()
                if not prod:
                    return json_response({"error": "Product not found"}, status=404)
                return json_response({"product": prod.to_dict()})

        # ----------------------------------------------------
        # 3. Real-time POS inventory locks (Protected)
        # ----------------------------------------------------
        if clean_path.startswith("/api/inventory-locks/") and method in ("GET", "POST"):
            staff_info, auth_error = authenticated_or_response(headers, body, query_params)
            if auth_error:
                return auth_error
            action = clean_path.split("/")[-1]
            owner = str(body.get("lock_owner") or query_params.get("lock_owner", [""])[0]).strip()[:100]
            if not owner:
                return json_response({"ok": False, "error": "lock_owner is required"}, status=400)
            now = datetime.utcnow()

            with get_db() as session:
                session.query(InventoryLock).filter(InventoryLock.expires_at <= now).delete(synchronize_session=False)
                if action == "status" and method == "GET":
                    rows = session.query(InventoryLock).filter_by(lock_owner=owner).all()
                    return json_response({"ok": True, "locks": [row.to_dict() for row in rows]})
                if action == "heartbeat" and method == "POST":
                    expires = now + timedelta(minutes=5)
                    count = session.query(InventoryLock).filter_by(lock_owner=owner).update(
                        {InventoryLock.expires_at: expires}, synchronize_session=False
                    )
                    return json_response({"ok": True, "refreshed": count, "expires_at": expires.isoformat() + "Z"})
                if action == "release-owner" and method == "POST":
                    count = session.query(InventoryLock).filter_by(lock_owner=owner).delete(synchronize_session=False)
                    return json_response({"ok": True, "released": count})

                product_id = str(body.get("product_id") or "").strip()
                if not product_id:
                    return json_response({"ok": False, "error": "product_id is required"}, status=400)
                product = session.query(Product).filter_by(id=product_id).with_for_update().first()
                if not product:
                    return json_response({"ok": False, "error": "Product not found"}, status=404)
                lock = session.query(InventoryLock).filter_by(
                    product_id=product_id, lock_owner=owner
                ).first()

                if action == "acquire" and method == "POST":
                    try:
                        quantity = parse_positive_int(body.get("quantity", 1), "Lock quantity")
                    except ValueError as exc:
                        return json_response({"ok": False, "error": str(exc)}, status=400)
                    held_by_others = int(session.query(func.coalesce(func.sum(InventoryLock.quantity), 0)).filter(
                        InventoryLock.product_id == product_id,
                        InventoryLock.lock_owner != owner,
                        InventoryLock.expires_at > now,
                    ).scalar() or 0)
                    current = int(lock.quantity if lock else 0)
                    if current + quantity > max(0, int(product.in_stock_count or 0) - held_by_others):
                        return json_response({
                            "ok": False,
                            "error": f"{product.name} is out of stock or held by another checkout",
                            "available": max(0, int(product.in_stock_count or 0) - held_by_others - current),
                        }, status=409)
                    expires = now + timedelta(minutes=5)
                    if lock:
                        lock.quantity += quantity
                        lock.expires_at = expires
                    else:
                        lock = InventoryLock(
                            id=generate_uid("LCK"),
                            product_id=product_id,
                            lock_owner=owner,
                            quantity=quantity,
                            expires_at=expires,
                            created_by_id=(staff_info or {}).get("id"),
                        )
                        session.add(lock)
                    session.flush()
                    return json_response({"ok": True, "lock": lock.to_dict()})

                if action == "release" and method == "POST":
                    if not lock:
                        return json_response({"ok": True, "released": 0})
                    try:
                        quantity = parse_positive_int(body.get("quantity", lock.quantity), "Release quantity")
                    except ValueError as exc:
                        return json_response({"ok": False, "error": str(exc)}, status=400)
                    if quantity >= lock.quantity:
                        released = lock.quantity
                        session.delete(lock)
                    else:
                        released = quantity
                        lock.quantity -= quantity
                    return json_response({"ok": True, "released": released})

                return json_response({"ok": False, "error": "Unknown inventory lock action"}, status=404)

        # ----------------------------------------------------
        # 4. Categories API (Public)
        # ----------------------------------------------------
        if clean_path == "/api/categories" and method == "GET":
            with get_db() as session:
                cats = [c.to_dict() for c in session.query(Category).order_by(Category.sort_order.asc()).all()]
                return json_response({"categories": cats})

        # ----------------------------------------------------
        # 4. Orders & Checkouts (Web Storefront & Android POS)
        # ----------------------------------------------------
        if clean_path == "/api/orders" and method == "GET":
            # Reading full sales history requires staff authentication
            is_authed, staff_info = is_authenticated_staff(headers, body, query_params)
            if not is_authed:
                return json_response({
                    "ok": False,
                    "error": "Unauthorized: Staff terminal authentication required to view sales ledger"
                }, status=401)

            with get_db() as session:
                q = session.query(Order)
                channel = query_params.get("channel", [""])[0]
                if channel:
                    q = q.filter(Order.channel == channel)
                orders = [o.to_dict() for o in q.order_by(Order.created_at.desc()).all()]
                return json_response({"count": len(orders), "orders": orders})

        if clean_path.startswith("/api/orders/") and method in ("PUT", "PATCH"):
            staff_info, auth_error = authenticated_or_response(headers, body, query_params)
            if auth_error:
                return auth_error
            order_id = clean_path.split("/")[-1]
            lifecycle = {"Unfulfilled", "In Assembly", "Ready for Pickup", "Dispatched", "Completed", "Cancelled"}
            with get_db() as session:
                order = session.query(Order).filter_by(id=order_id).with_for_update().first()
                if not order:
                    return json_response({"ok": False, "error": "Order not found"}, status=404)

                next_stage = body.get("fulfillment_status") or body.get("dispatch_status")
                if next_stage is not None:
                    next_stage = str(next_stage).strip()
                    if next_stage not in lifecycle:
                        return json_response({"ok": False, "error": "Unknown fulfillment status"}, status=400)
                    current = order.dispatch_status or "Unfulfilled"
                    allowed = {
                        "Pending": {"Unfulfilled", "In Assembly", "Cancelled"},
                        "Unfulfilled": {"In Assembly", "Cancelled"},
                        "In Assembly": {"Ready for Pickup", "Dispatched", "Cancelled"},
                        "Ready for Pickup": {"Completed", "Cancelled"},
                        "Dispatched": {"Completed", "Cancelled"},
                        "Completed": set(),
                        "Cancelled": set(),
                    }
                    if next_stage != current and next_stage not in allowed.get(current, set()):
                        return json_response({"ok": False, "error": f"Cannot move order from {current} to {next_stage}"}, status=409)
                    if next_stage == "Cancelled" and current != "Cancelled":
                        for item in order.items:
                            product = session.query(Product).filter_by(id=item.product_id).with_for_update().first()
                            if product:
                                product.in_stock_count = int(product.in_stock_count or 0) + int(item.qty or 0)
                                if product.inventory_status == "SOLD":
                                    product.inventory_status = "AVAILABLE"
                    order.dispatch_status = next_stage
                    order.status = (
                        "completed" if next_stage == "Completed"
                        else "cancelled" if next_stage == "Cancelled"
                        else "unfulfilled" if next_stage == "Unfulfilled"
                        else "processing"
                    )

                if "rider_id" in body or "rider_name" in body:
                    order.rider_id = str(body.get("rider_id") or "").strip() or None
                    order.rider_name = str(body.get("rider_name") or "").strip() or None
                if "payment_method" in body:
                    order.tender_type = str(body.get("payment_method") or "cash").strip().lower()
                order.updated_at = datetime.utcnow()
                session.flush()
                return json_response({"ok": True, "order": order.to_dict()})

        if clean_path == "/api/orders" and method == "POST":
            channel = str(body.get("channel", "web")).lower()
            lock_owner = str(body.get("lock_owner") or "").strip()[:100]

            if channel == "pos":
                is_authed, staff_info = is_authenticated_staff(headers, body, query_params)
                if not is_authed:
                    return json_response({
                        "ok": False,
                        "error": "Unauthorized: Staff terminal authentication required for POS transactions"
                    }, status=401)
                if not lock_owner:
                    return json_response({
                        "ok": False,
                        "error": "This POS cart has no inventory-lock owner. Remove and scan its items again."
                    }, status=409)
            else:
                staff_info = {"id": "WEB-GUEST", "name": "Web Storefront Customer", "role": "customer"}

            items_data = body.get("items", [])
            if not isinstance(items_data, list) or not items_data:
                return json_response({"error": "Order must contain at least one item"}, status=400)

            # Collapse duplicate product rows before checking stock and locks.
            requested = {}
            try:
                for item in items_data:
                    pid = str(item.get("product_id") or item.get("id") or "").strip()
                    if not pid:
                        raise ValueError("Every order item requires a product ID")
                    qty = parse_positive_int(item.get("qty", 1), f"Quantity for {pid}")
                    requested[pid] = requested.get(pid, 0) + qty
                # Ignore client-supplied flat fees. They are recalculated from
                # the catalog's explicit checkout transport portions below.
            except ValueError as exc:
                return json_response({"ok": False, "error": str(exc)}, status=400)

            # The Product rows serialize checkout, POS locking, and storefront
            # checkout. No stock is changed until every line has passed.
            with get_db() as session:
                now = datetime.utcnow()
                session.query(InventoryLock).filter(InventoryLock.expires_at <= now).delete(synchronize_session=False)
                products = {}
                active_locks = {}
                for pid in sorted(requested):
                    qty = requested[pid]
                    prod = session.query(Product).filter_by(id=pid).with_for_update().first()
                    if not prod or prod.inventory_status in {"ARCHIVED", "WRITTEN_OFF"}:
                        return json_response({"error": f"Product {pid} is unavailable"}, status=404)
                    locks = session.query(InventoryLock).filter(
                        InventoryLock.product_id == pid,
                        InventoryLock.expires_at > now,
                    ).all()
                    own_lock = next((row for row in locks if row.lock_owner == lock_owner), None)
                    held_by_others = sum(row.quantity for row in locks if row.lock_owner != lock_owner)
                    if qty > max(0, int(prod.in_stock_count or 0) - held_by_others):
                        return json_response({
                            "error": f"Product '{prod.name}' is held at the POS or already sold"
                        }, status=409)
                    if channel == "pos" and (not own_lock or own_lock.quantity < qty):
                        return json_response({
                            "error": f"The POS hold for '{prod.name}' expired. Scan the item again."
                        }, status=409)
                    products[pid] = prod
                    active_locks[pid] = own_lock

                delivery_fee = 0 if body.get("delivery_type", "boda") == "pickup" else sum(
                    whole_money((products[pid].checkout_transport_portion if products[pid].checkout_transport_portion is not None else (products[pid].total_transport_cost or 0) * 0.5) * requested[pid])
                    for pid in requested
                )
                order_id = body.get("id") or f"AT-{int(time.time() * 1000) % 1000000:06d}-{uuid.uuid4().hex[:4].upper()}"
                subtotal = 0
                cogs = 0
                order_items_objs = []
                for pid, qty in requested.items():
                    prod = products[pid]
                    unit_price = int(prod.selling_price or 0)
                    unit_cost = int(prod.cost_price or 0)
                    line_total = unit_price * qty
                    subtotal += line_total
                    cogs += unit_cost * qty
                    prod.in_stock_count -= qty
                    if prod.in_stock_count <= 0:
                        prod.in_stock_count = 0
                        prod.inventory_status = "SOLD"
                    order_items_objs.append(OrderItem(
                        id=f"ITEM-{order_id}-{len(order_items_objs) + 1}",
                        order_id=order_id,
                        product_id=prod.id,
                        barcode_id=prod.barcode_id,
                        name=prod.name,
                        unit_price=unit_price,
                        unit_cost=unit_cost,
                        category=prod.category,
                        qty=qty,
                        line_total=line_total,
                    ))
                    own_lock = active_locks.get(pid)
                    if own_lock:
                        if own_lock.quantity <= qty:
                            session.delete(own_lock)
                        else:
                            own_lock.quantity -= qty
                            own_lock.expires_at = now + timedelta(minutes=5)

                grand_total = subtotal + delivery_fee
                tender = body.get("tender") or {}
                cashier = body.get("cashier") or staff_info or {}
                tender_type = tender.get("type", "cash" if channel == "pos" else "mobile_money")
                order = Order(
                    id=order_id,
                    channel=channel,
                    # Web orders enter the POS fulfillment queue directly. They
                    # are not WhatsApp orders and always start unfulfilled.
                    status=("completed" if channel == "pos" else "unfulfilled"),
                    dispatch_status=("Completed" if channel == "pos" else "Unfulfilled"),
                    customer_name=body.get("customer_name", "Walk-in Customer" if channel == "pos" else "Online Shopper"),
                    customer_phone=body.get("customer_phone", ""),
                    customer_address=body.get("customer_address") or body.get("delivery_address", ""),
                    delivery_type=body.get("delivery_type", "boda"),
                    delivery_area=body.get("delivery_area", ""),
                    delivery_fee=delivery_fee,
                    delivery_notes=body.get("delivery_notes", ""),
                    subtotal=subtotal,
                    total=grand_total,
                    tender_type=tender_type,
                    tender_amount=tender.get("tendered"),
                    tender_change=tender.get("change"),
                    cashier_id=cashier.get("id"),
                    cashier_name=cashier.get("name"),
                    created_at=now,
                )
                session.add(order)
                session.add_all(order_items_objs)
                session.add(LedgerEntry(
                    id=generate_uid("LED"),
                    kind="sale",
                    amount=grand_total,
                    category="POS Sale" if channel == "pos" else f"{channel.title()} Sale",
                    description=f"Order {order_id} ({len(order_items_objs)} items)",
                    staff_name=cashier.get("name", "System Checkout"),
                    ref_id=order_id,
                    created_at=now,
                ))
                create_journal_entry(
                    session,
                    reference=order_id,
                    source="pos_sale" if channel == "pos" else f"{channel}_sale",
                    description=f"{channel.upper()} sale {order_id}",
                    occurred_at=now,
                    staff=cashier,
                    lines=sale_journal_lines(grand_total, cogs, tender_type),
                )
                session.flush()
                return json_response({
                    "status": "success",
                    "order": order.to_dict(),
                    "products": [product.to_dict() for product in products.values()],
                }, status=201)

        # ----------------------------------------------------
        # 5. Financial Ledgers hub (Protected)
        # ----------------------------------------------------
        if clean_path == "/api/finance/expenses" and method in ("GET", "POST"):
            staff_info, auth_error = authenticated_or_response(headers, body, query_params)
            if auth_error:
                return auth_error
            if method == "GET":
                date_value = query_params.get("date", [""])[0] or None
                try:
                    start, end, selected_date = date_bounds_utc(date_value)
                except ValueError:
                    return json_response({"ok": False, "error": "date must use YYYY-MM-DD"}, status=400)
                with get_db() as session:
                    rows = session.query(ExpenseRecord).filter(
                        ExpenseRecord.occurred_at >= start,
                        ExpenseRecord.occurred_at < end,
                    ).order_by(ExpenseRecord.occurred_at.desc()).all()
                    posted_total = sum(row.amount for row in rows if row.status == "POSTED")
                    return json_response({
                        "ok": True,
                        "date": selected_date,
                        "total": posted_total,
                        "expenses": [row.to_dict() for row in rows],
                    })

            try:
                category = str(body.get("category") or "").strip()
                amount = parse_positive_int(body.get("amount"), "Amount")
                payment_method = str(body.get("payment_method") or "cash").strip().lower()
                occurred_at = parse_operator_datetime(body.get("occurred_at"))
                if not category:
                    raise ValueError("Expense category is required")
                if len(category) > 100:
                    raise ValueError("Expense category is too long")
            except (ValueError, TypeError) as exc:
                return json_response({"ok": False, "error": str(exc)}, status=400)

            with get_db() as session:
                expense_id = generate_uid("EXP")
                pay_code, pay_name = payment_account(payment_method)
                journal = create_journal_entry(
                    session,
                    reference=expense_id,
                    source="expense",
                    description=f"{category} expense" + (f" — {body.get('vendor')}" if body.get("vendor") else ""),
                    occurred_at=occurred_at,
                    staff=staff_info,
                    lines=[
                        {"account_code": "5100", "account_name": f"Operating Expense — {category}", "debit": amount},
                        {"account_code": pay_code, "account_name": pay_name, "credit": amount},
                    ],
                )
                expense = ExpenseRecord(
                    id=expense_id,
                    category=category,
                    amount=amount,
                    payment_method=payment_method,
                    vendor=str(body.get("vendor") or "").strip()[:150],
                    receipt_reference=str(body.get("receipt_reference") or "").strip()[:120],
                    notes=str(body.get("notes") or "").strip(),
                    status="POSTED",
                    occurred_at=occurred_at,
                    journal_entry_id=journal.id,
                    created_by_id=staff_info.get("id"),
                    created_by_name=staff_info.get("name"),
                )
                session.add(expense)
                session.add(LedgerEntry(
                    id=generate_uid("LED"),
                    kind="expense",
                    amount=-amount,
                    category=category,
                    description=f"Expense {expense_id}" + (f" — {expense.vendor}" if expense.vendor else ""),
                    staff_name=staff_info.get("name"),
                    ref_id=expense_id,
                    created_at=occurred_at,
                ))
                session.flush()
                return json_response({"ok": True, "status": "posted", "expense": expense.to_dict()}, status=201)

        if clean_path.startswith("/api/finance/expenses/") and method in ("PUT", "PATCH", "POST"):
            staff_info, auth_error = authenticated_or_response(headers, body, query_params)
            if auth_error:
                return auth_error
            parts = clean_path.split("/")
            is_void = parts[-1] == "void"
            expense_id = parts[-2] if is_void else parts[-1]
            with get_db() as session:
                expense = session.query(ExpenseRecord).filter_by(id=expense_id).with_for_update().first()
                if not expense:
                    return json_response({"ok": False, "error": "Expense not found"}, status=404)
                if expense.status != "POSTED":
                    return json_response({"ok": False, "error": "Only posted expenses may be edited or voided"}, status=409)
                role = str(staff_info.get("role", "")).lower()
                if role not in FINANCE_MANAGER_ROLES and expense.created_by_id != staff_info.get("id"):
                    return json_response({"ok": False, "error": "You can only change expenses you posted"}, status=403)
                today_start, today_end, _ = date_bounds_utc(None)
                if not (today_start <= expense.occurred_at < today_end) and role not in FINANCE_MANAGER_ROLES:
                    return json_response({"ok": False, "error": "A manager must adjust an expense from a prior day"}, status=403)
                original = session.query(AccountingJournalEntry).filter_by(id=expense.journal_entry_id).first()

                if is_void:
                    reason = str(body.get("reason") or "Voided by operator").strip()
                    reverse_journal_entry(
                        session, original, source="expense_void", description=f"Void {expense_id}: {reason}", staff=staff_info
                    )
                    expense.status = "VOID"
                    expense.voided_at = datetime.utcnow()
                    expense.voided_by_id = staff_info.get("id")
                    expense.void_reason = reason
                    session.add(LedgerEntry(
                        id=generate_uid("LED"), kind="adjustment", amount=expense.amount,
                        category=expense.category, description=f"Void expense {expense_id}: {reason}",
                        staff_name=staff_info.get("name"), ref_id=expense_id, created_at=datetime.utcnow(),
                    ))
                    session.flush()
                    return json_response({"ok": True, "status": "voided", "expense": expense.to_dict()})

                try:
                    category = str(body.get("category", expense.category)).strip()
                    amount = parse_positive_int(body.get("amount", expense.amount), "Amount")
                    payment_method = str(body.get("payment_method", expense.payment_method)).strip().lower()
                    occurred_at = parse_operator_datetime(body.get("occurred_at")) if body.get("occurred_at") else expense.occurred_at
                    if not category:
                        raise ValueError("Expense category is required")
                except (ValueError, TypeError) as exc:
                    return json_response({"ok": False, "error": str(exc)}, status=400)

                old_amount = expense.amount
                reverse_journal_entry(
                    session, original, source="expense_edit_reversal",
                    description=f"Reverse expense {expense_id} before edit", staff=staff_info,
                )
                pay_code, pay_name = payment_account(payment_method)
                replacement = create_journal_entry(
                    session,
                    reference=f"{expense_id}-EDIT-{int(time.time())}"[:100],
                    source="expense_edit",
                    description=f"Edited {category} expense",
                    occurred_at=occurred_at,
                    staff=staff_info,
                    lines=[
                        {"account_code": "5100", "account_name": f"Operating Expense — {category}", "debit": amount},
                        {"account_code": pay_code, "account_name": pay_name, "credit": amount},
                    ],
                )
                expense.category = category
                expense.amount = amount
                expense.payment_method = payment_method
                expense.vendor = str(body.get("vendor", expense.vendor or "")).strip()[:150]
                expense.receipt_reference = str(body.get("receipt_reference", expense.receipt_reference or "")).strip()[:120]
                expense.notes = str(body.get("notes", expense.notes or "")).strip()
                expense.occurred_at = occurred_at
                expense.journal_entry_id = replacement.id
                session.add_all([
                    LedgerEntry(
                        id=generate_uid("LED"), kind="adjustment", amount=old_amount,
                        category=expense.category, description=f"Reverse prior version of {expense_id}",
                        staff_name=staff_info.get("name"), ref_id=expense_id, created_at=datetime.utcnow(),
                    ),
                    LedgerEntry(
                        id=generate_uid("LED"), kind="expense", amount=-amount,
                        category=category, description=f"Edited expense {expense_id}",
                        staff_name=staff_info.get("name"), ref_id=expense_id, created_at=occurred_at,
                    ),
                ])
                session.flush()
                return json_response({"ok": True, "status": "updated", "expense": expense.to_dict()})

        if clean_path == "/api/finance/stock-lots" and method in ("GET", "POST"):
            staff_info, auth_error = authenticated_or_response(headers, body, query_params)
            if auth_error:
                return auth_error
            if method == "GET":
                with get_db() as session:
                    rows = session.query(StockLot).order_by(StockLot.acquired_at.desc()).limit(250).all()
                    return json_response({"ok": True, "stock_lots": [row.to_dict() for row in rows]})
            try:
                supplier = str(body.get("supplier") or "").strip()
                description = str(body.get("description") or "").strip()
                acquisition_cost = parse_positive_int(body.get("acquisition_cost"), "Acquisition cost", allow_zero=True)
                shipping_cost = parse_positive_int(body.get("shipping_cost", 0), "Shipping cost", allow_zero=True)
                item_count = parse_positive_int(body.get("item_count"), "Item count")
                if not supplier or not description:
                    raise ValueError("Supplier and lot description are required")
                total_landed = acquisition_cost + shipping_cost
                if total_landed <= 0:
                    raise ValueError("Total landed cost must be greater than zero")
                unit_cost = int(round(total_landed / item_count))
                acquired_at = parse_operator_datetime(body.get("acquired_at"))
            except (ValueError, TypeError) as exc:
                return json_response({"ok": False, "error": str(exc)}, status=400)
            with get_db() as session:
                lot_id = generate_uid("LOT")
                lot_code = str(body.get("lot_code") or f"BALE-{datetime.now(KAMPALA_TZ):%Y%m%d}-{uuid.uuid4().hex[:4].upper()}")[:50]
                if session.query(StockLot).filter_by(lot_code=lot_code).first():
                    return json_response({"ok": False, "error": "Lot code already exists"}, status=409)
                method_value = str(body.get("payment_method") or "cash").lower()
                pay_code, pay_name = payment_account(method_value)
                journal = create_journal_entry(
                    session,
                    reference=lot_code,
                    source="stock_acquisition",
                    description=f"Stock lot {lot_code} from {supplier}",
                    occurred_at=acquired_at,
                    staff=staff_info,
                    lines=[
                        *([{ "account_code": "1200", "account_name": ACCOUNT_NAMES["1200"], "debit": acquisition_cost }] if acquisition_cost else []),
                        *([{ "account_code": "1300", "account_name": ACCOUNT_NAMES["1300"], "debit": shipping_cost }] if shipping_cost else []),
                        {"account_code": pay_code, "account_name": pay_name, "credit": total_landed},
                    ],
                )
                lot = StockLot(
                    id=lot_id, lot_code=lot_code, supplier=supplier[:150], description=description,
                    acquisition_cost=acquisition_cost, shipping_cost=shipping_cost,
                    total_landed_cost=total_landed, item_count=item_count, unit_cost=unit_cost,
                    payment_method=method_value, status="OPEN", allocated_count=0,
                    acquired_at=acquired_at, journal_entry_id=journal.id,
                    created_by_id=staff_info.get("id"), created_by_name=staff_info.get("name"),
                )
                session.add(lot)
                session.flush()
                return json_response({"ok": True, "status": "registered", "stock_lot": lot.to_dict()}, status=201)

        if clean_path == "/api/finance/dashboard" and method == "GET":
            staff_info, auth_error = authenticated_or_response(headers, body, query_params, manager=True)
            if auth_error:
                return auth_error
            try:
                start, end, selected_date = date_bounds_utc(query_params.get("date", [""])[0] or None)
            except ValueError:
                return json_response({"ok": False, "error": "date must use YYYY-MM-DD"}, status=400)
            with get_db() as session:
                orders = session.query(Order).filter(
                    Order.created_at >= start,
                    Order.created_at < end,
                    ~func.lower(Order.status).in_(["cancelled", "void"]),
                ).all()
                gross_sales = sum(int(order.total or 0) for order in orders)
                cogs = 0
                channels = {"POS": 0, "WhatsApp / TikTok": 0, "Web": 0}
                categories = {}
                for order in orders:
                    if order.channel == "pos":
                        channel_name = "POS"
                    elif order.channel in {"whatsapp", "tiktok", "social"}:
                        channel_name = "WhatsApp / TikTok"
                    else:
                        channel_name = "Web"
                    channels[channel_name] += int(order.total or 0)
                    for item in order.items:
                        item_cost = int(item.unit_cost or 0) * int(item.qty or 0)
                        if not item_cost and item.product_id:
                            product = session.query(Product).filter_by(id=item.product_id).first()
                            item_cost = int(product.cost_price or 0) * int(item.qty or 0) if product else 0
                        item_revenue = int(item.line_total or 0)
                        cogs += item_cost
                        name = item.category or "Uncategorised"
                        bucket = categories.setdefault(name, {"category": name, "sales": 0, "cogs": 0, "profit": 0})
                        bucket["sales"] += item_revenue
                        bucket["cogs"] += item_cost
                        bucket["profit"] += item_revenue - item_cost
                gross_profit = gross_sales - cogs
                gross_margin = round((gross_profit / gross_sales * 100), 1) if gross_sales else 0
                # Journal-derived expense totals include new records, imported
                # legacy cash-book expenses, reversals, and inventory losses.
                expense_debit, expense_credit = session.query(
                    func.coalesce(func.sum(AccountingJournalLine.debit), 0),
                    func.coalesce(func.sum(AccountingJournalLine.credit), 0),
                ).join(
                    AccountingJournalEntry,
                    AccountingJournalLine.journal_entry_id == AccountingJournalEntry.id,
                ).filter(
                    AccountingJournalLine.account_code.in_(["5100", "5200"]),
                    AccountingJournalEntry.occurred_at >= start,
                    AccountingJournalEntry.occurred_at < end,
                ).one()
                expenses = int(expense_debit or 0) - int(expense_credit or 0)
                balances = {}
                for code in ("1000", "1010", "1020"):
                    debit, credit = session.query(
                        func.coalesce(func.sum(AccountingJournalLine.debit), 0),
                        func.coalesce(func.sum(AccountingJournalLine.credit), 0),
                    ).filter(AccountingJournalLine.account_code == code).one()
                    balances[code] = int(debit or 0) - int(credit or 0)
                return json_response({
                    "ok": True,
                    "date": selected_date,
                    "metrics": {
                        "gross_sales": gross_sales,
                        "cogs": cogs,
                        "gross_profit": gross_profit,
                        "gross_margin": gross_margin,
                        "expenses": expenses,
                        "net_operating_income": gross_profit - expenses,
                        "cash_balance": balances.get("1000", 0),
                        "mobile_money_balance": balances.get("1010", 0),
                        "bank_balance": balances.get("1020", 0),
                    },
                    "sales_by_channel": [{"channel": key, "amount": value} for key, value in channels.items()],
                    "category_profitability": sorted(categories.values(), key=lambda row: row["profit"], reverse=True),
                    "order_count": len(orders),
                    "updated_at": datetime.utcnow().isoformat() + "Z",
                })

        if clean_path == "/api/finance/aging" and method == "GET":
            staff_info, auth_error = authenticated_or_response(headers, body, query_params, manager=True)
            if auth_error:
                return auth_error
            try:
                days = int(query_params.get("days", ["30"])[0])
                if days not in {30, 60, 90}:
                    raise ValueError()
            except ValueError:
                return json_response({"ok": False, "error": "days must be 30, 60, or 90"}, status=400)
            cutoff = datetime.utcnow() - timedelta(days=days)
            with get_db() as session:
                products = session.query(Product).filter(
                    Product.created_at <= cutoff,
                    Product.in_stock_count > 0,
                    Product.inventory_status.notin_(["ARCHIVED", "WRITTEN_OFF"]),
                ).order_by(Product.created_at.asc()).all()
                result = []
                now = datetime.utcnow()
                for product in products:
                    row = product.to_dict()
                    row["age_days"] = max(0, (now - product.created_at).days)
                    row["stock_value"] = int(product.cost_price or 0) * int(product.in_stock_count or 0)
                    result.append(row)
                value_at_risk = sum(row["stock_value"] for row in result)
                return json_response({
                    "ok": True, "days": days, "count": len(result),
                    "value_at_risk": value_at_risk, "products": result,
                })

        if clean_path.startswith("/api/finance/aging/") and method == "POST":
            staff_info, auth_error = authenticated_or_response(headers, body, query_params, manager=True)
            if auth_error:
                return auth_error
            parts = clean_path.split("/")
            if len(parts) < 6 or parts[-1] not in {"markdown", "write-off"}:
                return json_response({"ok": False, "error": "Unknown inventory action"}, status=404)
            product_id, action = parts[-2], parts[-1]
            with get_db() as session:
                product = session.query(Product).filter_by(id=product_id).with_for_update().first()
                if not product:
                    return json_response({"ok": False, "error": "Product not found"}, status=404)
                if product.in_stock_count <= 0:
                    return json_response({"ok": False, "error": "This product has no stock to adjust"}, status=409)
                if action == "markdown":
                    try:
                        new_price = parse_positive_int(body.get("new_price"), "New price")
                    except ValueError as exc:
                        return json_response({"ok": False, "error": str(exc)}, status=400)
                    old_price = int(product.selling_price or 0)
                    if new_price >= old_price:
                        return json_response({"ok": False, "error": "Markdown price must be lower than the current price"}, status=400)
                    if not product.compare_price or product.compare_price < old_price:
                        product.compare_price = old_price
                    product.selling_price = new_price
                    adjustment = InventoryAdjustment(
                        id=generate_uid("ADJ"), product_id=product.id, adjustment_type="MARKDOWN",
                        quantity=product.in_stock_count, old_price=old_price, new_price=new_price,
                        loss_amount=0, reason=str(body.get("reason") or "Dead-stock markdown"),
                        created_by_id=staff_info.get("id"), created_by_name=staff_info.get("name"),
                    )
                    session.add(adjustment)
                    session.flush()
                    return json_response({"ok": True, "status": "markdown_posted", "product": product.to_dict(), "adjustment": adjustment.to_dict()})

                reason = str(body.get("reason") or "Damaged / unsellable inventory").strip()
                quantity = int(product.in_stock_count or 0)
                loss = int(product.cost_price or 0) * quantity
                journal = None
                if loss:
                    journal = create_journal_entry(
                        session,
                        reference=generate_uid("WO"), source="inventory_write_off",
                        description=f"Write off {quantity} × {product.name}: {reason}",
                        occurred_at=datetime.utcnow(), staff=staff_info,
                        lines=[
                            {"account_code": "5200", "account_name": ACCOUNT_NAMES["5200"], "debit": loss},
                            {"account_code": "1200", "account_name": ACCOUNT_NAMES["1200"], "credit": loss},
                        ],
                    )
                product.in_stock_count = 0
                product.inventory_status = "WRITTEN_OFF"
                session.query(InventoryLock).filter_by(product_id=product.id).delete(synchronize_session=False)
                adjustment = InventoryAdjustment(
                    id=generate_uid("ADJ"), product_id=product.id, adjustment_type="WRITE_OFF",
                    quantity=quantity, old_price=product.selling_price, new_price=0,
                    loss_amount=loss, reason=reason, journal_entry_id=journal.id if journal else None,
                    created_by_id=staff_info.get("id"), created_by_name=staff_info.get("name"),
                )
                session.add(adjustment)
                session.add(LedgerEntry(
                    id=generate_uid("LED"), kind="expense", amount=-loss,
                    category="Inventory Write-Off", description=f"Write off {product.name}: {reason}",
                    staff_name=staff_info.get("name"), ref_id=adjustment.id,
                ))
                session.flush()
                return json_response({"ok": True, "status": "written_off", "product": product.to_dict(), "adjustment": adjustment.to_dict()})

        if clean_path == "/api/finance/journal" and method == "GET":
            staff_info, auth_error = authenticated_or_response(headers, body, query_params, manager=True)
            if auth_error:
                return auth_error
            account = query_params.get("account", [""])[0].strip()
            source = query_params.get("source", [""])[0].strip()
            search = query_params.get("search", [""])[0].strip()
            from_date = query_params.get("from", [""])[0].strip()
            to_date = query_params.get("to", [""])[0].strip()
            try:
                limit = min(1000, max(1, int(query_params.get("limit", ["500"])[0])))
            except ValueError:
                limit = 500
            with get_db() as session:
                q = session.query(AccountingJournalLine, AccountingJournalEntry).join(
                    AccountingJournalEntry, AccountingJournalLine.journal_entry_id == AccountingJournalEntry.id
                )
                if account:
                    q = q.filter(or_(AccountingJournalLine.account_code == account, AccountingJournalLine.account_name == account))
                if source:
                    q = q.filter(AccountingJournalEntry.source == source)
                if search:
                    pattern = f"%{search}%"
                    q = q.filter(or_(
                        AccountingJournalEntry.reference.ilike(pattern),
                        AccountingJournalEntry.description.ilike(pattern),
                        AccountingJournalLine.account_name.ilike(pattern),
                        AccountingJournalLine.memo.ilike(pattern),
                    ))
                try:
                    if from_date:
                        from_start, _, _ = date_bounds_utc(from_date)
                        q = q.filter(AccountingJournalEntry.occurred_at >= from_start)
                    if to_date:
                        _, to_end, _ = date_bounds_utc(to_date)
                        q = q.filter(AccountingJournalEntry.occurred_at < to_end)
                except ValueError:
                    return json_response({"ok": False, "error": "Journal dates must use YYYY-MM-DD"}, status=400)

                rows = q.order_by(
                    AccountingJournalEntry.occurred_at.asc(), AccountingJournalLine.id.asc()
                ).all()
                running = {}
                serialized = []
                debit_total = 0
                credit_total = 0
                for line, entry in rows:
                    running[line.account_code] = running.get(line.account_code, 0) + int(line.debit or 0) - int(line.credit or 0)
                    debit_total += int(line.debit or 0)
                    credit_total += int(line.credit or 0)
                    serialized.append({
                        "id": line.id,
                        "journal_entry_id": entry.id,
                        "occurred_at": entry.occurred_at.isoformat() + "Z",
                        "reference": entry.reference,
                        "source": entry.source,
                        "description": entry.description or "",
                        "status": entry.status,
                        "account_code": line.account_code,
                        "account_name": line.account_name,
                        "debit": line.debit,
                        "credit": line.credit,
                        "running_balance": running[line.account_code],
                        "memo": line.memo or "",
                        "created_by_name": entry.created_by_name or "",
                    })
                account_rows = session.query(
                    AccountingJournalLine.account_code, AccountingJournalLine.account_name
                ).order_by(AccountingJournalLine.account_code.asc()).all()
                accounts_by_code = {}
                for code, name in account_rows:
                    accounts_by_code.setdefault(code, ACCOUNT_NAMES.get(code, name))
                sources = session.query(AccountingJournalEntry.source).distinct().order_by(AccountingJournalEntry.source.asc()).all()
                return json_response({
                    "ok": True,
                    "count": len(serialized),
                    "lines": list(reversed(serialized[-limit:])),
                    "totals": {"debit": debit_total, "credit": credit_total, "difference": debit_total - credit_total},
                    "accounts": [{"code": code, "name": name} for code, name in accounts_by_code.items()],
                    "sources": [row[0] for row in sources],
                })

        # ----------------------------------------------------
        # 5. Full-State Sync (Protected: POS & Admin Data Sync)
        # ----------------------------------------------------
        if clean_path == "/api/sync/pull" and method in ("GET", "POST"):
            # Require staff terminal authorization for operational data pull
            is_authed, staff_info = is_authenticated_staff(headers, body, query_params)
            if not is_authed:
                return json_response({
                    "ok": False,
                    "error": "Unauthorized: Staff terminal authentication required for database sync"
                }, status=401)

            with get_db() as session:
                products = [p.to_dict() for p in session.query(Product).order_by(Product.created_at.desc()).all()]
                categories = [c.to_dict() for c in session.query(Category).order_by(Category.sort_order.asc()).all()]
                orders = [o.to_dict() for o in session.query(Order).order_by(Order.created_at.desc()).all()]
                inventory = [i.to_dict() for i in session.query(Inventory).all()]
                riders = [r.to_dict() for r in session.query(Rider).all()]
                ledger = [l.to_dict() for l in session.query(LedgerEntry).order_by(LedgerEntry.created_at.desc()).all()]
                settings_rows = session.query(StoreSetting).all()
                settings = public_store_settings(settings_rows)

                return json_response({
                    "synced_at": datetime.utcnow().isoformat(),
                    "products": products,
                    "categories": categories,
                    "sales": orders,
                    "inventory": inventory,
                    "riders": riders,
                    "ledger": ledger,
                    "settings": settings
                })

        # ----------------------------------------------------
        # 6. Store Settings (Public Read sanitized / Protected Update)
        # ----------------------------------------------------
        if clean_path == "/api/settings" and method == "GET":
            with get_db() as session:
                rows = session.query(StoreSetting).all()
                return json_response({
                    "settings": public_store_settings(rows),
                    "synced_at": datetime.utcnow().isoformat()
                })

        if clean_path == "/api/settings" and method in ("POST", "PUT", "PATCH"):
            is_authed, staff_info = is_authenticated_staff(headers, body, query_params)
            if not is_authed or (staff_info or {}).get("role") != "admin":
                return json_response({
                    "ok": False,
                    "error": "Unauthorized: Admin authorization required to update store settings"
                }, status=403)

            # New clients wrap updates in {"settings": {...}} so credentials can
            # never be mistaken for values. Accept the old flat form only for
            # known keys to preserve compatibility with an already-installed POS.
            supplied = body.get("settings") if isinstance(body.get("settings"), dict) else body
            unknown = sorted(set(supplied.keys()) - EDITABLE_STORE_SETTING_KEYS)
            if unknown:
                return json_response({
                    "ok": False,
                    "error": "Unsupported store setting(s): " + ", ".join(unknown)
                }, status=400)

            updates = {}
            for key, value in supplied.items():
                if value is None:
                    value = ""
                if isinstance(value, (dict, list)):
                    return json_response({
                        "ok": False,
                        "error": f"Store setting '{key}' must be a scalar value"
                    }, status=400)
                text_value = str(value).strip()
                if key in ("master_key", "admin_key") and len(text_value) < 6:
                    return json_response({
                        "ok": False,
                        "error": "Master key must be at least 6 characters"
                    }, status=400)
                if len(text_value) > 2000:
                    return json_response({
                        "ok": False,
                        "error": f"Store setting '{key}' is too long"
                    }, status=400)
                updates[key] = text_value

            if not updates:
                return json_response({"ok": False, "error": "No store settings supplied"}, status=400)

            with get_db() as session:
                for key, value in updates.items():
                    setting = session.query(StoreSetting).filter_by(key=key).first()
                    if setting:
                        setting.value = value
                    else:
                        session.add(StoreSetting(key=key, value=value))
                session.flush()
                public_rows = session.query(StoreSetting).all()
                return json_response({
                    "ok": True,
                    "status": "updated",
                    "updated_keys": sorted(updates.keys()),
                    "settings": public_store_settings(public_rows),
                    "synced_at": datetime.utcnow().isoformat()
                })

        # ----------------------------------------------------
        # 7. Staff Authentication & JWT Token Verification
        # ----------------------------------------------------
        if clean_path in ("/api/auth/status", "/api/auth/verify") and method == "GET":
            has_admin_env = any(bool(os.environ.get(v, "").strip()) for v in ADMIN_ENV_VARS)
            has_staff_env = any(bool(os.environ.get(v, "").strip()) for v in STAFF_ENV_VARS)
            return json_response({
                "status": "active",
                "has_env_admin_key": has_admin_env,
                "has_env_staff_key": has_staff_env,
                "supported_keys": ["ADMIN_ACCESS_PIN", "STAFF_TERMINAL_KEY", "TERMINAL_KEY", "ADMIN_KEY", "STAFF_KEY", "MASTER_KEY"]
            })

        if clean_path == "/api/auth/verify" and method == "POST":
            candidate = str(
                body.get("pin")
                or body.get("key")
                or body.get("terminal_key")
                or body.get("staff_key")
                or body.get("admin_key")
                or body.get("password")
                or ""
            ).strip()

            if not candidate:
                return json_response({"ok": False, "error": "Staff Terminal Key or PIN required"}, status=400)

            # 1. Check Admin Environment Variables
            for var_name in ADMIN_ENV_VARS:
                env_val = str(os.environ.get(var_name) or "").strip()
                if env_val and (candidate == env_val or candidate.lower() == env_val.lower()):
                    logger.info("[AUTH] Admin signed in via environment variable %s", var_name)
                    staff_data = {
                        "id": "ENV-ADMIN",
                        "name": "Store Owner / Admin",
                        "role": "admin"
                    }
                    token = create_jwt_token(staff_data)
                    return json_response({
                        "ok": True,
                        "via": f"env_admin:{var_name}",
                        "token": token,
                        "staff": staff_data
                    })

            # 2. Check Staff / Terminal Environment Variables
            for var_name in STAFF_ENV_VARS:
                env_val = str(os.environ.get(var_name) or "").strip()
                if env_val and (candidate == env_val or candidate.lower() == env_val.lower()):
                    logger.info("[AUTH] Staff signed in via environment variable %s", var_name)
                    staff_data = {
                        "id": "ENV-STAFF",
                        "name": "POS Staff Terminal",
                        "role": "cashier"
                    }
                    token = create_jwt_token(staff_data)
                    return json_response({
                        "ok": True,
                        "via": f"env_staff:{var_name}",
                        "token": token,
                        "staff": staff_data
                    })

            # 3. Check Default Sandbox Master Key
            if candidate == "ADONAI-MASTER-2026" or candidate.lower() == "adonai-master-2026":
                logger.info("[AUTH] Signed in via default master key")
                staff_data = {
                    "id": "ENV-ADMIN",
                    "name": "Store Owner / Admin",
                    "role": "admin"
                }
                token = create_jwt_token(staff_data)
                return json_response({
                    "ok": True,
                    "via": "master_key",
                    "token": token,
                    "staff": staff_data
                })

            # 4. Check Database Users & Settings
            pin_hash = hashlib.sha256(candidate.encode("utf-8")).hexdigest()
            with get_db() as session:
                user = (
                    session.query(User)
                    .filter(User.active.is_(True))
                    .filter(or_(User.pin_hash == pin_hash, User.pin_hash == candidate))
                    .first()
                )
                if user:
                    logger.info("[AUTH] %s (%s) signed in via database PIN", user.name, user.role)
                    staff_data = {"id": user.id, "name": user.name, "role": user.role}
                    token = create_jwt_token(staff_data)
                    return json_response({
                        "ok": True,
                        "via": "db",
                        "token": token,
                        "staff": staff_data
                    })

                # Check store settings keys
                settings_keys = ["master_key", "admin_key", "terminal_key", "staff_key"]
                setting_rows = session.query(StoreSetting).filter(StoreSetting.key.in_(settings_keys)).all()
                for s in setting_rows:
                    if s.value and (candidate == s.value.strip() or candidate.lower() == s.value.strip().lower()):
                        role = "admin" if ("admin" in s.key or "master" in s.key) else "cashier"
                        name = "Store Admin (Master Key)" if role == "admin" else "POS Staff Terminal"
                        logger.info("[AUTH] Authenticated via database setting '%s' as %s", s.key, role)
                        staff_data = {"id": f"SET-{role.upper()}", "name": name, "role": role}
                        token = create_jwt_token(staff_data)
                        return json_response({
                            "ok": True,
                            "via": "settings",
                            "token": token,
                            "staff": staff_data
                        })

            return json_response({"ok": False, "error": "Invalid Staff Terminal Key or PIN"}, status=401)

        return json_response({"error": "API route not found"}, status=404)

    except Exception as err:
        logger.error("[API Error] %s on %s %s", err, method, path, exc_info=True)
        return json_response({"error": "Internal Server Error", "details": str(err)}, status=500)
