"""
Adonai Store — REST API & Service Layer
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
import urllib.parse
import uuid

from database import DATABASE_URL, IS_POSTGRES, engine, get_db
import payments
from notifications import (
    LOW_STOCK_THRESHOLD,
    broadcast_event,
    issue_stream_ticket,
    recent_events,
)
from pricing import transport_allocation, whole_money
from security import (
    RateLimiter,
    clean_multiline_text,
    clean_text,
    constant_time_equals,
    get_client_ip,
    hash_pin as pbkdf2_hash_pin,
    load_or_create_jwt_secret,
    needs_rehash,
    rate_limiting_disabled,
    safe_identifier,
    safe_image_url,
    verify_pin,
)
from models import (
    AccountingJournalEntry,
    AccountingJournalLine,
    Category,
    ExpenseRecord,
    Inventory,
    InventoryAdjustment,
    InventoryLock,
    ItemCondition,
    LedgerEntry,
    Order,
    OrderItem,
    PaymentTransaction,
    Product,
    QuantityType,
    Rider,
    StockLot,
    StoreSetting,
    User,
    build_product_slug,
    normalize_measurements,
    slugify,
)

logger = logging.getLogger("adonai.api")

# Configuration for JWT & Terminal Key Signatures.
# SECURITY: never derive the signing secret from low-entropy admin PINs and
# never fall back to a hardcoded string. Set JWT_SECRET in the environment for
# production; otherwise a random secret is generated and persisted locally.
JWT_SECRET = load_or_create_jwt_secret(os.path.dirname(os.path.abspath(__file__)))

# Session token lifetime (default 7 days, configurable).
JWT_TTL_SECONDS = int(os.environ.get("JWT_TTL_SECONDS", str(86400 * 7)))

# Known pre-hardening default key. It must NEVER authenticate again: old
# databases may still carry it in settings, so it is explicitly blocklisted.
RETIRED_DEFAULT_KEYS = {"adonai-master-2026"}

# Rate limiting — shields credential verification from brute force and the
# API surface from request floods. Tunable via environment.
_rate_limiter = RateLimiter()
AUTH_RATE_LIMIT = int(os.environ.get("AUTH_RATE_LIMIT", "10"))          # attempts
AUTH_RATE_WINDOW = int(os.environ.get("AUTH_RATE_WINDOW", "300"))       # seconds
API_RATE_LIMIT = int(os.environ.get("API_RATE_LIMIT", "300"))           # requests
API_RATE_WINDOW = int(os.environ.get("API_RATE_WINDOW", "60"))          # seconds

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

ITEM_CONDITION_VALUES = {ItemCondition.BRAND_NEW.value, ItemCondition.PRE_LOVED.value}


def normalize_item_condition(value, default=ItemCondition.BRAND_NEW.value):
    """Normalize UI labels to the two canonical inventory policy values."""
    raw = str(value or "").strip().upper().replace("-", "_").replace(" ", "_")
    aliases = {
        "NEW": ItemCondition.BRAND_NEW.value,
        "BRANDNEW": ItemCondition.BRAND_NEW.value,
        "FACTORY": ItemCondition.BRAND_NEW.value,
        "VINTAGE": ItemCondition.PRE_LOVED.value,
        "PRELOVED": ItemCondition.PRE_LOVED.value,
        "THRIFT": ItemCondition.PRE_LOVED.value,
    }
    normalized = aliases.get(raw, raw)
    if normalized not in ITEM_CONDITION_VALUES:
        if value in (None, ""):
            return default
        raise ValueError("item_condition must be BRAND_NEW or PRE_LOVED")
    return normalized


def normalize_quantity_type(value, item_condition):
    """Quantity policy always follows item condition; clients cannot mix them."""
    normalized = normalize_item_condition(value, item_condition)
    if normalized != item_condition:
        raise ValueError("quantity_type must match item_condition")
    return normalized


def stock_status_for(product, quantity=None):
    """Keep channel status consistent with the authoritative remaining count."""
    remaining = int(product.in_stock_count if quantity is None else quantity)
    if remaining > 0:
        return "AVAILABLE"
    return "OUT_OF_STOCK"


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


def create_jwt_token(payload: dict, expires_in_sec: int = None) -> str:
    """Generates standard HMAC-SHA256 JWT token for staff terminal sessions."""
    header = {"alg": "HS256", "typ": "JWT"}
    body = dict(payload)
    now = int(time.time())
    body["iat"] = now
    body["exp"] = now + (expires_in_sec if expires_in_sec else JWT_TTL_SECONDS)
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


def find_user_by_pin(session, candidate: str):
    """Locate an active staff member whose stored PIN hash matches candidate.

    Uses salted PBKDF2 verification (with transparent support for legacy
    unsalted SHA-256 digests from pre-hardening deployments). Never matches
    the stored hash value itself — pass-the-hash is explicitly impossible.
    """
    users = (
        session.query(User)
        .filter(User.active.is_(True))
        .filter(User.pin_hash.isnot(None))
        .all()
    )
    for user in users:
        if verify_pin(candidate, user.pin_hash):
            return user
    return None


def upgrade_legacy_pin_hash(session, user, candidate: str) -> None:
    """Transparently re-hash a legacy SHA-256 PIN to salted PBKDF2 on login."""
    try:
        if needs_rehash(user.pin_hash):
            user.pin_hash = pbkdf2_hash_pin(candidate)
            session.flush()
            logger.info("[AUTH] Upgraded legacy PIN hash to PBKDF2 for %s", user.id)
    except Exception:
        logger.warning("[AUTH] Could not upgrade legacy PIN hash for %s", user.id)


def match_env_credential(candidate: str, var_names: list[str]) -> str | None:
    """Constant-time, exact-match comparison of a candidate against the
    configured environment credentials. Returns the matching variable name."""
    if candidate.lower() in RETIRED_DEFAULT_KEYS:
        return None
    for var in var_names:
        val = str(os.environ.get(var) or "").strip()
        if val and constant_time_equals(candidate, val):
            return var
    return None


def is_authenticated_staff(headers: dict = None, body: dict = None, query_params: dict = None) -> tuple[bool, dict | None]:
    """
    Validates if incoming request comes from an authenticated POS terminal or Admin.
    Credentials are accepted ONLY from the Authorization/X-Terminal-Key headers
    or a JSON body — never from URL query strings, which leak into proxy and
    access logs, browser history, and Referer headers.
    """
    headers = headers or {}
    body = body or {}

    auth_header = str(headers.get("authorization", "") or "").strip()
    terminal_header = str(headers.get("x-terminal-key", "") or headers.get("x-staff-token", "") or "").strip()

    candidate = ""
    if auth_header.lower().startswith("bearer "):
        candidate = auth_header[7:].strip()
    elif terminal_header:
        candidate = terminal_header
    elif body.get("token") or body.get("terminal_key") or body.get("key") or body.get("pin"):
        candidate = str(body.get("token") or body.get("terminal_key") or body.get("key") or body.get("pin")).strip()

    if not candidate or len(candidate) > 1024:
        return False, None

    # 1. Check JWT token
    jwt_payload = verify_jwt_token(candidate)
    if jwt_payload:
        return True, {
            "id": jwt_payload.get("sub", "STF-TOKEN"),
            "name": jwt_payload.get("name", "Staff Member"),
            "role": jwt_payload.get("role", "cashier")
        }

    # 2. Check Admin Environment Variables (constant-time, exact match)
    if match_env_credential(candidate, ADMIN_ENV_VARS):
        return True, {"id": "ENV-ADMIN", "name": "Store Owner / Admin", "role": "admin"}

    # 3. Check Staff Environment Variables (constant-time, exact match)
    if match_env_credential(candidate, STAFF_ENV_VARS):
        return True, {"id": "ENV-STAFF", "name": "POS Staff Terminal", "role": "cashier"}

    # 4. Check Database Users via salted PBKDF2 verification
    try:
        with get_db() as session:
            user = find_user_by_pin(session, candidate)
            if user:
                upgrade_legacy_pin_hash(session, user, candidate)
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
    "4100": "Transport Fee Revenue",
    "5000": "Cost of Goods Sold",
    "5100": "Operating Expense",
    "5200": "Inventory Write-Off Loss",
}


def payment_account(method: str) -> tuple[str, str]:
    value = str(method or "cash").strip().lower().replace("-", "_").replace(" ", "_")
    if value in {"mtn", "airtel", "mobile", "mobile_money", "momo"}:
        return "1010", ACCOUNT_NAMES["1010"]
    if value in {"bank", "bank_transfer", "card", "flutterwave", "flw", "online"}:
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


def lookup_product(session, identifier: str):
    """Resolve a catalog piece by permalink slug, id, SKU or barcode."""
    needle = str(identifier or "").strip()
    if not needle:
        return None
    return (
        session.query(Product)
        .filter(
            or_(
                Product.slug == needle,
                Product.id == needle,
                func.upper(Product.sku) == needle.upper(),
                func.upper(Product.barcode_id) == needle.upper(),
            )
        )
        .first()
    )


def unique_product_slug(session, name: str, sku: str, product_id: str, requested: str = "") -> str:
    """Resolve a collision-free /product/<slug> permalink for a catalog piece."""
    candidate = slugify(requested)[:180] if requested else ""
    if not candidate:
        candidate = build_product_slug(name, sku, product_id)[:180]
    base = candidate or "thrift-piece"
    suffix = 2
    while session.query(Product.id).filter(
        Product.slug == candidate, Product.id != product_id
    ).first() is not None:
        candidate = f"{base}-{suffix}"[:200]
        suffix += 1
    return candidate


def apply_pdp_fields(prod, body: dict) -> None:
    """Copy Product Detail Page attributes from an intake/update payload.

    Flat-lay measurements, fabric composition, flaw disclosure and care
    instructions are what make a one-of-one thrift listing trustworthy, so
    they travel through the same validated path as the rest of the catalog.
    """
    if "fabric" in body:
        prod.fabric = clean_text(body.get("fabric"), 255)
    if "measurements" in body:
        prod.measurements = normalize_measurements(body.get("measurements"))
    if "flaw_notes" in body:
        prod.flaw_notes = clean_multiline_text(body.get("flaw_notes"), 1200)
    if "care_notes" in body:
        prod.care_notes = clean_multiline_text(body.get("care_notes"), 1200)
    if "staff_notes" in body:
        prod.staff_notes = clean_multiline_text(body.get("staff_notes"), 1200)
    if "flaw_photo_index" in body:
        try:
            index = int(body.get("flaw_photo_index"))
        except (TypeError, ValueError):
            index = -1
        prod.flaw_photo_index = index if 0 <= index <= 11 else -1


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


def sale_journal_lines(total: int, cogs: int, tender_type: str, transport_total: int = 0):
    payment_code, payment_name = payment_account(tender_type)
    transport_total = max(0, int(transport_total or 0))
    sales_revenue = max(0, int(total) - transport_total)
    lines = [
        {"account_code": payment_code, "account_name": payment_name, "debit": total},
        *([{"account_code": "4000", "account_name": ACCOUNT_NAMES["4000"], "credit": sales_revenue}] if sales_revenue else []),
        *([{"account_code": "4100", "account_name": ACCOUNT_NAMES["4100"], "credit": transport_total}] if transport_total else []),
    ]
    if cogs:
        lines.extend([
            {"account_code": "5000", "account_name": ACCOUNT_NAMES["5000"], "debit": cogs},
            {"account_code": "1200", "account_name": ACCOUNT_NAMES["1200"], "credit": cogs},
        ])
    return lines


# ============================================================================
# Online payments (Flutterwave) — lifecycle helpers
# ============================================================================
def expire_stale_flutterwave_orders(session, now=None):
    """
    Release stock on web orders whose payment window lapsed without a verified
    charge. Mirrors the staff 'Cancelled' transition (restock + status) so a
    one-of-one thrift piece goes back on the rail automatically.
    """
    now = now or datetime.utcnow()
    stale = (
        session.query(Order)
        .filter(
            Order.payment_status == "pending",
            Order.payment_provider == payments.PROVIDER,
            Order.payment_expires_at.isnot(None),
            Order.payment_expires_at <= now,
            ~Order.status.in_(["cancelled", "completed"]),
        )
        .with_for_update()
        .all()
    )
    for order in stale:
        for item in order.items:
            product = session.query(Product).filter_by(id=item.product_id).with_for_update().first()
            if product:
                product.in_stock_count = int(product.in_stock_count or 0) + int(item.qty or 0)
                if product.inventory_status == "OUT_OF_STOCK" and product.in_stock_count > 0:
                    product.inventory_status = "AVAILABLE"
        order.payment_status = "failed"
        order.status = "cancelled"
        order.dispatch_status = "Cancelled"
        order.updated_at = now
        session.query(PaymentTransaction).filter(
            PaymentTransaction.order_id == order.id,
            PaymentTransaction.status == "pending",
        ).update({"status": "failed", "updated_at": now}, synchronize_session=False)
        broadcast_event(
            "ORDER_EXPIRED",
            f"⌛ Unpaid order {order.id} released",
            "Online payment was not completed in time — the piece(s) are back on the rail.",
            {"order_id": order.id, "amount": order.total},
        )
    if stale:
        session.flush()
    return len(stale)


def load_order_for_payment(session, order_id, payment_token):
    """
    Resolve an order for a browser payment action. The per-order payment token
    (issued once, in the checkout response) authorizes initiate/verify/status
    calls so strangers cannot poke at arbitrary order ids.
    """
    safe_id = safe_identifier(order_id)
    if not safe_id or not payment_token:
        return None, "order_id and payment_token are required"
    order = session.query(Order).filter_by(id=safe_id).with_for_update().first()
    if not order:
        return None, "Order not found"
    if not payments.payment_token_matches(order.payment_token_hash or "", payment_token):
        return None, "Payment token is invalid for this order"
    return order, None


def settle_order_payment(session, order, verified, attempt=None, source="browser_verify"):
    """
    Mark an order paid after a Flutterwave transaction was re-verified with the
    secret key. Idempotent: the browser verify call and the webhook can arrive
    in any order (and repeatedly) without double-settling.
    Returns (ok, payment_status, error_message).
    """
    now = datetime.utcnow()
    if order.payment_status == "paid":
        return True, "paid", ""

    tx_ref = str(verified.get("tx_ref") or "").strip()
    if attempt is None and tx_ref:
        attempt = (
            session.query(PaymentTransaction)
            .filter(
                PaymentTransaction.order_id == order.id,
                PaymentTransaction.tx_ref == tx_ref,
            )
            .with_for_update()
            .first()
        )
    if attempt is None:
        logger.warning("Payment settle refused for %s: unknown tx_ref %r (%s)", order.id, tx_ref, source)
        return False, order.payment_status or "pending", "Payment reference is not recognized for this order"

    if not verified.get("ok"):
        if verified.get("status") and str(verified.get("status")).lower() in {"failed", "cancelled"}:
            attempt.status = "failed"
            attempt.updated_at = now
        return False, order.payment_status or "pending", "Flutterwave has not confirmed this payment"

    # Trust only gateway-verified figures, and only against the ORDER's total —
    # never against anything the browser posted.
    verified_currency = str(verified.get("currency") or "").upper()
    expected_currency = (payments.FLW_CURRENCY or "UGX").upper()
    if verified_currency and verified_currency != expected_currency:
        logger.warning("Payment settle refused for %s: currency %s != %s", order.id, verified_currency, expected_currency)
        return False, order.payment_status or "pending", "Paid currency does not match this order"

    verified_amount = verified.get("amount")
    if verified_amount is not None:
        try:
            if int(round(float(verified_amount))) < int(order.total or 0):
                logger.warning("Payment settle refused for %s: amount %s < %s", order.id, verified_amount, order.total)
                return False, order.payment_status or "pending", "Paid amount is less than the order total"
        except (TypeError, ValueError):
            return False, order.payment_status or "pending", "Verified amount was not readable"

    flw_id = verified.get("flw_id")
    attempt.status = "successful"
    attempt.flw_transaction_id = str(flw_id)[:40] if flw_id is not None else attempt.flw_transaction_id
    attempt.channel = str(verified.get("payment_type") or "")[:40] or None
    attempt.gateway_payload = payments.transaction_summary(verified)
    attempt.updated_at = now

    order.payment_status = "paid"
    order.tender_type = payments.PROVIDER
    order.payment_provider = payments.PROVIDER
    order.payment_reference = attempt.tx_ref
    order.paid_at = now
    order.updated_at = now
    session.flush()

    order_number = order.id.split("-")[-1] if "-" in order.id else order.id
    broadcast_event(
        "ORDER_PAID",
        f"💳 Paid online — Order #{order_number}",
        f"{order.customer_name or 'Online shopper'} paid UGX {int(order.total or 0):,} via Flutterwave ({attempt.channel or 'online'}).",
        {"order_id": order.id, "amount": order.total, "reference": attempt.tx_ref, "channel": attempt.channel or ""},
    )
    return True, "paid", ""


def handle_api_request(method: str, path: str, query_params: dict, body_bytes: bytes, headers: dict = None, client_addr: str = None) -> tuple[int, str, bytes]:
    """
    Unified router for backend /api/* endpoints.
    Distinguishes public e-commerce storefront traffic from protected POS terminal traffic.
    Returns (status_code, content_type, response_body_bytes).
    """
    try:
        headers = headers or {}
        client_ip = get_client_ip(headers, client_addr or "")

        # ------------------------------------------------------------------
        # Rate limiting: a strict window on credential verification (brute
        # force guard) plus a general per-client API request ceiling.
        # ------------------------------------------------------------------
        if not rate_limiting_disabled():
            allowed, retry_after = _rate_limiter.check(
                "api", client_ip, API_RATE_LIMIT, API_RATE_WINDOW
            )
            if not allowed:
                return json_response({
                    "ok": False,
                    "error": "Too many requests. Please slow down.",
                    "retry_after_seconds": retry_after,
                }, status=429)
            if path.rstrip("/") == "/api/auth/verify" and method == "POST":
                allowed, retry_after = _rate_limiter.check(
                    "auth", client_ip, AUTH_RATE_LIMIT, AUTH_RATE_WINDOW
                )
                if not allowed:
                    logger.warning("[AUTH] Rate limit hit for %s", client_ip)
                    return json_response({
                        "ok": False,
                        "error": "Too many sign-in attempts. Try again later.",
                        "retry_after_seconds": retry_after,
                    }, status=429)

        body = {}
        if body_bytes and method in ("POST", "PUT", "PATCH"):
            try:
                body = json.loads(body_bytes.decode("utf-8"))
            except Exception:
                body = {}
        if not isinstance(body, dict):
            body = {}

        # Strip trailing slashes from path
        clean_path = path.rstrip("/")

        # ----------------------------------------------------
        # 1. Health & Status (Public)
        # ----------------------------------------------------
        if clean_path == "/api/health" and method == "GET":
            # SECURITY: keep this endpoint minimal. Schema/table names and
            # connection-pool internals are infrastructure details that must
            # not be broadcast publicly.
            inspector = inspect(engine)
            tables = inspector.get_table_names()
            return json_response({
                "status": "healthy",
                "database": "connected",
                "is_postgres": IS_POSTGRES,
                "tables_count": len(tables),
                "timestamp": datetime.utcnow().isoformat()
            })

        # ----------------------------------------------------
        # 1b. Real-Time Notification Engine (Protected)
        # ----------------------------------------------------
        if clean_path == "/api/notifications/ticket" and method == "POST":
            # EventSource cannot attach Authorization headers, and this API
            # never accepts credentials in query strings. Staff exchange
            # their verified JWT here for a single-use 60s stream ticket,
            # which is all the SSE URL ever carries.
            staff_info, auth_error = authenticated_or_response(headers, body, query_params)
            if auth_error:
                return auth_error
            ticket = issue_stream_ticket(staff_info)
            return json_response({"ok": True, "ticket": ticket, "expires_in": 60})

        if clean_path == "/api/notifications" and method == "GET":
            # Chronological alert history for the notification drawer.
            staff_info, auth_error = authenticated_or_response(headers, body, query_params)
            if auth_error:
                return auth_error
            limit = 100
            try:
                limit = int(query_params.get("limit", ["100"])[0])
            except (TypeError, ValueError):
                pass
            return json_response({"ok": True, "notifications": recent_events(limit)})

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

                # Inventory-stream filter (Brand New vs Vintage / Pre-Loved)
                item_condition = query_params.get("item_condition", query_params.get("inventory_type", [""]))[0]
                if item_condition and item_condition != "All":
                    try:
                        q = q.filter(Product.item_condition == normalize_item_condition(item_condition))
                    except ValueError:
                        return json_response({"ok": False, "error": "Unknown item_condition filter"}, status=400)

                # Human-readable condition grade filter
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
                    reservation_owner = str(query_params.get("reservation_owner", [""])[0] or "").strip()[:100]
                    lock_query = session.query(InventoryLock.product_id, func.sum(InventoryLock.quantity)).filter(
                        InventoryLock.expires_at > datetime.utcnow()
                    )
                    if reservation_owner.startswith("WEB-"):
                        lock_query = lock_query.filter(InventoryLock.lock_owner != reservation_owner)
                    rows = lock_query.group_by(InventoryLock.product_id).all()
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
                item_condition = normalize_item_condition(body.get("item_condition", body.get("inventory_type")))
                quantity_type = normalize_quantity_type(body.get("quantity_type"), item_condition)
                if item_condition == ItemCondition.PRE_LOVED.value and stock_count not in (0, 1):
                    raise ValueError("PRE_LOVED inventory must have quantity 1 (or 0 after it is sold)")
                size_variants = body.get("size_variants") if isinstance(body.get("size_variants"), list) else []
                color_variants = body.get("color_variants") if isinstance(body.get("color_variants"), list) else []
                measurements = body.get("measurements") if isinstance(body.get("measurements"), dict) else {}
            except ValueError as exc:
                return json_response({"ok": False, "error": str(exc)}, status=400)

            with get_db() as session:
                pid = safe_identifier(body.get("id")) or generate_uid("PRD")
                sku = clean_text(body.get("sku"), 50) or generate_uid("ADN-GEN")
                barcode_id = clean_text(body.get("barcode_id"), 50) or generate_uid("ADT")
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
                    name=clean_text(body.get("name", "Untitled Piece"), 255) or "Untitled Piece",
                    brand=clean_text(body.get("brand", "Adonai Basics" if item_condition == ItemCondition.BRAND_NEW.value else "Curated"), 100),
                    color=clean_text(body.get("color", ""), 50),
                    demographic=clean_text(body.get("demographic", "Men"), 50),
                    category=clean_text(body.get("category", "Outerwear & Jackets"), 100),
                    size=clean_text(body.get("size", "-"), 20),
                    item_condition=item_condition,
                    quantity_type=quantity_type,
                    condition=clean_text(body.get("condition", "Factory Fresh" if item_condition == ItemCondition.BRAND_NEW.value else "Grade A — Excellent"), 100),
                    size_variants_json=json.dumps([clean_text(v, 20) for v in size_variants[:20]]),
                    color_variants_json=json.dumps([clean_text(v, 50) for v in color_variants[:20]]),
                    factory_tag_notes=clean_multiline_text(body.get("factory_tag_notes", ""), 1000),
                    inner_packaging=clean_text(body.get("inner_packaging", ""), 30),
                    measurements_json=json.dumps({str(k)[:40]: clean_text(v, 80) for k, v in measurements.items()}),
                    fabric_grading_notes=clean_multiline_text(body.get("fabric_grading_notes", ""), 1000),
                    cost_price=supplied_cost,
                    base_price=allocation["base_price"],
                    total_transport_cost=allocation["total_transport_cost"],
                    selling_price=selling_price,
                    compare_price=compare_price,
                    in_stock_count=stock_count,
                    desc=clean_multiline_text(body.get("desc", ""), 4000),
                    image_url=safe_image_url(body.get("image_url", "")),
                    images=[safe_image_url(u) for u in (body.get("images") or []) if safe_image_url(u)][:12] if isinstance(body.get("images"), list) else [],
                    rack_location=clean_text(body.get("rack_location", "Rail A-1"), 50),
                    stock_lot_id=lot_id,
                    inventory_status=("AVAILABLE" if stock_count > 0 else "OUT_OF_STOCK"),
                )
                # Shareable permalink + thrift-specific PDP detail fields.
                prod.slug = unique_product_slug(
                    session, prod.name, sku, pid, clean_text(body.get("slug", ""), 200)
                )
                apply_pdp_fields(prod, body)
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
                    "name": 255, "brand": 100, "color": 50, "demographic": 50,
                    "category": 100, "size": 20, "condition": 100,
                    "rack_location": 50,
                }
                integer_fields = {"cost_price", "selling_price", "compare_price", "in_stock_count"}
                for key, max_len in text_fields.items():
                    if key in body:
                        setattr(prod, key, clean_text(body[key], max_len))
                try:
                    if "item_condition" in body or "inventory_type" in body:
                        current_condition = prod.item_condition.value if isinstance(prod.item_condition, ItemCondition) else (prod.item_condition or ItemCondition.PRE_LOVED.value)
                        prod.item_condition = normalize_item_condition(body.get("item_condition", body.get("inventory_type")), current_condition)
                    if "quantity_type" in body:
                        prod.quantity_type = normalize_quantity_type(body.get("quantity_type"), prod.item_condition.value if isinstance(prod.item_condition, ItemCondition) else str(prod.item_condition))
                    else:
                        prod.quantity_type = prod.item_condition.value if isinstance(prod.item_condition, ItemCondition) else str(prod.item_condition)
                except ValueError as exc:
                    return json_response({"ok": False, "error": str(exc)}, status=400)
                if "size_variants" in body:
                    prod.size_variants = [clean_text(v, 20) for v in (body.get("size_variants") or [])[:20]] if isinstance(body.get("size_variants"), list) else []
                if "color_variants" in body:
                    prod.color_variants = [clean_text(v, 50) for v in (body.get("color_variants") or [])[:20]] if isinstance(body.get("color_variants"), list) else []
                if "factory_tag_notes" in body:
                    prod.factory_tag_notes = clean_multiline_text(body["factory_tag_notes"], 1000)
                if "inner_packaging" in body:
                    prod.inner_packaging = clean_text(body["inner_packaging"], 30)
                if "measurements" in body:
                    values = body.get("measurements") if isinstance(body.get("measurements"), dict) else {}
                    prod.measurements = {str(k)[:40]: clean_text(v, 80) for k, v in values.items()}
                if "fabric_grading_notes" in body:
                    prod.fabric_grading_notes = clean_multiline_text(body["fabric_grading_notes"], 1000)
                if "desc" in body:
                    prod.desc = clean_multiline_text(body["desc"], 4000)
                if "image_url" in body:
                    prod.image_url = safe_image_url(body["image_url"])
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
                    supplied_images = body.get("images") or []
                    prod.images = [safe_image_url(u) for u in supplied_images if safe_image_url(u)][:12] if isinstance(supplied_images, list) else []
                apply_pdp_fields(prod, body)
                if "slug" in body or "name" in body or not prod.slug:
                    prod.slug = unique_product_slug(
                        session, prod.name, prod.sku, prod.id, clean_text(body.get("slug", ""), 200)
                    )
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
                condition_value = prod.item_condition.value if isinstance(prod.item_condition, ItemCondition) else str(prod.item_condition or ItemCondition.PRE_LOVED.value)
                if condition_value == ItemCondition.PRE_LOVED.value and prod.in_stock_count not in (0, 1):
                    return json_response({"ok": False, "error": "PRE_LOVED inventory must have quantity 1 (or 0 after it is sold)"}, status=400)
                prod.quantity_type = condition_value
                if prod.inventory_status not in {"ARCHIVED", "WRITTEN_OFF"}:
                    prod.inventory_status = "AVAILABLE" if prod.in_stock_count > 0 else "OUT_OF_STOCK"
                session.flush()
                return json_response({"ok": True, "status": "updated", "product": prod.to_dict()})

        if clean_path.startswith("/api/products/") and method == "GET":
            # Public PDP lookup: resolves by id, permalink slug, SKU or barcode
            # so /product/<slug> can hydrate from a single round trip.
            identifier = urllib.parse.unquote(clean_path.split("/")[-1])[:200]
            with get_db() as session:
                prod = lookup_product(session, identifier)
                if not prod:
                    return json_response({"error": "Product not found"}, status=404)
                data = prod.to_dict()
                held = (
                    session.query(func.coalesce(func.sum(InventoryLock.quantity), 0))
                    .filter(
                        InventoryLock.product_id == prod.id,
                        InventoryLock.expires_at > datetime.utcnow(),
                    )
                    .scalar()
                    or 0
                )
                data["authoritative_stock_count"] = data["in_stock_count"]
                data["in_stock_count"] = max(0, data["in_stock_count"] - int(held))
                data["available_count"] = data["in_stock_count"]
                return json_response({"product": data})

        # ----------------------------------------------------
        # 3. Real-time POS inventory locks (Protected)
        # ----------------------------------------------------
        if clean_path.startswith("/api/inventory-locks/") and method in ("GET", "POST"):
            action = clean_path.split("/")[-1]
            owner = str(body.get("lock_owner") or query_params.get("lock_owner", [""])[0]).strip()[:100]
            # Public cart reservations use short-lived WEB-* owners. They are
            # deliberately quantity-limited and expire automatically; staff
            # operations and POS holds still require their normal auth token.
            is_public_reservation = owner.startswith("WEB-") and len(owner) >= 12
            staff_info = None
            if not is_public_reservation:
                staff_info, auth_error = authenticated_or_response(headers, body, query_params)
                if auth_error:
                    return auth_error
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
                    item_condition = product.item_condition.value if isinstance(product.item_condition, ItemCondition) else (product.item_condition or ItemCondition.PRE_LOVED.value)
                    current = int(lock.quantity if lock else 0)
                    if item_condition == ItemCondition.PRE_LOVED.value and current + quantity > 1:
                        return json_response({"ok": False, "error": "PRE_LOVED pieces can only be reserved one at a time"}, status=409)
                    held_by_others = int(session.query(func.coalesce(func.sum(InventoryLock.quantity), 0)).filter(
                        InventoryLock.product_id == product_id,
                        InventoryLock.lock_owner != owner,
                        InventoryLock.expires_at > now,
                    ).scalar() or 0)
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
                # Drop abandoned online-payment orders out of the staff queue.
                expire_stale_flutterwave_orders(session)
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
                                if product.inventory_status == "OUT_OF_STOCK":
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
                # Reclaim stock from online-payment orders abandoned past their
                # payment window before promising stock to this new checkout.
                expire_stale_flutterwave_orders(session, now)
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
                # SECURITY: only accept well-formed client order IDs
                # (alphanumeric/dash/underscore); anything else is replaced
                # with a server-generated identifier.
                order_id = safe_identifier(body.get("id")) or f"AT-{int(time.time() * 1000) % 1000000:06d}-{uuid.uuid4().hex[:4].upper()}"
                if session.query(Order).filter_by(id=order_id).first():
                    return json_response({"ok": False, "error": "Duplicate order ID"}, status=409)
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
                        prod.inventory_status = "OUT_OF_STOCK"
                    order_items_objs.append(OrderItem(
                        id=f"ITEM-{order_id}-{len(order_items_objs) + 1}",
                        order_id=order_id,
                        product_id=prod.id,
                        barcode_id=prod.barcode_id,
                        name=prod.name,
                        item_condition=(prod.item_condition.value if isinstance(prod.item_condition, ItemCondition) else (prod.item_condition or ItemCondition.PRE_LOVED.value)),
                        quantity_type=(prod.quantity_type.value if isinstance(prod.quantity_type, QuantityType) else (prod.quantity_type or QuantityType.PRE_LOVED.value)),
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
                # Internally classify the complete catalog transport cost as one
                # transport-fee revenue line. Customers only see the checkout
                # half as their delivery fee; the embedded half stays hidden in
                # the product price but is included in this ledger total.
                transport_total = sum(
                    whole_money((products[pid].total_transport_cost or 0) * requested[pid])
                    for pid in requested
                )
                tender = body.get("tender") or {}
                cashier = body.get("cashier") or staff_info or {}
                tender_type = tender.get("type", "cash" if channel == "pos" else "mobile_money")

                # ---- Online payment intent (web storefront only) ----
                # 'payment_method: flutterwave' reserves the pieces and issues
                # a per-order payment token; the order only counts as PAID
                # after the gateway transaction is verified server-side.
                requested_payment_method = str(body.get("payment_method") or "").strip().lower()
                wants_online_payment = channel != "pos" and requested_payment_method in {"flutterwave", "online", "card"}
                if wants_online_payment and not payments.is_enabled():
                    return json_response({
                        "ok": False,
                        "error": "Online payment is not available right now — please choose pay on delivery",
                    }, status=503)
                if wants_online_payment:
                    # Route the double-entry debit to the online settlement
                    # account (1020) so the books reflect gateway collections,
                    # not loose mobile money.
                    tender_type = payments.PROVIDER
                payment_token = payments.new_payment_token() if wants_online_payment else ""
                order = Order(
                    id=order_id,
                    channel=channel,
                    # Web orders enter the POS fulfillment queue directly. They
                    # are not WhatsApp orders and always start unfulfilled.
                    status=("completed" if channel == "pos" else "unfulfilled"),
                    dispatch_status=("Completed" if channel == "pos" else "Unfulfilled"),
                    customer_name=clean_text(body.get("customer_name") or ("Walk-in Customer" if channel == "pos" else "Online Shopper"), 120),
                    customer_phone=clean_text(body.get("customer_phone", ""), 40),
                    customer_address=clean_multiline_text(body.get("customer_address") or body.get("delivery_address", ""), 500),
                    delivery_type=clean_text(body.get("delivery_type", "boda"), 30),
                    delivery_area=clean_text(body.get("delivery_area", ""), 120),
                    delivery_fee=delivery_fee,
                    delivery_notes=clean_multiline_text(body.get("delivery_notes", ""), 1000),
                    subtotal=subtotal,
                    total=grand_total,
                    tender_type=tender_type,
                    tender_amount=tender.get("tendered"),
                    tender_change=tender.get("change"),
                    payment_status=("pending" if wants_online_payment else "unpaid"),
                    payment_provider=(payments.PROVIDER if wants_online_payment else None),
                    payment_token_hash=(payments.hash_payment_token(payment_token) if wants_online_payment else None),
                    payment_expires_at=(now + timedelta(minutes=payments.PAYMENT_TTL_MINUTES) if wants_online_payment else None),
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
                    lines=sale_journal_lines(grand_total, cogs, tender_type, transport_total),
                )
                session.flush()

                # ---- Real-time notification broadcasts (non-blocking) ----
                order_number = order_id.split("-")[-1] if "-" in order_id else order_id
                if channel == "pos":
                    broadcast_event(
                        "NEW_ORDER",
                        f"🧾 POS Sale {order_id}",
                        f"POS sale recorded ({order.tender_type or 'cash'})",
                        {"order_id": order_id, "amount": grand_total,
                         "customer": order.customer_name, "channel": channel},
                    )
                else:
                    broadcast_event(
                        "NEW_ORDER",
                        f"🛍️ New {channel.title()} Order #{order_number}",
                        "New order received",
                        {"order_id": order_id, "amount": grand_total,
                         "customer": order.customer_name, "channel": channel},
                    )
                    inquiry = (order.delivery_notes or "").strip()
                    if inquiry:
                        broadcast_event(
                            "NEW_MESSAGE",
                            f"💬 Customer note on #{order_number}",
                            f"{order.customer_name}: “{inquiry[:140]}”",
                            {"order_id": order_id, "customer": order.customer_name,
                             "message": inquiry[:500]},
                        )
                for product in products.values():
                    remaining = max(0, int(product.in_stock_count or 0))
                    if remaining <= LOW_STOCK_THRESHOLD:
                        broadcast_event(
                            "LOW_STOCK",
                            ("🚨 Sold out — " if remaining == 0 else "⚠️ Low stock — ") + product.name,
                            (f"“{product.name}” is out of stock." if remaining == 0
                             else f"Only {remaining} unit(s) of “{product.name}” left."),
                            {"product_id": product.id, "name": product.name,
                             "remaining": remaining, "barcode": product.barcode_id},
                        )

                order_response = {
                    "status": "success",
                    "order": order.to_dict(),
                    "products": [product.to_dict() for product in products.values()],
                }
                if wants_online_payment:
                    # The payment token is issued ONCE, here, to the browser
                    # that placed the order. It authorizes payment initiation
                    # and verification for this order only, and is never stored
                    # anywhere server-side except as a SHA-256 hash.
                    order_response["payment"] = {
                        "provider": payments.PROVIDER,
                        "status": "pending",
                        "token": payment_token,
                        "expires_at": order.payment_expires_at.isoformat() if order.payment_expires_at else None,
                        "payment_window_minutes": payments.PAYMENT_TTL_MINUTES,
                    }
                return json_response(order_response, status=201)

        # ----------------------------------------------------
        # 4b. Online payments — Flutterwave (public, order-token scoped)
        # ----------------------------------------------------
        if clean_path == "/api/payments/config" and method == "GET":
            # Safe by design: only the PUBLIC key and display metadata.
            return json_response({"ok": True, **payments.public_checkout_config()})

        if clean_path == "/api/payments/status" and method == "GET":
            now = datetime.utcnow()
            with get_db() as session:
                order, error = load_order_for_payment(
                    session,
                    (query_params.get("order_id") or [""])[0],
                    (query_params.get("token") or [""])[0],
                )
                if not order:
                    return json_response({"ok": False, "error": error}, status=404)
                expire_stale_flutterwave_orders(session, now)
                return json_response({
                    "ok": True,
                    "order_id": order.id,
                    "payment_status": order.payment_status or "unpaid",
                    "total": order.total,
                    "paid_at": order.paid_at.isoformat() if order.paid_at else None,
                    "expires_at": order.payment_expires_at.isoformat() if order.payment_expires_at else None,
                })

        if clean_path == "/api/payments/flutterwave/session" and method == "POST":
            # Start one payment attempt: mint a unique tx_ref and hand the
            # browser everything the Inline popup needs (amount comes from the
            # server-side order row, never the client).
            if not payments.is_enabled():
                return json_response({"ok": False, "error": "Online payment is not available"}, status=503)
            if not rate_limiting_disabled():
                allowed, retry_after = _rate_limiter.check("flw.session", client_ip, 20, 60)
                if not allowed:
                    return json_response({
                        "ok": False, "error": "Too many payment attempts. Please wait a moment.",
                        "retry_after_seconds": retry_after,
                    }, status=429)
            now = datetime.utcnow()
            with get_db() as session:
                order, error = load_order_for_payment(session, body.get("order_id"), str(body.get("payment_token") or ""))
                if not order:
                    return json_response({"ok": False, "error": error}, status=404)
                if order.payment_provider != payments.PROVIDER:
                    return json_response({"ok": False, "error": "This order was not placed for online payment"}, status=409)
                expire_stale_flutterwave_orders(session, now)
                if order.payment_status == "paid":
                    return json_response({"ok": False, "error": "This order is already paid", "payment_status": "paid"}, status=409)
                if order.status in ("cancelled", "completed") or order.payment_status == "failed":
                    return json_response({
                        "ok": False,
                        "error": "The payment window for this order has closed and its pieces were released. Please place the order again.",
                        "payment_status": "expired",
                    }, status=410)

                attempt = PaymentTransaction(
                    id=generate_uid("PAY"),
                    tx_ref=payments.make_tx_ref(order.id),
                    order_id=order.id,
                    provider=payments.PROVIDER,
                    amount=int(order.total or 0),
                    currency=payments.FLW_CURRENCY,
                    status="pending",
                    created_at=now,
                    updated_at=now,
                )
                session.add(attempt)
                order.payment_reference = attempt.tx_ref
                order.updated_at = now
                session.flush()
                logger.info("Payment attempt %s opened for order %s (UGX %s)", attempt.tx_ref, order.id, order.total)
                return json_response({
                    "ok": True,
                    "provider": payments.PROVIDER,
                    "public_key": payments.public_checkout_config()["public_key"],
                    "mock": payments.MOCK_MODE,
                    "tx_ref": attempt.tx_ref,
                    "amount": attempt.amount,
                    "currency": attempt.currency,
                    "order_id": order.id,
                    "customer": {
                        "name": order.customer_name or "Online Shopper",
                        "phone": order.customer_phone or "",
                        "email": "",
                    },
                    "expires_at": order.payment_expires_at.isoformat() if order.payment_expires_at else None,
                })

        if clean_path == "/api/payments/flutterwave/verify" and method == "POST":
            # Called by the storefront after the Inline popup reports a charge.
            # The popup's own response is NEVER trusted — the transaction is
            # re-verified with Flutterwave using the secret key.
            if not payments.is_enabled():
                return json_response({"ok": False, "error": "Online payment is not available"}, status=503)
            if not rate_limiting_disabled():
                allowed, retry_after = _rate_limiter.check("flw.verify", client_ip, 30, 60)
                if not allowed:
                    return json_response({
                        "ok": False, "error": "Too many verification attempts. Please wait a moment.",
                        "retry_after_seconds": retry_after,
                    }, status=429)
            transaction_id = str(body.get("transaction_id") or "").strip()
            if not transaction_id:
                return json_response({"ok": False, "error": "transaction_id is required"}, status=400)
            now = datetime.utcnow()
            with get_db() as session:
                order, error = load_order_for_payment(session, body.get("order_id"), str(body.get("payment_token") or ""))
                if not order:
                    return json_response({"ok": False, "error": error}, status=404)
                if order.payment_provider != payments.PROVIDER:
                    return json_response({"ok": False, "error": "This order was not placed for online payment"}, status=409)
                expire_stale_flutterwave_orders(session, now)
                if order.payment_status == "paid":
                    return json_response({"ok": True, "payment_status": "paid", "order_id": order.id})
                if order.payment_status == "failed" or order.status in ("cancelled", "completed"):
                    return json_response({
                        "ok": False,
                        "error": "This order's payment window expired. If you were charged, contact the store with your payment receipt for a refund or fulfillment.",
                        "payment_status": "expired",
                    }, status=410)

                # In mock mode the local popup hands us back the session's
                # tx_ref so dev flow works end-to-end without a gateway.
                if payments.MOCK_MODE:
                    verified = payments.verify_transaction(transaction_id)
                    verified["tx_ref"] = str(body.get("tx_ref") or order.payment_reference or "")
                    verified["amount"] = order.total
                else:
                    try:
                        verified = payments.verify_transaction(transaction_id)
                    except payments.FlutterwaveApiError as exc:
                        return json_response({"ok": False, "error": str(exc), "payment_status": "pending"}, status=502)

                ok, payment_status, settle_error = settle_order_payment(
                    session, order, verified, source="browser_verify"
                )
                status_code = 200 if ok else 202 if payment_status == "pending" else 409
                return json_response({
                    "ok": ok,
                    "payment_status": payment_status,
                    "order_id": order.id,
                    "error": settle_error or None,
                }, status=status_code)

        if clean_path == "/api/payments/flutterwave/webhook" and method == "POST":
            # Server-to-server settlement. Authenticated via the verif-hash
            # header, then the transaction is re-verified against the API —
            # the webhook payload alone is never trusted.
            if not payments.verify_webhook_hash(headers):
                return json_response({"ok": False, "error": "Invalid webhook signature"}, status=401)
            payload = body if isinstance(body, dict) else {}
            event_name = str(payload.get("event") or "")
            data = payload.get("data") if isinstance(payload.get("data"), dict) else {}
            if event_name == "charge.completed" and str(data.get("status") or "").lower() == "successful":
                tx_ref = str(data.get("tx_ref") or "")
                transaction_id = data.get("id")
                now = datetime.utcnow()
                with get_db() as session:
                    attempt = (
                        session.query(PaymentTransaction)
                        .filter_by(provider=payments.PROVIDER, tx_ref=tx_ref)
                        .with_for_update()
                        .first()
                    ) or (
                        session.query(PaymentTransaction)
                        .filter_by(provider=payments.PROVIDER, flw_transaction_id=str(transaction_id)[:40])
                        .with_for_update()
                        .first()
                    )
                    order = (
                        session.query(Order).filter_by(id=attempt.order_id).with_for_update().first()
                        if attempt else None
                    )
                    if order and attempt:
                        if payments.MOCK_MODE:
                            verified = payments.verify_transaction(transaction_id or 0)
                            verified["tx_ref"] = attempt.tx_ref
                            verified["amount"] = order.total
                        else:
                            try:
                                verified = payments.verify_transaction(transaction_id)
                            except payments.FlutterwaveApiError as exc:
                                logger.warning("Webhook re-verify failed for %s: %s", tx_ref, exc)
                                verified = None
                        if verified:
                            settle_order_payment(session, order, verified, attempt=attempt, source="webhook")
            # Always acknowledge so Flutterwave stops retrying.
            return json_response({"ok": True})

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

                # ---- Real-time notification broadcast (non-blocking) ----
                broadcast_event(
                    "NEW_EXPENSE",
                    f"🧾 Expense logged — {category}",
                    f"UGX {amount:,} ({payment_method}) by {staff_info.get('name', 'Staff')}",
                    {"expense_id": expense_id, "category": category, "amount": amount,
                     "payment_method": payment_method,
                     "staff": staff_info.get("name", "Staff")},
                )

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
                    # Safe payment metadata (public key only) so the storefront
                    # can offer "Pay now" in the same sync round trip.
                    "payments": payments.public_checkout_config(),
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
                text_value = clean_text(value, 2000)
                if key in ("master_key", "admin_key"):
                    if len(text_value) < 6:
                        return json_response({
                            "ok": False,
                            "error": "Master key must be at least 6 characters"
                        }, status=400)
                    if text_value.lower() in RETIRED_DEFAULT_KEYS:
                        return json_response({
                            "ok": False,
                            "error": "This key value has been retired for security reasons. Choose a unique key."
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
            if len(candidate) > 1024:
                return json_response({"ok": False, "error": "Invalid Staff Terminal Key or PIN"}, status=401)

            # 1. Check Admin Environment Variables (constant-time, exact match)
            matched_admin_var = match_env_credential(candidate, ADMIN_ENV_VARS)
            if matched_admin_var:
                logger.info("[AUTH] Admin signed in via environment variable %s", matched_admin_var)
                staff_data = {
                    "id": "ENV-ADMIN",
                    "name": "Store Owner / Admin",
                    "role": "admin"
                }
                token = create_jwt_token(staff_data)
                return json_response({
                    "ok": True,
                    "via": f"env_admin:{matched_admin_var}",
                    "token": token,
                    "staff": staff_data
                })

            # 2. Check Staff / Terminal Environment Variables (constant-time)
            matched_staff_var = match_env_credential(candidate, STAFF_ENV_VARS)
            if matched_staff_var:
                logger.info("[AUTH] Staff signed in via environment variable %s", matched_staff_var)
                staff_data = {
                    "id": "ENV-STAFF",
                    "name": "POS Staff Terminal",
                    "role": "cashier"
                }
                token = create_jwt_token(staff_data)
                return json_response({
                    "ok": True,
                    "via": f"env_staff:{matched_staff_var}",
                    "token": token,
                    "staff": staff_data
                })

            # 3. Check Database Users & Settings.
            # PINs verify against salted PBKDF2 hashes (legacy SHA-256 hashes
            # are accepted once, then transparently upgraded). The retired
            # hardcoded default master key can never authenticate.
            with get_db() as session:
                user = find_user_by_pin(session, candidate)
                if user:
                    upgrade_legacy_pin_hash(session, user, candidate)
                    logger.info("[AUTH] %s (%s) signed in via database PIN", user.name, user.role)
                    staff_data = {"id": user.id, "name": user.name, "role": user.role}
                    token = create_jwt_token(staff_data)
                    return json_response({
                        "ok": True,
                        "via": "db",
                        "token": token,
                        "staff": staff_data
                    })

                # Check store settings keys (constant-time, exact match only)
                if candidate.lower() not in RETIRED_DEFAULT_KEYS:
                    settings_keys = ["master_key", "admin_key", "terminal_key", "staff_key"]
                    setting_rows = session.query(StoreSetting).filter(StoreSetting.key.in_(settings_keys)).all()
                    for s in setting_rows:
                        stored = str(s.value or "").strip()
                        if not stored or stored.lower() in RETIRED_DEFAULT_KEYS:
                            continue
                        if constant_time_equals(candidate, stored):
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

            logger.warning("[AUTH] Failed sign-in attempt from %s", client_ip)
            return json_response({"ok": False, "error": "Invalid Staff Terminal Key or PIN"}, status=401)

        return json_response({"error": "API route not found"}, status=404)

    except Exception as err:
        # SECURITY: log full details server-side, but never leak exception
        # messages (stack internals, SQL text, file paths) to API clients.
        logger.error("[API Error] %s on %s %s", err, method, path, exc_info=True)
        return json_response({"error": "Internal Server Error"}, status=500)
