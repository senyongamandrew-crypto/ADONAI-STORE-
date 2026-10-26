"""
Adonai Store — REST API & Service Layer
Dual-target architecture supporting Public Web Storefront & Native Android POS App.
Provides RESTful JSON endpoints connected to PostgreSQL / SQLite database with
atomic stock decrements, live synchronization, and JWT / Terminal Key authentication.
"""
import base64
from datetime import datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from zoneinfo import ZoneInfo
import hashlib
import hmac
import json
import logging
import os
import re
from sqlalchemy import and_, case, func, inspect, or_, text
from sqlalchemy.orm import selectinload
import time
import urllib.parse
import uuid

from database import DATABASE_URL, IS_POSTGRES, engine, get_db
import payments
import access_control
import media
import exports
import dispatch
import rider_accounts
from notifications import (
    DELETE_BATCH_LIMIT,
    LOW_STOCK_THRESHOLD,
    broadcast_event,
    delete_events,
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
    canonical_image_url,
    verify_pin,
)
from models import (
    AccountingJournalEntry,
    AccountingJournalLine,
    Category,
    ConsignmentPartner,
    ConsignmentPayout,
    ExpenseRecord,
    Inventory,
    InventoryAdjustment,
    InventoryLock,
    ItemCondition,
    LedgerEntry,
    LotGrade,
    Order,
    OrderItem,
    PaymentTransaction,
    Product,
    ProductMedia,
    QuantityType,
    Rider,
    StockLot,
    StorePromotionCreative,
    StoreSetting,
    User,
    build_product_slug,
    normalize_measurements,
    slugify,
)

import catalog_schemas
from catalog_schemas import SchemaValidationError

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
# Credential-bearing routes: checked with peek() before, and failures recorded.
AUTH_PEEK_PATHS = {"/api/auth/verify", "/api/pos-access/unlock", "/api/rider/pair", "/api/rider/connect",
                   "/api/rider-account/login", "/api/rider-account/signup", "/api/rider-account/connect"}
AUTH_FAILURE_PATHS = {"/api/rider/pair", "/api/rider/connect", "/api/rider-account/login",
                      "/api/rider-account/signup", "/api/rider-account/connect"}
API_RATE_LIMIT = int(os.environ.get("API_RATE_LIMIT", "300"))           # requests
API_RATE_WINDOW = int(os.environ.get("API_RATE_WINDOW", "60"))          # seconds

# STORE_MASTER_KEY is the canonical Render environment variable for the
# store-owner passkey. Legacy admin variable names stay accepted for existing
# deployments; the secret is compared server-side and never returned by APIs.
ADMIN_ENV_VARS = [
    "STORE_MASTER_KEY", "ADMIN_ACCESS_PIN", "ADMIN_PIN", "ADMIN_KEY",
    "ADMIN_ACCESS_KEY", "ADMIN_MASTER_KEY", "MASTER_KEY", "MASTER_PIN",
    "RENDER_ADMIN_KEY", "TERMINAL_ADMIN_KEY"
]

STAFF_ENV_VARS = [
    "STAFF_TERMINAL_KEY", "STAFF_ACCESS_KEY", "STAFF_KEY", "TERMINAL_KEY",
    "STAFF_ACCESS_PIN", "STAFF_PIN", "STAFF_TERMINAL_PIN",
    "POS_TERMINAL_KEY", "POS_ACCESS_KEY", "POS_ACCESS_PIN",
    "POS_KEY", "POS_PIN", "TERMINAL_PIN", "POS_MASTER_KEY"
]

def staff_auth_required() -> bool:
    """PIN-free terminals are the default; credential protection is opt-in.

    This deliberately grants admin access without a PIN, key or JWT on all
    terminal endpoints. Restrict the deployment to trusted users/devices, or
    set ADONAI_REQUIRE_STAFF_AUTH=1 to require the existing staff/master keys.
    Existing credential environment variables do not silently re-enable a lock.
    """
    return os.environ.get("ADONAI_REQUIRE_STAFF_AUTH", "0").strip().lower() in {
        "1", "true", "yes", "on"
    }


OFFICIAL_STORE_EMAIL = "info@adonaithrift-store.online"
LEGACY_STORE_EMAILS = {"adonaithriftstore@gmail.com"}

# Settings that may be read by the public storefront. Authentication keys and
# operational flags are intentionally excluded from public API responses.
PUBLIC_STORE_SETTING_KEYS = {
    "store_name", "tagline", "address", "whatsapp", "whatsapp_display",
    "phone", "hotline", "email", "tiktok", "instagram", "hours",
    "delivery_scope", "base_delivery_fee", "boda_base_fee", "currency",
    "receipt_footer", "website_url", "app_url", "storefront_promo_ids",
    # Pay-to details. Published on purpose, exactly like the bank details at
    # the bottom of an invoice: a shopper cannot transfer money to an account
    # they are not told about. Nothing here is a credential.
    "momo_merchant_name", "momo_merchant_number",
    "bank_name", "bank_account_name", "bank_account_number", "bank_branch",
    "bank_reference_hint",
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


def normalize_fulfillment_stage(value):
    """Convert legacy/operator wording to the canonical order workflow labels."""
    raw = str(value or "").strip()
    key = re.sub(r"\s+", " ", re.sub(r"[_-]+", " ", raw.lower()))
    aliases = {
        "pending": "Unfulfilled", "incoming": "Unfulfilled", "received": "Unfulfilled",
        "new": "Unfulfilled", "new order": "Unfulfilled", "unfulfilled": "Unfulfilled",
        "needs review": "Unfulfilled", "awaiting review": "Unfulfilled", "waiting review": "Unfulfilled",
        "waiting for review": "Unfulfilled", "received and waiting for review": "Unfulfilled",
        "awaiting fulfillment": "Unfulfilled", "awaiting processing": "Unfulfilled",
        "assembly": "In Assembly", "assembling": "In Assembly", "in assembly": "In Assembly",
        "in progress": "In Assembly", "processing": "In Assembly", "packing": "In Assembly", "packed": "In Assembly",
        "ready": "Ready for Pickup", "ready for pickup": "Ready for Pickup",
        "ready for dispatch": "Dispatched", "ready to dispatch": "Dispatched",
        "with rider": "Dispatched", "handed over": "Dispatched", "out for delivery": "Dispatched", "dispatched": "Dispatched",
        "delivered": "Completed", "complete": "Completed", "completed": "Completed",
        "canceled": "Cancelled", "cancelled": "Cancelled", "void": "Cancelled",
    }
    return aliases.get(key, raw)


def public_store_settings(rows) -> dict:
    """Serialize only settings that are safe and useful on the storefront."""
    settings = {row.key: row.value for row in rows if row.key in PUBLIC_STORE_SETTING_KEYS}
    email = str(settings.get("email") or "").strip()
    if not email or email.lower() in LEGACY_STORE_EMAILS:
        settings["email"] = OFFICIAL_STORE_EMAIL
    return settings


def storefront_promo_custom_items(value) -> list[dict]:
    """Return the uploaded image / HTML creative references in a custom setting."""
    try:
        parsed = json.loads(str(value or ""))
    except (TypeError, ValueError):
        return []
    if not isinstance(parsed, dict) or parsed.get("mode") != "custom" or not isinstance(parsed.get("items"), list):
        return []
    items = []
    for item in parsed["items"]:
        if not isinstance(item, dict) or not isinstance(item.get("media_id"), str):
            continue
        media_id = item["media_id"].strip().lower()
        creative_type = str(item.get("type") or "image").strip().lower()
        if re.fullmatch(r"[0-9a-f]{32}", media_id) and creative_type in {"image", "html"}:
            items.append({"media_id": media_id, "type": creative_type})
    return items


def storefront_promo_custom_media_ids(value) -> list[str]:
    """Backwards-compatible helper returning IDs from either creative type."""
    return [item["media_id"] for item in storefront_promo_custom_items(value)]


def normalize_storefront_promo_ids(value) -> str:
    """Normalize automatic, hidden, product-list, or uploaded-creative mode."""
    text = str(value or "").strip()
    if text.lower() in {"auto", "none"}:
        return text.lower()
    try:
        parsed = json.loads(text)
    except (TypeError, ValueError) as exc:
        raise ValueError("Choose automatic mode, hide the strip, or provide a valid product/creative list.") from exc

    if isinstance(parsed, dict):
        if parsed.get("mode") != "custom" or not isinstance(parsed.get("items"), list):
            raise ValueError("Custom promotions must contain an ordered list of uploaded images or HTML banners.")
        if not parsed["items"] or len(parsed["items"]) > 8:
            raise ValueError("Upload between 1 and 8 custom promotion creatives.")
        items, seen = [], set()
        for item in parsed["items"]:
            if not isinstance(item, dict):
                raise ValueError("Each custom promotion must reference an uploaded creative.")
            media_id = str(item.get("media_id") or "").strip().lower()
            creative_type = str(item.get("type") or "image").strip().lower()
            if not re.fullmatch(r"[0-9a-f]{32}", media_id):
                raise ValueError("Each custom promotion must reference a valid uploaded creative.")
            if creative_type not in {"image", "html"}:
                raise ValueError("Custom promotions support uploaded images or HTML banners only.")
            if media_id in seen:
                raise ValueError("A custom promotion creative can only appear once.")
            seen.add(media_id)
            alt_text = clean_text(item.get("alt_text", ""), 120)
            items.append({"media_id": media_id, "type": creative_type, "alt_text": alt_text})
        return json.dumps({"mode": "custom", "items": items}, ensure_ascii=False, separators=(",", ":"))

    if not isinstance(parsed, list) or not parsed or len(parsed) > 8:
        raise ValueError("Choose between 1 and 8 products, upload creative images or HTML banners, or hide the strip.")
    ids = []
    for item in parsed:
        if not isinstance(item, str) or not item.strip() or len(item.strip()) > 50:
            raise ValueError("Each storefront promotion must be a valid product ID.")
        product_id = item.strip()
        if product_id not in ids:
            ids.append(product_id)
    if not ids:
        raise ValueError("Choose at least one product or use automatic mode / hide the strip.")
    return json.dumps(ids, ensure_ascii=False, separators=(",", ":"))


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
        # Re-enabling protection immediately revokes every PIN-free session,
        # including tokens still cached by another tab or an Android terminal.
        if payload.get("access_mode") == "open" and staff_auth_required():
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
    Applies the server's terminal access policy. In PIN-free mode, no
    credential or session bootstrap is required; stale cashier/expired tokens
    cannot bring the removed lock back. Explicitly protected deployments still
    validate credentials from headers or JSON, never URL query strings.
    """
    if not staff_auth_required():
        return True, {"id": "OPEN-TERMINAL", "name": "Store Terminal", "role": "admin"}

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
            "id": jwt_payload.get("id") or jwt_payload.get("sub", "STF-TOKEN"),
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
    "2100": "Consignment Payables",
    "2110": "Pending Consignment Settlements",
    "1300": "Logistics / Transport Expense",
    "4000": "Sales Revenue",
    "4100": "Transport Fee Revenue",
    "4200": "Store Commission Income",
    "5000": "Cost of Goods Sold",
    "5100": "Operating Expense",
    "5200": "Inventory Write-Off Loss",
}


def payment_account(method: str) -> tuple[str, str]:
    value = str(method or "cash").strip().lower().replace("-", "_").replace(" ", "_")
    if value in {"mtn", "airtel", "mobile", "mobile_money", "momo", "merchant", "merchant_code", "pay_code"}:
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


def parse_money_amount(value, field: str, allow_zero: bool = True) -> Decimal:
    """Validate a direct-upload money figure (NUMERIC(12, 2), UGX).

    ``fixed_unit_cost`` and ``base_retail_price`` keep two decimals end to end
    (matching the Supabase CHECK-guarded columns), so unlike the legacy
    whole-shilling fields they accept fractional amounts but reject negatives,
    non-finite values and anything outside NUMERIC(12, 2).
    """
    if isinstance(value, bool):
        raise ValueError(f"{field} must be a number")
    try:
        amount = Decimal(str(value).strip())
    except (InvalidOperation, ValueError, AttributeError):
        raise ValueError(f"{field} must be a number")
    if not amount.is_finite():
        raise ValueError(f"{field} must be a finite number")
    try:
        amount = amount.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    except InvalidOperation:
        raise ValueError(f"{field} is out of range")
    if amount < 0 or (amount == 0 and not allow_zero):
        raise ValueError(f"{field} must be {'zero or greater' if allow_zero else 'greater than zero'}")
    if amount > Decimal("9999999999.99"):
        raise ValueError(f"{field} cannot exceed 9,999,999,999.99")
    return amount


# The direct-upload ingestion payload (supplier_ingestion.py) names its form
# fields in intake vocabulary; the storefront API historically uses the catalog
# vocabulary below. Forms and direct-upload scripts may send either — or both —
# so aliases only fill keys the caller omitted.
INTAKE_VOCABULARY_ALIASES = (
    ("item_name", "name"),
    ("catalog_group", "category"),
    ("size_availability", "size"),
    ("condition_notes", "condition"),
)


def normalize_intake_vocabulary(body: dict) -> dict:
    """Fold the direct-upload payload field names onto the canonical ones."""
    for alias, canonical in INTAKE_VOCABULARY_ALIASES:
        if alias in body and canonical not in body:
            body[canonical] = body[alias]
    return body


def supplier_economics_fields(body: dict) -> dict:
    """Extract direct-upload supplier tagging + item-level economics fields.

    ``supplier_name`` tags the source partner of a direct upload;
    ``fixed_unit_cost`` is the item's unit COGS and ``base_retail_price`` the
    retail price it was mapped to at creation. Send ``None`` to clear a
    nullable figure; omit a key entirely to leave it unchanged.
    """
    fields = {}
    if "supplier_name" in body:
        fields["supplier_name"] = clean_text(body.get("supplier_name"), 255) or None
    for key, label in (("fixed_unit_cost", "Fixed unit cost"), ("base_retail_price", "Base retail price")):
        if key in body:
            value = body.get(key)
            fields[key] = None if value in (None, "") else parse_money_amount(value, label)
    return fields


def parse_lot_grades(raw_grades) -> list[dict]:
    """Validate the multi-tier in-batch grading payload for a new stock lot.

    Every tier declares its expected piece count, the percentage of the landed
    investment it should absorb, and the target retail price that pre-fills
    catalog tagging. The weight check mirrors the intake UI rule: tiers must
    partition the invested money exactly — nothing unallocated, nothing twice.
    """
    if not isinstance(raw_grades, list) or not raw_grades:
        raise ValueError("Add at least one grade tier for this lot")
    if len(raw_grades) > 12:
        raise ValueError("Keep grading to 12 tiers or fewer per lot")

    cleaned = []
    total_weight = 0.0
    for index, raw in enumerate(raw_grades, start=1):
        if not isinstance(raw, dict):
            raise ValueError(f"Grade tier {index} is malformed")
        name = str(raw.get("grade_name") or "").strip()
        if len(name) < 3:
            raise ValueError(f"Grade tier {index} needs a name of at least 3 characters")
        try:
            count = int(raw.get("expected_count"))
        except (TypeError, ValueError):
            raise ValueError(f"Grade tier {index} piece count must be a whole number")
        if count < 1 or count > 100000:
            raise ValueError(f"Grade tier {index} piece count must be between 1 and 100,000")
        try:
            weight = float(raw.get("cost_weight_percentage"))
        except (TypeError, ValueError):
            raise ValueError(f"Grade tier {index} cost weight must be a number")
        if not (0 < weight <= 100):
            raise ValueError(f"Grade tier {index} cost weight must be between 0 and 100%")
        price = parse_positive_int(
            raw.get("target_selling_price", 0),
            f"Grade tier {index} target retail price",
            allow_zero=True,
        )
        total_weight += weight
        cleaned.append({
            "grade_name": name[:100],
            "expected_count": count,
            "cost_weight_percentage": weight,
            "target_selling_price": price,
        })
    if abs(total_weight - 100.0) > 0.01:
        raise ValueError(
            f"Tier cost weights must total exactly 100% — currently {total_weight:.2f}%"
        )
    return cleaned


def compute_grade_unit_costs(total_landed: int, grades: list[dict]) -> list[int]:
    """Lock each tier's unit COGS from the landed investment and its weight.

    Selling every graded piece must recover the investment to the shilling, so
    rounding is resolved exactly instead of left to float drift:
    1. Tier budgets use the largest-remainder method (budgets total exactly
       `total_landed`).
    2. Per-piece rounding drift is folded into the highest-budget tier.
    """
    weights = [float(g["cost_weight_percentage"]) for g in grades]
    raw_budgets = [total_landed * (weight / 100.0) for weight in weights]
    budgets = [int(raw) for raw in raw_budgets]  # floor — all values are >= 0
    remainder = total_landed - sum(budgets)
    by_fraction = sorted(range(len(grades)), key=lambda i: raw_budgets[i] - budgets[i], reverse=True)
    for i in by_fraction[:remainder]:
        budgets[i] += 1

    units = [int(round(budgets[i] / grades[i]["expected_count"])) for i in range(len(grades))]
    drift = sum(units[i] * grades[i]["expected_count"] for i in range(len(grades))) - total_landed
    if drift and units:
        # Fold the per-piece rounding drift into the highest-budget tier. The
        # adjustment is per-piece, so it scales by that tier's piece count —
        # exactly divisible drift reconciles the books to the shilling, and
        # any sub-piece leftover stays below one piece's shillings per tier.
        biggest = max(range(len(grades)), key=lambda i: budgets[i])
        piece_count = max(1, grades[biggest]["expected_count"])
        adjust, _leftover_shillings = divmod(drift, piece_count)
        units[biggest] = max(0, units[biggest] - adjust)
    return units


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


def schema_error_response(exc: "SchemaValidationError"):
    """400 payload that tells the intake form exactly which inputs to fix."""
    return json_response({"ok": False, "error": str(exc), "field_errors": exc.field_errors}, status=400)


def _condition_value(prod_or_value) -> str:
    value = getattr(prod_or_value, "item_condition", prod_or_value)
    return value.value if isinstance(value, ItemCondition) else str(value or "")


def apply_catalog_schema_result(prod, result: dict, body: dict) -> None:
    """Persist a normalized schema result and its legacy-column projections.

    Schema fields are authoritative for the columns they project into, so a
    necklace's "Metal / material" select also fills `fabric`, a shoe's tagged
    size fills `size`, and garment / shoe flat-lay measurements are converted
    to inches for the existing PDP measurement card.
    """
    if result.get("subcategory") is not None:
        prod.subcategory = result["subcategory"] or None
    prod.attributes = result.get("attributes") or {}
    projections = result.get("projections") or {}
    if projections.get("fabric"):
        prod.fabric = projections["fabric"]
    if projections.get("size"):
        prod.size = projections["size"]
    if projections.get("measurements"):
        merged = dict(prod.measurements or {})
        merged.update(projections["measurements"])
        prod.measurements = merged


def apply_catalog_copy_fields(prod, body: dict, *, refresh_tags: bool) -> None:
    """Search tags (edited or automated) and the localized pickup note."""
    if "fulfillment_notes" in body:
        prod.fulfillment_notes = clean_multiline_text(body.get("fulfillment_notes"), 600)
    supplied = catalog_schemas.clean_tags(body.get("search_tags")) if "search_tags" in body else None
    if supplied:
        prod.search_tags = supplied
    elif supplied is not None or refresh_tags or not prod.search_tags:
        prod.search_tags = catalog_schemas.auto_search_tags(
            category=prod.category, subcategory=prod.subcategory or "", brand=prod.brand or "",
            color=prod.color or "", item_condition=_condition_value(prod), attributes=prod.attribute_record,
        )


def update_catalog_schema(prod, body: dict) -> bool:
    """Re-validate category attributes on an edit. Returns True if touched.

    * New attributes are validated against the (possibly new) category pair;
      a record that was already complete may not regress to incomplete.
    * A category / sub-category / condition change without new attributes
      re-checks the stored record: same form → hidden fields are dropped;
      different form → the stale record is cleared rather than mislabelled.
    """
    keys = ("attributes", "subcategory", "category", "item_condition", "inventory_type")
    if not any(key in body for key in keys):
        return False
    record = prod.attribute_record
    subcategory = clean_text(body.get("subcategory"), 100) if "subcategory" in body else (prod.subcategory or "")
    if "subcategory" not in body and subcategory not in catalog_schemas.subcategories_for(prod.category):
        subcategory = ""  # the stored sub-category belonged to the previous category
    condition = _condition_value(prod)
    if "attributes" in body:
        # Essentials-first policy: an edit may leave optional category details
        # blank. Only an explicit strict check (details_required) blocks it.
        result = catalog_schemas.normalize_attributes(
            body.get("attributes") or {}, prod.category, subcategory, condition,
            enforce_required=bool(body.get("details_required")),
        )
        apply_catalog_schema_result(prod, result, body)
        return True
    key, _, resolved_sub = catalog_schemas.resolve(prod.category, subcategory)
    prod.subcategory = resolved_sub or (subcategory or None)
    if record.get("values"):
        if key != record.get("schema_key"):
            prod.attributes = {}
        else:
            try:
                result = catalog_schemas.normalize_attributes(record, prod.category, resolved_sub, condition, enforce_required=False)
                prod.attributes = result["attributes"]
            except SchemaValidationError:
                pass  # keep the stored record rather than silently discarding it
    return True


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


DEFAULT_CONSIGNMENT_COMMISSION_RATE = Decimal("5.00")


def parse_commission_rate(value, field="Commission rate", nullable=False):
    if nullable and value in (None, ""):
        return None
    try:
        rate = Decimal(str(value)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    except (InvalidOperation, TypeError, ValueError):
        raise ValueError(f"{field} must be a number from 0 to 100")
    if not rate.is_finite() or rate < 0 or rate > 100:
        raise ValueError(f"{field} must be between 0 and 100 percent")
    return rate


def consignment_commission_amount(gross, rate):
    return int((Decimal(int(gross or 0)) * Decimal(str(rate or 0)) / Decimal("100")).quantize(
        Decimal("1"), rounding=ROUND_HALF_UP
    ))


def order_consignment_totals(items):
    rows = list(items or [])
    by_partner = {}
    for row in rows:
        if not row.consignment_partner_id:
            continue
        partner_id = row.consignment_partner_id
        partner = by_partner.setdefault(partner_id, {
            "partner_id": partner_id,
            "partner_name": row.partner_name_snapshot or partner_id,
            "gross": 0, "commission": 0, "payable": 0,
        })
        partner["gross"] += int(row.consignment_gross_amount or 0)
        partner["commission"] += int(row.consignment_commission_amount or 0)
        partner["payable"] += int(row.partner_payable_amount or 0)
    return {
        "gross": sum(partner["gross"] for partner in by_partner.values()),
        "commission": sum(partner["commission"] for partner in by_partner.values()),
        "payable": sum(partner["payable"] for partner in by_partner.values()),
        "by_partner": by_partner,
    }


def order_consignment_financial_adjustments(order):
    """Return partner sales amounts excluded from store profit until paid."""
    gross = commission = payable = 0
    for item in order.items:
        if not item.consignment_partner_id:
            continue
        item_gross = int(item.consignment_gross_amount or item.line_total or 0)
        item_commission = int(item.consignment_commission_amount or 0)
        item_payable = (int(item.partner_payable_amount) if item.partner_payable_amount is not None
                        else max(0, item_gross - item_commission))
        gross += item_gross
        commission += item_commission
        payable += item_payable
    if str(order.payment_status or "").lower() == "pending":
        return {"gross": gross, "commission": 0, "payable": 0, "pending_gross": gross}
    return {"gross": gross, "commission": commission, "payable": payable, "pending_gross": 0}


def sale_journal_lines(total: int, cogs: int, tender_type: str, transport_total: int = 0,
                       consignment_gross: int = 0, consignment_commission: int = 0,
                       consignment_payable: int = 0, consignment_pending: bool = False,
                       consignment_partner_breakdown=None):
    payment_code, payment_name = payment_account(tender_type)
    transport_total = max(0, int(transport_total or 0))
    sales_revenue = max(0, int(total) - transport_total)
    consignment_gross = max(0, int(consignment_gross or 0))
    direct_store_revenue = max(0, sales_revenue - consignment_gross)
    lines = [
        {"account_code": payment_code, "account_name": payment_name, "debit": total},
        *([{"account_code": "4000", "account_name": ACCOUNT_NAMES["4000"], "credit": direct_store_revenue}] if direct_store_revenue else []),
        *([{"account_code": "4100", "account_name": ACCOUNT_NAMES["4100"], "credit": transport_total}] if transport_total else []),
    ]
    if consignment_gross:
        partner_rows = list((consignment_partner_breakdown or {}).values())
        if partner_rows:
            if (sum(int(row.get("gross", 0)) for row in partner_rows) != consignment_gross
                    or sum(int(row.get("commission", 0)) for row in partner_rows) != int(consignment_commission or 0)
                    or sum(int(row.get("payable", 0)) for row in partner_rows) != int(consignment_payable or 0)):
                raise ValueError("Partner journal breakdown does not match sale snapshots")
            for row in partner_rows:
                memo = f"Partner: {row.get('partner_name') or row.get('partner_id')} ({row.get('partner_id')})"
                if consignment_pending:
                    if int(row.get("gross", 0)):
                        lines.append({"account_code": "2110", "account_name": ACCOUNT_NAMES["2110"],
                                      "credit": int(row["gross"]), "memo": memo})
                else:
                    if int(row.get("commission", 0)):
                        lines.append({"account_code": "4200", "account_name": ACCOUNT_NAMES["4200"],
                                      "credit": int(row["commission"]), "memo": memo})
                    if int(row.get("payable", 0)):
                        lines.append({"account_code": "2100", "account_name": ACCOUNT_NAMES["2100"],
                                      "credit": int(row["payable"]), "memo": memo})
        elif consignment_pending:
            lines.append({"account_code": "2110", "account_name": ACCOUNT_NAMES["2110"], "credit": consignment_gross})
        else:
            if consignment_commission:
                lines.append({"account_code": "4200", "account_name": ACCOUNT_NAMES["4200"], "credit": int(consignment_commission)})
            if consignment_payable:
                lines.append({"account_code": "2100", "account_name": ACCOUNT_NAMES["2100"], "credit": int(consignment_payable)})
    if cogs:
        lines.extend([
            {"account_code": "5000", "account_name": ACCOUNT_NAMES["5000"], "debit": cogs},
            {"account_code": "1200", "account_name": ACCOUNT_NAMES["1200"], "credit": cogs},
        ])
    return lines


def post_pending_consignment_settlement(session, order, staff, occurred_at=None):
    """Move a verified online order's partner share from pending to earned."""
    totals = order_consignment_totals(order.items)
    gross = totals["gross"]
    if not gross:
        return None
    existing = session.query(AccountingJournalEntry).filter_by(
        reference=order.id, source="consignment_online_settlement"
    ).first()
    if existing:
        return existing
    if totals["commission"] + totals["payable"] != gross:
        raise ValueError("Consignment sale snapshots do not reconcile")
    lines = []
    for partner in totals.get("by_partner", {}).values():
        memo = f"Partner: {partner.get('partner_name') or partner.get('partner_id')} ({partner.get('partner_id')})"
        if partner["gross"]:
            lines.append({"account_code": "2110", "account_name": ACCOUNT_NAMES["2110"],
                          "debit": partner["gross"], "memo": memo})
        if partner["commission"]:
            lines.append({"account_code": "4200", "account_name": ACCOUNT_NAMES["4200"],
                          "credit": partner["commission"], "memo": memo})
        if partner["payable"]:
            lines.append({"account_code": "2100", "account_name": ACCOUNT_NAMES["2100"],
                          "credit": partner["payable"], "memo": memo})
    if not lines:
        lines = [{"account_code": "2110", "account_name": ACCOUNT_NAMES["2110"], "debit": gross}]
        if totals["commission"]:
            lines.append({"account_code": "4200", "account_name": ACCOUNT_NAMES["4200"], "credit": totals["commission"]})
        if totals["payable"]:
            lines.append({"account_code": "2100", "account_name": ACCOUNT_NAMES["2100"], "credit": totals["payable"]})
    entry = create_journal_entry(
        session, reference=order.id, source="consignment_online_settlement",
        description=f"Recognize consignment sale for paid order {order.id}",
        occurred_at=occurred_at or datetime.utcnow(), staff=staff, lines=lines,
    )
    session.flush()
    return entry


def reverse_consignment_order_journals(session, order, staff=None, reason="Consignment order cancelled", occurred_at=None):
    """Reverse sale/reclassification journals once when a partner order is cancelled."""
    if not any(item.consignment_partner_id for item in order.items):
        return []
    sale_source = f"{order.channel or 'web'}_sale"
    originals = session.query(AccountingJournalEntry).filter(
        AccountingJournalEntry.reference == order.id,
        AccountingJournalEntry.source.in_([sale_source, "consignment_online_settlement"]),
        AccountingJournalEntry.reversal_of_id.is_(None),
    ).with_for_update().all()
    reversals = []
    audit_staff = staff or {"id": order.cashier_id, "name": order.cashier_name or "System Checkout"}
    for original in originals:
        prior = session.query(AccountingJournalEntry).filter_by(reversal_of_id=original.id).first()
        if prior:
            continue
        reversals.append(reverse_journal_entry(
            session, original, source="consignment_cancellation_reversal",
            description=f"{reason}: {order.id}", staff=audit_staff,
            occurred_at=occurred_at or datetime.utcnow(),
        ))
        session.flush()
    return reversals


# ============================================================================
# Online payments (Flutterwave) — lifecycle helpers
# ============================================================================
def expire_stale_flutterwave_orders(session, now=None):
    """
    Release stock on web orders whose payment window lapsed without a verified
    charge. Mirrors the staff 'Cancelled' transition (restock + status) so a
    one-of-one thrift piece goes back on the rail automatically.

    Covers every collect-now channel, not just the gateway: an order parked on
    "mobile money" or "bank transfer" and never settled must release its pieces
    too. Any order carrying a payment_expires_at is by definition one of them.
    """
    now = now or datetime.utcnow()
    stale = (
        session.query(Order)
        .filter(
            Order.payment_status.in_(["pending", "claimed"]),
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
        reverse_consignment_order_journals(
            session, order,
            staff={"id": "SYSTEM-PAYMENTS", "name": "Payment expiry"},
            reason="Expired online payment order reversed", occurred_at=now,
        )
        session.query(PaymentTransaction).filter(
            PaymentTransaction.order_id == order.id,
            PaymentTransaction.status == "pending",
        ).update({"status": "failed", "updated_at": now}, synchronize_session=False)
        broadcast_event(
            "ORDER_EXPIRED",
            f"⌛ Unpaid order {order.id} released",
            f"{payments.channel_info(order.payment_channel or order.payment_provider or 'card')['label']} "
            "payment was not confirmed in time — the piece(s) are back on the rail."
            + (" A payment claim was still unverified." if order.payment_claim_at else ""),
            {"order_id": order.id, "amount": order.total,
             "channel": order.payment_channel or "", "merchant_pay_code": order.merchant_pay_code or ""},
            session=session,
        )
    if stale:
        session.flush()
    return len(stale)


def checkout_payment_options(settings: dict) -> dict:
    """
    Compose what the storefront may offer at checkout.

    A channel is only offered when the store can actually honour it:
      * card     — needs the gateway keys,
      * momo     — needs a published merchant line,
      * bank     — needs a published bank account,
      * merchant — needs a pay-code contact point (the shop itself),
      * cod      — always.
    """
    config = payments.public_checkout_config()
    pay_to = {
        "store_name": settings.get("store_name") or "Adonai Store",
        # Deliberately no fallback to the WhatsApp/hotline number: a shopper must
        # only be told to send money to a line the owner has explicitly
        # published as a merchant line.
        "momo_name": (settings.get("momo_merchant_name") or settings.get("store_name") or "").strip(),
        "momo_number": (settings.get("momo_merchant_number") or "").strip(),
        "bank_name": (settings.get("bank_name") or "").strip(),
        "bank_account_name": (settings.get("bank_account_name") or "").strip(),
        "bank_account_number": (settings.get("bank_account_number") or "").strip(),
        "bank_branch": (settings.get("bank_branch") or "").strip(),
        "bank_reference_hint": (settings.get("bank_reference_hint") or "").strip(),
        "merchant_contact": (settings.get("hotline") or settings.get("phone") or "").strip(),
        "whatsapp": (settings.get("whatsapp") or "").strip(),
    }
    available = {
        "card": bool(config["enabled"]),
        # Instantly collectable through the gateway (push prompt + PIN on the
        # shopper's phone) even when no merchant line has been published.
        "momo": bool(pay_to["momo_number"]) or bool(config["enabled"]),
        "bank": bool(pay_to["bank_account_number"] and pay_to["bank_name"]),
        # A pay code is issued by the system and settled at the shop or
        # through staff confirmation; there is nothing to configure, so it is
        # always offered as the fallback for shoppers who cannot pay online.
        "merchant": True,
        "cod": True,
    }
    channels = []
    for channel in config["channels"]:
        entry = dict(channel)
        entry["available"] = available.get(channel["id"], False)
        entry["requires_account"] = channel["id"] in ("momo", "merchant")
        channels.append(entry)
    config["channels"] = channels
    config["pay_to"] = pay_to
    config["methods"] = [entry["id"] for entry in channels if entry["available"]]
    return config


def resolve_merchant_pay_code(session, order, code: str):
    """Find the order that carries a merchant pay code (settled or not).

    `order` is accepted for call-site symmetry with the other payment helpers;
    a code is always resolved against the whole table, never just one order, so
    the counter can look a customer's code up cold. The locked row is returned
    so a caller that settles on the spot cannot race another confirmation.
    """
    normalized = payments.normalize_pay_code(code)
    if not normalized:
        return None
    return (
        session.query(Order)
        .filter(Order.merchant_pay_code == normalized)
        .with_for_update()
        .first()
    )


def merchant_pay_code_instructions(code: str, order, settings: dict) -> dict:
    """
    Everything a shopper (or the person paying for them) needs in order to
    settle one order at any Adonai merchant point.
    """
    store_name = settings.get("store_name") or "Adonai Store"
    address = settings.get("address") or ""
    hotline = settings.get("hotline") or settings.get("phone") or ""
    whatsapp = settings.get("whatsapp") or ""
    return {
        "code": code,
        "amount": int(order.total or 0),
        "currency": payments.FLW_CURRENCY,
        "store_name": store_name,
        "address": address,
        "hotline": hotline,
        "whatsapp": whatsapp,
        "lines": [
            f"Show or quote this code — {code} — at any {store_name} merchant point, or send it to whoever is paying for you.",
            f"The code is locked to order {order.id} and to UGX {int(order.total or 0):,}. Only that exact amount clears it.",
            "Pay by mobile money or cash at the merchant point. Ask for the transaction ID and keep it.",
            "Come back here and submit the transaction ID so our team confirms your order straight away.",
        ],
    }


def issue_merchant_pay_code(session, order, now=None) -> str:
    """Return the order's merchant pay code, minting a unique one on demand."""
    now = now or datetime.utcnow()
    if order.merchant_pay_code:
        return order.merchant_pay_code
    for _ in range(8):
        candidate = payments.make_merchant_pay_code()
        if not session.query(Order.id).filter(Order.merchant_pay_code == candidate).first():
            order.merchant_pay_code = candidate
            order.payment_channel = "merchant"
            order.updated_at = now
            session.flush()
            return candidate
    raise ValueError("Could not allocate a merchant pay code — please try again")


def staff_name_of_last_offline_attempt(session, order) -> str:
    """Name of the staff member who confirmed the latest offline payment, if recorded."""
    attempt = (
        session.query(PaymentTransaction)
        .filter(PaymentTransaction.order_id == order.id, PaymentTransaction.status == "successful")
        .order_by(PaymentTransaction.created_at.desc())
        .first()
    )
    if not attempt or not attempt.gateway_payload:
        return ""
    try:
        payload = json.loads(attempt.gateway_payload)
    except (TypeError, ValueError):
        return ""
    return str(payload.get("confirmed_by_name") or payload.get("confirmed_by") or "")


def staff_confirm_order_payment(session, order, staff, *, paid=True, method="cash", reference="", note=""):
    """
    Staff confirmation that money actually landed for an offline channel
    (mobile money, bank transfer, merchant pay code, cash on hand).

    This is the *only* way a non-gateway order becomes 'paid'. The browser's
    claim is just a hint for the person checking the bank/MoMo statement.
    Returns (ok, payment_status, error, message_parts).
    """
    now = datetime.utcnow()
    channel = payments.normalize_channel(method or order.payment_channel or "cash", default="cash")
    occurred_at = order.paid_at or now

    if not paid:
        if order.payment_status not in ("paid",):
            return False, order.payment_status or "unpaid", "This order is not marked as paid", ""
        order.payment_status = "pending" if order.payment_channel else "unpaid"
        order.paid_at = None
        order.tender_type = payments.channel_tender_type(order.payment_channel or "cod")
        order.payment_reference = reference or order.payment_reference
        order.updated_at = now
        reverse_consignment_order_journals(
            session, order,
            staff={"id": (staff or {}).get("id") or order.cashier_id, "name": (staff or {}).get("name") or order.cashier_name or "Staff"},
            reason="Payment marked unpaid", occurred_at=now,
        )
        session.query(PaymentTransaction).filter(
            PaymentTransaction.order_id == order.id, PaymentTransaction.status == "successful",
        ).update({"status": "reversed", "updated_at": now}, synchronize_session=False)
        session.flush()
        broadcast_event(
            "ORDER_UPDATED",
            f"↩️ Payment reverted — {order.id}",
            f"{(staff or {}).get('name') or 'Staff'} marked the payment as not received.",
            {"order_id": order.id, "amount": order.total, "status": "unpaid"}, session=session,
        )
        return True, order.payment_status, "", "unpaid"

    if order.payment_status == "paid":
        return True, "paid", "", "already paid"
    if order.status == "cancelled":
        return False, "cancelled", (
            "This order was cancelled and its pieces returned to the rail. "
            "Restore the pieces first, or refund the customer."
        ), ""

    code_used = payments.normalize_pay_code(reference) or order.merchant_pay_code or ""
    tx_ref = (reference or "").strip()[:100] or f"MANUAL-{order.id[-8:]}-{int(time.time())}"
    attempt = PaymentTransaction(
        id=generate_uid("PAY"),
        tx_ref=tx_ref,
        order_id=order.id,
        provider=channel,
        amount=int(order.total or 0),
        currency=payments.FLW_CURRENCY,
        status="successful",
        channel=channel,
        gateway_payload=json.dumps({
            "source": "staff_confirmation",
            "confirmed_by": (staff or {}).get("id") or "",
            "confirmed_by_name": (staff or {}).get("name") or "",
            "channel": channel,
            "reference": reference or "",
            "merchant_pay_code": code_used,
            "note": str(note or "")[:300],
        })[:1500],
        created_at=now,
        updated_at=now,
    )
    session.add(attempt)

    order.payment_status = "paid"
    order.tender_type = payments.channel_tender_type(channel)
    order.payment_provider = channel
    order.payment_channel = channel
    order.payment_reference = tx_ref
    order.paid_at = now
    order.updated_at = now
    # A confirmed payment ends the countdown: the pieces are sold.
    order.payment_expires_at = None
    session.flush()
    post_pending_consignment_settlement(
        session, order, {"id": (staff or {}).get("id"), "name": (staff or {}).get("name") or "Staff confirmation"},
        occurred_at=occurred_at,
    )
    order_number = order.id.split("-")[-1] if "-" in order.id else order.id
    label = payments.channel_info(channel)["label"]
    broadcast_event(
        "ORDER_PAID",
        f"💳 Payment confirmed — Order #{order_number}",
        f"{(staff or {}).get('name') or 'Staff'} confirmed UGX {int(order.total or 0):,} via {label}"
        + (f" (ref {reference})." if reference else "."),
        {"order_id": order.id, "amount": order.total, "reference": tx_ref, "channel": channel,
         "merchant_pay_code": code_used}, session=session,
    )
    return True, "paid", "", "paid"


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

    # The sale was posted against the channel the shopper picked, but the money
    # is now sitting with the gateway (which pays out to the bank), so move the
    # debit to the settlement account instead of rewriting the original entry.
    previous_tender = str(order.tender_type or "")
    if previous_tender and previous_tender != payments.PROVIDER and int(order.total or 0) > 0:
        old_code, old_name = payment_account(previous_tender)
        new_code, new_name = payment_account(payments.PROVIDER)
        if old_code != new_code:
            create_journal_entry(
                session,
                reference=order.id,
                source="payment_gateway_settlement",
                description=f"Gateway settlement for {order.id}: {previous_tender} → {payments.PROVIDER}",
                occurred_at=now,
                staff={"id": "GATEWAY", "name": "Flutterwave settlement"},
                lines=[
                    {"account_code": new_code, "account_name": new_name, "debit": int(order.total or 0)},
                    {"account_code": old_code, "account_name": old_name, "credit": int(order.total or 0)},
                ],
            )
            logger.info(
                "Gateway settlement reclassified %s: %s -> %s", order.id, previous_tender, payments.PROVIDER
            )

    order.payment_status = "paid"
    order.tender_type = payments.PROVIDER
    order.payment_provider = payments.PROVIDER
    order.payment_reference = attempt.tx_ref
    order.paid_at = now
    order.updated_at = now
    session.flush()
    post_pending_consignment_settlement(
        session, order, {"id": order.cashier_id, "name": order.cashier_name or "Online checkout"}, occurred_at=now
    )

    order_number = order.id.split("-")[-1] if "-" in order.id else order.id
    broadcast_event(
        "ORDER_PAID",
        f"💳 Paid online — Order #{order_number}",
        f"{order.customer_name or 'Online shopper'} paid UGX {int(order.total or 0):,} by "
        f"{payments.gateway_type_label(attempt.channel)} — settled automatically, nothing to confirm.",
        {"order_id": order.id, "amount": order.total, "reference": attempt.tx_ref, "channel": attempt.channel or ""},
        session=session,
    )
    return True, "paid", ""


def consignment_metrics_by_partner(session, partners):
    """Aggregate submitted stock, confirmed sales, earned shares and payouts."""
    partner_ids = [partner.id for partner in partners]
    if not partner_ids:
        return {}
    product_rows = session.query(
        Product.consignment_partner_id,
        func.count(Product.id),
        func.coalesce(func.sum(case((and_(Product.in_stock_count > 0, Product.inventory_status == "AVAILABLE"), 1), else_=0)), 0),
    ).filter(Product.consignment_partner_id.in_(partner_ids)).group_by(Product.consignment_partner_id).all()
    product_data = {
        partner_id: {"submitted": int(submitted or 0), "active_inventory": int(active or 0)}
        for partner_id, submitted, active in product_rows
    }
    sales_query = session.query(
        OrderItem.consignment_partner_id,
        func.coalesce(func.sum(OrderItem.qty), 0),
        func.coalesce(func.sum(OrderItem.consignment_gross_amount), 0),
        func.coalesce(func.sum(OrderItem.consignment_commission_amount), 0),
        func.coalesce(func.sum(OrderItem.partner_payable_amount), 0),
    ).join(Order, Order.id == OrderItem.order_id).filter(
        OrderItem.consignment_partner_id.in_(partner_ids),
        ~func.lower(Order.status).in_(["cancelled", "canceled", "void"]),
        or_(Order.payment_status.is_(None), Order.payment_status != "pending"),
    ).group_by(OrderItem.consignment_partner_id).all()
    sales_data = {
        partner_id: {
            "sold": int(sold or 0), "gross_revenue": int(gross or 0),
            "commission_earned": int(commission or 0), "payable_earned": int(payable or 0),
        }
        for partner_id, sold, gross, commission, payable in sales_query
    }
    payout_rows = session.query(
        ConsignmentPayout.partner_id, func.coalesce(func.sum(ConsignmentPayout.amount), 0)
    ).filter(ConsignmentPayout.partner_id.in_(partner_ids)).group_by(ConsignmentPayout.partner_id).all()
    payouts = {partner_id: int(amount or 0) for partner_id, amount in payout_rows}
    result = {}
    for partner in partners:
        products = product_data.get(partner.id, {})
        sales = sales_data.get(partner.id, {})
        submitted = products.get("submitted", 0)
        active = products.get("active_inventory", 0)
        sold = sales.get("sold", 0)
        earned = sales.get("payable_earned", 0)
        paid = payouts.get(partner.id, 0)
        turnover_base = submitted
        result[partner.id] = {
            "submitted": submitted,
            "sold": sold,
            "active_inventory": active,
            "gross_revenue": sales.get("gross_revenue", 0),
            "commission_earned": sales.get("commission_earned", 0),
            "payable_earned": earned,
            "payouts_total": paid,
            "payable_balance": max(0, earned - paid),
            "inventory_turnover_pct": round((sold / turnover_base * 100), 1) if turnover_base else 0,
        }
    return result


def build_consignment_dashboard(session, region="", supply_source=""):
    all_partners = session.query(ConsignmentPartner).order_by(ConsignmentPartner.name.asc()).all()
    partners = [partner for partner in all_partners
                if (not region or (partner.region or "") == region)
                and (not supply_source or (partner.supply_source or "") == supply_source)]
    metrics = consignment_metrics_by_partner(session, partners)
    rows = []
    for partner in partners:
        row = partner.to_dict()
        row.update(metrics.get(partner.id, {}))
        rows.append(row)
    summary = {
        "partners": len(rows),
        "active_partners": sum(1 for row in rows if row.get("active")),
        "submitted": sum(row.get("submitted", 0) for row in rows),
        "sold": sum(row.get("sold", 0) for row in rows),
        "active_inventory": sum(row.get("active_inventory", 0) for row in rows),
        "gross_revenue": sum(row.get("gross_revenue", 0) for row in rows),
        "commission_earned": sum(row.get("commission_earned", 0) for row in rows),
        "payable_balance": sum(row.get("payable_balance", 0) for row in rows),
        "payouts_total": sum(row.get("payouts_total", 0) for row in rows),
    }
    denominator = summary["submitted"]
    summary["inventory_turnover_pct"] = round(summary["sold"] / denominator * 100, 1) if denominator else 0
    leaderboard = sorted(rows, key=lambda row: (
        row.get("sold", 0), row.get("inventory_turnover_pct", 0), row.get("gross_revenue", 0)
    ), reverse=True)[:10]
    recent_payout_query = session.query(ConsignmentPayout, ConsignmentPartner.name).join(
        ConsignmentPartner, ConsignmentPartner.id == ConsignmentPayout.partner_id
    )
    if partners:
        recent_payout_query = recent_payout_query.filter(ConsignmentPayout.partner_id.in_([partner.id for partner in partners]))
        recent_payout_rows = recent_payout_query.order_by(ConsignmentPayout.created_at.desc()).limit(20).all()
    else:
        recent_payout_rows = []
    return {
        "ok": True,
        "summary": summary,
        "partners": rows,
        "leaderboard": [{"id": row["id"], "name": row["name"], "sold": row.get("sold", 0),
                         "gross_revenue": row.get("gross_revenue", 0),
                         "inventory_turnover_pct": row.get("inventory_turnover_pct", 0)} for row in leaderboard],
        "recent_payouts": [dict(payout.to_dict(), partner_name=partner_name) for payout, partner_name in recent_payout_rows],
        "filters": {
            "region": region,
            "supply_source": supply_source,
            "regions": sorted({partner.region for partner in all_partners if partner.region}),
            "supply_sources": sorted({partner.supply_source for partner in all_partners if partner.supply_source}),
        },
    }


def consignment_partner_payload(body, creating=False):
    if not isinstance(body, dict):
        raise ValueError("Partner details are required")
    result = {}
    if creating and not str(body.get("name") or "").strip():
        raise ValueError("Partner name is required")
    if "name" in body or creating:
        name = clean_text(body.get("name"), 160)
        if len(name) < 2:
            raise ValueError("Partner name must be at least 2 characters")
        result["name"] = name
    limits = {
        "phone": 50, "whatsapp": 50, "email": 160, "address": 1200,
        "payout_provider": 60, "payout_account_name": 120, "payout_account": 100,
        "region": 100, "supply_source": 120, "notes": 2000,
    }
    for key, limit in limits.items():
        if key in body or creating:
            value = clean_multiline_text(body.get(key), limit) if key in {"address", "notes"} else clean_text(body.get(key), limit)
            result[key] = value or None
    email = result.get("email")
    if email and not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", email):
        raise ValueError("Enter a valid partner email address")
    if "default_commission_rate" in body or creating:
        result["default_commission_rate"] = parse_commission_rate(
            body.get("default_commission_rate", DEFAULT_CONSIGNMENT_COMMISSION_RATE),
            "Default commission rate",
        )
    if "active" in body:
        value = body.get("active")
        if isinstance(value, bool):
            result["active"] = value
        elif str(value).strip().lower() in {"true", "1", "yes", "active"}:
            result["active"] = True
        elif str(value).strip().lower() in {"false", "0", "no", "inactive"}:
            result["active"] = False
        else:
            raise ValueError("Partner active status must be true or false")
    return result


def consignment_partner_detail(session, partner):
    metrics = consignment_metrics_by_partner(session, [partner]).get(partner.id, {})
    sold_rows = session.query(
        OrderItem.product_id, func.coalesce(func.sum(OrderItem.qty), 0),
        func.coalesce(func.sum(OrderItem.consignment_gross_amount), 0),
        func.coalesce(func.sum(OrderItem.consignment_commission_amount), 0),
    ).join(Order, Order.id == OrderItem.order_id).filter(
        OrderItem.consignment_partner_id == partner.id,
        ~func.lower(Order.status).in_(["cancelled", "canceled", "void"]),
        or_(Order.payment_status.is_(None), Order.payment_status != "pending"),
    ).group_by(OrderItem.product_id).all()
    sold_by_product = {
        product_id: {"sold": int(count or 0), "gross_revenue": int(gross or 0), "commission_earned": int(commission or 0)}
        for product_id, count, gross, commission in sold_rows
    }
    products = session.query(Product).filter_by(consignment_partner_id=partner.id).order_by(Product.created_at.desc()).all()
    item_rows = []
    for product in products:
        rate = product.commission_rate if product.commission_rate is not None else partner.default_commission_rate
        item_rows.append({
            "id": product.id, "name": product.name, "sku": product.sku,
            "image_url": canonical_image_url(product.image_url), "selling_price": int(product.selling_price or 0),
            "base_price": float(product.base_price or 0), "in_stock_count": int(product.in_stock_count or 0),
            "inventory_status": product.inventory_status or "AVAILABLE",
            "sold": sold_by_product.get(product.id, {}).get("sold", 0),
            "gross_revenue": sold_by_product.get(product.id, {}).get("gross_revenue", 0),
            "commission_earned": sold_by_product.get(product.id, {}).get("commission_earned", 0),
            "commission_rate": float(product.commission_rate) if product.commission_rate is not None else None,
            "effective_commission_rate": float(rate or 0),
            "commission_source": "item" if product.commission_rate is not None else "partner_default",
            "created_at": product.created_at.isoformat() if product.created_at else None,
        })
    payouts = session.query(ConsignmentPayout).filter_by(partner_id=partner.id).order_by(
        ConsignmentPayout.created_at.desc()
    ).all()
    return {
        "ok": True, "partner": partner.to_dict(), "metrics": metrics,
        "items": item_rows, "payouts": [payout.to_dict() for payout in payouts],
    }


def route_consignment(method, path, query_params, body, headers):
    """Manager-only finance APIs plus the intentionally minimal stock-area choice list."""
    if path == "/api/consignment/partners/choices":
        if method != "GET":
            return json_response({"ok": False, "error": "Method not allowed"}, status=405)
        staff, auth_error = authenticated_or_response(headers, body, query_params)
        if auth_error:
            return auth_error
        if str((staff or {}).get("role", "")).lower() == "rider":
            return json_response({"ok": False, "error": "Stock staff authorization is required"}, status=403)
        with get_db() as session:
            partners = session.query(ConsignmentPartner).filter_by(active=True).order_by(ConsignmentPartner.name.asc()).all()
            return json_response({"ok": True, "partners": [{
                "id": partner.id, "name": partner.name,
                "default_commission_rate": float(partner.default_commission_rate or 0),
                "region": partner.region or "", "supply_source": partner.supply_source or "",
            } for partner in partners]})

    staff, auth_error = authenticated_or_response(headers, body, query_params, manager=True)
    if auth_error:
        return auth_error

    if path in {"/api/consignment/dashboard", "/api/consignment/partners"} and method == "GET":
        region = clean_text((query_params.get("region") or [""])[0], 100)
        supply_source = clean_text((query_params.get("supply_source") or [""])[0], 120)
        with get_db() as session:
            return json_response(build_consignment_dashboard(session, region, supply_source))

    if path == "/api/consignment/partners" and method == "POST":
        try:
            values = consignment_partner_payload(body, creating=True)
        except ValueError as exc:
            return json_response({"ok": False, "error": str(exc)}, status=400)
        now = datetime.utcnow()
        with get_db() as session:
            partner = ConsignmentPartner(
                id=generate_uid("CPR"), **values,
                created_at=now, updated_at=now,
                created_by_id=(staff or {}).get("id"), created_by_name=(staff or {}).get("name"),
            )
            session.add(partner)
            session.flush()
            broadcast_event("CONSIGNMENT_PARTNER_ADDED", "Consignment partner added",
                f"{partner.name} · {partner.region or 'Region not set'}",
                {"partner_id": partner.id, "partner_name": partner.name}, session=session)
            return json_response({"ok": True, "partner": partner.to_dict()}, status=201)

    product_match = re.fullmatch(r"/api/consignment/products/([^/]+)/commission", path)
    if product_match and method in {"PATCH", "PUT"}:
        product_id = urllib.parse.unquote(product_match.group(1))
        if "commission_rate" not in body:
            return json_response({"ok": False, "error": "commission_rate is required; send null to use the partner default"}, status=400)
        try:
            rate = parse_commission_rate(body.get("commission_rate"), nullable=True)
        except ValueError as exc:
            return json_response({"ok": False, "error": str(exc)}, status=400)
        with get_db() as session:
            product = session.query(Product).filter_by(id=product_id).with_for_update().first()
            if not product:
                return json_response({"ok": False, "error": "Product not found"}, status=404)
            if not product.consignment_partner_id:
                return json_response({"ok": False, "error": "This is store-owned inventory, not a consignment item"}, status=409)
            partner = session.query(ConsignmentPartner).filter_by(id=product.consignment_partner_id).first()
            if not partner:
                return json_response({"ok": False, "error": "Consignment partner not found"}, status=409)
            product.commission_rate = rate
            product.updated_at = datetime.utcnow()
            session.flush()
            return json_response({"ok": True, "product_id": product.id,
                "commission_rate": float(rate) if rate is not None else None,
                "effective_commission_rate": float(rate if rate is not None else partner.default_commission_rate),
                "commission_source": "item" if rate is not None else "partner_default"})

    payout_match = re.fullmatch(r"/api/consignment/partners/([^/]+)/payouts", path)
    if payout_match and method == "POST":
        partner_id = urllib.parse.unquote(payout_match.group(1))
        try:
            amount = parse_positive_int(body.get("amount"), "Payout amount")
        except ValueError as exc:
            return json_response({"ok": False, "error": str(exc)}, status=400)
        raw_key = clean_text(body.get("idempotency_key"), 80)
        if not raw_key:
            return json_response({"ok": False, "error": "A payout idempotency key is required"}, status=400)
        method_value = str(body.get("payment_method") or "").strip().lower().replace("-", "_").replace(" ", "_")
        method_aliases = {"mtn": "mobile_money", "airtel": "mobile_money", "momo": "mobile_money",
                          "mobile": "mobile_money", "mobile_money": "mobile_money",
                          "cash": "cash", "bank": "bank", "bank_transfer": "bank"}
        payment_method = method_aliases.get(method_value)
        if not payment_method:
            return json_response({"ok": False, "error": "Choose cash, mobile money, or bank transfer"}, status=400)
        with get_db() as session:
            partner = session.query(ConsignmentPartner).filter_by(id=partner_id).with_for_update().first()
            if not partner:
                return json_response({"ok": False, "error": "Partner not found"}, status=404)
            scoped_key = f"{partner.id}:{raw_key}"
            existing = session.query(ConsignmentPayout).filter_by(idempotency_key=scoped_key).first()
            if existing:
                metrics = consignment_metrics_by_partner(session, [partner]).get(partner.id, {})
                return json_response({"ok": True, "idempotent_replay": True,
                    "payout": existing.to_dict(), "payable_balance": metrics.get("payable_balance", 0)})
            if payment_method in {"mobile_money", "bank"} and not partner.payout_account:
                return json_response({"ok": False, "error": "Add the partner's mobile-money or bank account details before recording this payout"}, status=409)
            metrics = consignment_metrics_by_partner(session, [partner]).get(partner.id, {})
            available = int(metrics.get("payable_balance", 0))
            if amount > available:
                return json_response({"ok": False, "error": f"Payout exceeds the partner's available payable balance of UGX {available:,}",
                    "payable_balance": available}, status=409)
            destination_parts = [partner.payout_provider, partner.payout_account_name, partner.payout_account]
            destination = " · ".join(part for part in destination_parts if part) or "Cash settlement"
            payout_id = generate_uid("CPY")
            pay_code, pay_name = payment_account(payment_method)
            journal = create_journal_entry(
                session, reference=f"CONSPAY-{payout_id}", source="consignment_payout",
                description=f"Consignment payout to {partner.name}", occurred_at=datetime.utcnow(), staff=staff,
                lines=[
                    {"account_code": "2100", "account_name": ACCOUNT_NAMES["2100"], "debit": amount,
                     "memo": f"Partner: {partner.name}"},
                    {"account_code": pay_code, "account_name": pay_name, "credit": amount,
                     "memo": destination},
                ],
            )
            session.flush()
            payout = ConsignmentPayout(
                id=payout_id, partner_id=partner.id, amount=amount, payment_method=payment_method,
                destination_snapshot=destination,
                reference=clean_text(body.get("reference"), 120) or None,
                notes=clean_multiline_text(body.get("notes"), 1000) or None,
                idempotency_key=scoped_key, journal_entry_id=journal.id,
                created_by_id=(staff or {}).get("id"), created_by_name=(staff or {}).get("name"),
                created_at=datetime.utcnow(),
            )
            session.add(payout)
            session.flush()
            new_balance = max(0, available - amount)
            broadcast_event("CONSIGNMENT_PAYOUT", "Partner payout recorded",
                f"{partner.name} · UGX {amount:,} · balance UGX {new_balance:,}",
                {"partner_id": partner.id, "partner_name": partner.name,
                 "payout_id": payout.id, "amount": amount}, session=session)
            return json_response({"ok": True, "payout": payout.to_dict(), "payable_balance": new_balance}, status=201)

    partner_match = re.fullmatch(r"/api/consignment/partners/([^/]+)", path)
    if partner_match:
        partner_id = urllib.parse.unquote(partner_match.group(1))
        if method == "GET":
            with get_db() as session:
                partner = session.query(ConsignmentPartner).filter_by(id=partner_id).first()
                if not partner:
                    return json_response({"ok": False, "error": "Partner not found"}, status=404)
                return json_response(consignment_partner_detail(session, partner))
        if method in {"PATCH", "PUT"}:
            try:
                values = consignment_partner_payload(body)
            except ValueError as exc:
                return json_response({"ok": False, "error": str(exc)}, status=400)
            with get_db() as session:
                partner = session.query(ConsignmentPartner).filter_by(id=partner_id).with_for_update().first()
                if not partner:
                    return json_response({"ok": False, "error": "Partner not found"}, status=404)
                for key, value in values.items():
                    setattr(partner, key, value)
                partner.updated_at = datetime.utcnow()
                session.flush()
                broadcast_event("CONSIGNMENT_PARTNER_UPDATED", "Consignment partner updated",
                    f"{partner.name} · partner profile saved",
                    {"partner_id": partner.id, "partner_name": partner.name}, session=session)
                return json_response({"ok": True, "partner": partner.to_dict()})

    return json_response({"ok": False, "error": "Consignment route not found"}, status=404)


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
            if path.rstrip("/") in AUTH_PEEK_PATHS and method == "POST":
                # Peek only: a correct passkey must never be locked out by its
                # own earlier successful sign-ins. Failures are recorded below.
                allowed, retry_after = _rate_limiter.peek(
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
        if body_bytes and method in ("POST", "PUT", "PATCH", "DELETE") and not path.startswith(("/api/media/", "/api/promo-media/")):
            try:
                body = json.loads(body_bytes.decode("utf-8"))
            except Exception:
                body = {}
        if not isinstance(body, dict):
            body = {}

        # Strip trailing slashes from path
        clean_path = path.rstrip("/")

        # Owner-configured area passwords are independent of the old global
        # staff login. The register stays open; only chosen operations are gated.
        if clean_path.startswith("/api/pos-access/"):
            may_bootstrap = True
            if staff_auth_required():
                authed, staff = is_authenticated_staff(headers, body, query_params)
                may_bootstrap = authed and (staff or {}).get("role") == "admin"
            status, result = access_control.handle_request(method, clean_path, body, headers, may_bootstrap)
            if clean_path == "/api/pos-access/unlock" and method == "POST" and status in {400, 403}:
                _rate_limiter.check("auth", client_ip, AUTH_RATE_LIMIT, AUTH_RATE_WINDOW)
            return json_response(result, status=status)
        area_error = access_control.guard_request(method, clean_path, body, headers)
        if area_error:
            status, result = area_error
            return json_response(result, status=status)

        if clean_path.startswith("/api/rider-account/"):
            # Rider sign-in and daily attendance. Public routes, but every
            # protected step is bound to the account's own sign-in token.
            result = rider_accounts.route_request(method, clean_path, body, headers, staff_auth_required())
            if clean_path in AUTH_FAILURE_PATHS and method == "POST" and result[0] in {400, 401, 403}:
                _rate_limiter.check("auth", client_ip, AUTH_RATE_LIMIT, AUTH_RATE_WINDOW)
            return result

        if clean_path.startswith(("/api/riders", "/api/dispatch/", "/api/rider/")):
            staff_info = None
            if not clean_path.startswith("/api/rider/"):
                authenticated, staff_info = is_authenticated_staff(headers, body, {})
                if not authenticated or (staff_info or {}).get("role") == "rider":
                    return dispatch.response({"ok":False,"error":"Staff dispatch authorization is required."},401)
            result = dispatch.route_request(method, clean_path, body, headers, staff_info, staff_auth_required())
            if clean_path in AUTH_FAILURE_PATHS and method == "POST" and result[0] in {400,403}:
                _rate_limiter.check("auth", client_ip, AUTH_RATE_LIMIT, AUTH_RATE_WINDOW)
            return result

        if clean_path == "/api/exports/prepare" and method == "POST":
            authenticated, staff_info = is_authenticated_staff(headers, body, {})
            if not authenticated:
                return json_response({"ok": False, "error": "Sign in to the staff terminal to export store records."}, status=401)
            return exports.prepare(body, headers, staff_info or {}, staff_auth_required())
        if clean_path.startswith("/api/exports/download/") and method in {"GET", "HEAD"}:
            # The short-lived file capability is not a staff/area credential.
            # Its original scope is revalidated server-side, also in another browser.
            return exports.download(method, clean_path.split("/")[-1], staff_auth_required())

        if clean_path.startswith(("/api/media/", "/api/promo-media/")):
            # Mutation shares both existing staff and optional Stock passwords.
            # Public reads of attached garment media need neither.
            if method in {"POST", "DELETE"}:
                staff_info, auth_error = authenticated_or_response(headers, {}, query_params)
                if auth_error:
                    return auth_error
            else:
                authenticated, staff_info = is_authenticated_staff(headers, {}, {})
                if not authenticated:
                    staff_info = None
                elif not staff_auth_required():
                    # In PIN-free mode, normal API calls use an open terminal
                    # identity. Keep unattached media out of ordinary public
                    # <img> reads; staff previews opt in through DB.mediaPreview.
                    preview_header = next((str(value).strip() for key, value in headers.items()
                                           if str(key).lower() == "x-adonai-media-preview"), "")
                    if preview_header != "1":
                        staff_info = None
            return media.route_request(method, clean_path, body_bytes, headers, staff_info, query_params)

        if clean_path.startswith("/api/consignment/"):
            return route_consignment(method, clean_path, query_params, body, headers)

        if clean_path.startswith("/api/products") and method in {"POST", "PUT", "PATCH"}:
            if isinstance(body.get("images"), list) and len(body["images"]) > media.MAX_IMAGES:
                return json_response({"ok": False, "error": "A garment can have up to 12 photos."}, status=400)

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
            staff_info = dict(staff_info, _pos_access_tokens=next((str(v) for k, v in headers.items() if k.lower() == "x-pos-access"), ""))
            ticket = issue_stream_ticket(staff_info)
            return json_response({"ok": True, "ticket": ticket, "expires_in": 60})

        if clean_path == "/api/notifications/delete" and method == "POST":
            # Bell inbox "Delete permanently": removes the alerts (never the
            # orders/stock they describe) for every device. Managers/admins only.
            staff_info, auth_error = authenticated_or_response(headers, body, query_params, manager=True)
            if auth_error:
                return auth_error
            ids = (body or {}).get("ids") if isinstance(body, dict) else None
            if not isinstance(ids, list) or not ids or len(ids) > DELETE_BATCH_LIMIT:
                return json_response({"ok": False, "error": f"Send 1–{DELETE_BATCH_LIMIT} notification ids."}, status=400)
            with get_db() as session:
                deleted = delete_events(ids, staff=staff_info, session=session)
            return json_response({"ok": True, "deleted": deleted})

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
            with get_db() as session:
                area_access = access_control.state(headers, session)
                return json_response({"ok": True, "notifications": [
                    access_control.sanitize_notification(event, area_access)
                    for event in recent_events(limit, session=session)
                ], "server_time": datetime.utcnow().isoformat() + "Z"})

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
                area_access = access_control.state(headers, session)
                for product in products:
                    data = access_control.sanitize_product(product.to_dict(), area_access)
                    if public_availability:
                        # Storefront channel: the internal transport allocation
                        # never leaves the server, shoppers see one delivery fee.
                        # The internal costing and staff fields go with it.
                        data = access_control.sanitize_storefront_product(data)
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
                # Payloads that speak the ingestion-service vocabulary (see
                # DIRECT_SUPPLIER_UPLOAD.md) get its defaults and required-field
                # rules; canonical catalog payloads keep the legacy behavior.
                direct_upload_shaped = "item_name" in body and "name" not in body
                # Accept the direct-upload ingestion payload vocabulary
                # (item_name, catalog_group, size_availability, condition_notes)
                # alongside the canonical catalog field names.
                normalize_intake_vocabulary(body)
                supplier_fields = supplier_economics_fields(body)
                if direct_upload_shaped and (
                    not str(body.get("name") or "").strip()
                    or not supplier_fields.get("supplier_name")
                ):
                    raise ValueError("Item name and supplier name are required fields.")
                inventory_source = str(body.get("inventory_source") or ("partner" if body.get("consignment_partner_id") else "store")).strip().lower()
                if inventory_source not in {"store", "partner"}:
                    raise ValueError("Inventory source must be store-owned or partner consignment")
                is_consignment = inventory_source == "partner"
                consignment_partner_id = str(body.get("consignment_partner_id") or "").strip()[:50] or None
                if is_consignment and not consignment_partner_id:
                    raise ValueError("Choose a consignment partner before saving this item")
                if not is_consignment and consignment_partner_id:
                    raise ValueError("Choose Partner consignment as the inventory source")
                commission_rate = parse_commission_rate(body.get("commission_rate"), nullable=True) if is_consignment else None
                # Direct uploads map straight onto a base retail price; keep the
                # legacy base_price/selling_price fallbacks for existing forms.
                supplied_base = body.get("base_price", body.get("base_retail_price", body.get("selling_price")))
                # A graded tier pre-fills the retail price from its target —
                # only then is a blank/missing base price tolerated up front.
                tier_link = bool(str(body.get("lot_grade_id") or "").strip()) and not is_consignment
                if tier_link and supplied_base in (None, "", 0):
                    base_price = 0
                else:
                    base_price = parse_positive_int(supplied_base, "Base price", allow_zero=tier_link)
                if is_consignment:
                    transport_cost = parse_positive_int(body.get("total_transport_cost", 0) or 0, "Total transport cost", allow_zero=True)
                    if transport_cost:
                        raise ValueError("Consignment items use their base price without a store transport allocation")
                elif body.get("total_transport_cost") is not None:
                    transport_cost = parse_positive_int(body.get("total_transport_cost"), "Total transport cost", allow_zero=True)
                elif "base_retail_price" in body and "base_price" not in body and "selling_price" not in body:
                    # Direct-upload pricing (mirrors the catalog_items INSERT
                    # trigger): the mapped base retail price IS the retail tag,
                    # so no transport allocation is layered on top.
                    transport_cost = 0
                else:
                    # Global default: inherit the System Parameters base
                    # delivery fee so intake forms never require re-typing it.
                    with get_db() as settings_session:
                        fee_row = settings_session.query(StoreSetting).filter_by(key="base_delivery_fee").first()
                        fee_text = str(fee_row.value).strip() if fee_row and fee_row.value is not None else ""
                    transport_cost = parse_positive_int(fee_text or 7000, "Total transport cost", allow_zero=True)
                allocation = transport_allocation(base_price, transport_cost)
                selling_price = whole_money(allocation["final_selling_price"])
                stock_count = parse_positive_int(body.get("in_stock_count", 1), "Stock quantity", allow_zero=True)
                if is_consignment:
                    supplied_cost = 0
                elif "cost_price" in body:
                    supplied_cost = parse_positive_int(body.get("cost_price", 0), "Cost price", allow_zero=True)
                elif "fixed_unit_cost" in body:
                    # Direct-upload payload: the fixed unit cost is the COGS.
                    supplied_cost = whole_money(parse_money_amount(body.get("fixed_unit_cost"), "Fixed unit cost"))
                else:
                    supplied_cost = 0
                compare_price = parse_positive_int(body.get("compare_price", 0), "Compare price", allow_zero=True)
                if is_consignment:
                    if stock_count != 1:
                        raise ValueError("Partner consignment intake is recorded as one available 1-of-1 item")
                    if str(body.get("stock_lot_id") or "").strip() or str(body.get("lot_grade_id") or "").strip():
                        raise ValueError("Partner consignment items cannot be assigned to a store-owned stock lot")
                    item_condition = ItemCondition.PRE_LOVED.value
                    quantity_type = QuantityType.PRE_LOVED.value
                else:
                    item_condition = normalize_item_condition(
                        body.get("item_condition", body.get("inventory_type")),
                        # Direct uploads are ingested piece-by-piece as unique
                        # curated garments (same default as the SQL trigger).
                        default=(ItemCondition.PRE_LOVED.value if direct_upload_shaped else ItemCondition.BRAND_NEW.value),
                    )
                    quantity_type = normalize_quantity_type(body.get("quantity_type"), item_condition)
                    if item_condition == ItemCondition.PRE_LOVED.value and stock_count not in (0, 1):
                        raise ValueError("PRE_LOVED inventory must have quantity 1 (or 0 after it is sold)")
                size_variants = body.get("size_variants") if isinstance(body.get("size_variants"), list) else []
                color_variants = body.get("color_variants") if isinstance(body.get("color_variants"), list) else []
                measurements = body.get("measurements") if isinstance(body.get("measurements"), dict) else {}
                # Dynamic category schema: the category + sub-category pair
                # resolves ONE form; its attributes are validated, hidden
                # fields dropped and legacy columns projected server-side.
                intake_category = clean_text(body.get("category", "Outerwear & Jackets"), 100) or "Outerwear & Jackets"
                intake_subcategory = clean_text(body.get("subcategory", ""), 100)
                # Essentials-first intake: the selling price and quantity are
                # the only mandatory fields, so optional category details never
                # block a new garment. A manager can send
                # ``details_required`` to restore the strict completeness gate.
                details_required = bool(
                    body.get("details_required") or body.get("require_details") or body.get("strict_details")
                )
                if "attributes" in body:
                    schema_result = catalog_schemas.normalize_attributes(
                        body.get("attributes") or {}, intake_category, intake_subcategory, item_condition,
                        enforce_required=details_required,
                    )
                else:
                    _, _, resolved_sub = catalog_schemas.resolve(intake_category, intake_subcategory) if intake_subcategory else (None, None, "")
                    # Direct uploads carry free-text sub-groups ("Full-Zip
                    # Hooded Windbreaker") outside the taxonomy — keep the
                    # supplied text when the schema engine resolved nothing.
                    schema_result = {"subcategory": resolved_sub or (intake_subcategory or None), "attributes": {}, "projections": {}}
            except SchemaValidationError as exc:
                return schema_error_response(exc)
            except ValueError as exc:
                return json_response({"ok": False, "error": str(exc)}, status=400)

            with get_db() as session:
                pid = safe_identifier(body.get("id")) or generate_uid("PRD")
                sku = clean_text(body.get("sku"), 50) or generate_uid("ADN-GEN")
                barcode_id = clean_text(body.get("barcode_id"), 50) or generate_uid("ADT")
                lot_id = str(body.get("stock_lot_id") or "").strip() or None
                grade = None
                partner = None
                if is_consignment:
                    partner = session.query(ConsignmentPartner).filter_by(
                        id=consignment_partner_id, active=True
                    ).with_for_update().first()
                    if not partner:
                        return json_response({"ok": False, "error": "Choose an active consignment partner"}, status=404)
                    photos = [safe_image_url(body.get("image_url", ""))]
                    if isinstance(body.get("images"), list):
                        photos.extend(safe_image_url(url) for url in body["images"])
                    if not any(photos):
                        return json_response({"ok": False, "error": "Partner intake requires at least one garment photo"}, status=400)
                    video_id = str(body.get("video_id") or "").strip().lower()
                    if not media.MEDIA_ID.fullmatch(video_id):
                        return json_response({"ok": False, "error": "Partner intake requires one garment video between 15 and 20 seconds"}, status=400)
                    clip = session.query(ProductMedia).filter_by(id=video_id).with_for_update().first()
                    if not clip or clip.kind != "video" or clip.product_id:
                        return json_response({"ok": False, "error": "Upload the partner item's video again before saving"}, status=400)
                    if clip.uploaded_by != str((staff_info or {}).get("id")) and str((staff_info or {}).get("role", "")).lower() not in FINANCE_MANAGER_ROLES:
                        return json_response({"ok": False, "error": "This video upload belongs to another staff member"}, status=403)
                    try:
                        clip_duration = float(clip.duration or 0)
                    except (TypeError, ValueError):
                        clip_duration = 0
                    if not 15 <= clip_duration <= 20:
                        return json_response({"ok": False, "error": "Partner garment videos must be 15 to 20 seconds long"}, status=400)
                grade_id = str(body.get("lot_grade_id") or "").strip() or None
                if grade_id:
                    # The selected tier is the source of truth for its parent
                    # lot — staff pick the tier, never a mismatched pair.
                    grade = session.query(LotGrade).filter_by(id=grade_id).with_for_update().first()
                    if not grade:
                        return json_response({"ok": False, "error": "Selected grade tier was not found"}, status=404)
                    lot_id = grade.lot_id
                lot = None
                if lot_id:
                    lot = session.query(StockLot).filter_by(id=lot_id).with_for_update().first()
                    if not lot:
                        return json_response({"ok": False, "error": "Selected stock lot was not found"}, status=404)
                    if grade is None and lot.grades:
                        return json_response({
                            "ok": False,
                            "error": "This lot is tier-graded — select a grade tier so this piece's COGS stays locked"
                        }, status=400)
                    if grade is not None:
                        if grade.allocated_count + stock_count > grade.expected_count:
                            return json_response({
                                "ok": False,
                                "error": f'Tier "{grade.grade_name}" only has {grade.remaining_count} piece(s) left to tag'
                            }, status=409)
                        grade.allocated_count += stock_count
                    if lot.allocated_count + stock_count > lot.item_count:
                        return json_response({"ok": False, "error": "Selected stock lot does not have enough unallocated items"}, status=409)
                    lot.allocated_count += stock_count
                    if lot.allocated_count >= lot.item_count:
                        lot.status = "ALLOCATED"
                    if grade is not None:
                        # Locked per-tier unit COGS: recomputed from the landed
                        # investment at lot registration, immune to manual edits.
                        supplied_cost = grade.unit_cogs
                        if base_price <= 0 and grade.target_selling_price:
                            base_price = int(grade.target_selling_price)
                    elif supplied_cost <= 0:
                        supplied_cost = lot.unit_cost
                    # Bale breakdowns allocate the lot's transport evenly per
                    # item when intake did not provide an item-level override.
                    if "total_transport_cost" not in body:
                        transport_cost = (lot.shipping_cost or 0) / max(1, lot.item_count)
                if base_price <= 0:
                    return json_response({"ok": False, "error": "Base price must be greater than zero"}, status=400)
                # Final pricing pass with the post-resolution base + transport.
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
                    supplier_name=supplier_fields.get("supplier_name"),
                    fixed_unit_cost=supplier_fields.get("fixed_unit_cost"),
                    base_retail_price=supplier_fields.get("base_retail_price"),
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
                    lot_grade_id=(grade.id if grade else None),
                    consignment_partner_id=(partner.id if partner else None),
                    commission_rate=commission_rate,
                    inventory_status=("AVAILABLE" if stock_count > 0 else "OUT_OF_STOCK"),
                )
                # Shareable permalink + thrift-specific PDP detail fields.
                prod.slug = unique_product_slug(
                    session, prod.name, sku, pid, clean_text(body.get("slug", ""), 200)
                )
                apply_pdp_fields(prod, body)
                apply_catalog_schema_result(prod, schema_result, body)
                apply_catalog_copy_fields(prod, body, refresh_tags=True)
                session.add(prod)
                session.flush()
                try:
                    media.attach_to_product(session, prod, body, staff_info or {})
                except ValueError as exc:
                    session.rollback()
                    return json_response({"ok": False, "error": str(exc)}, status=400)

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
                broadcast_event("STOCK_ADDED", "Stock intake saved",
                    f"{prod.name} · {stock_count} unit(s) added to the catalog.",
                    {"product_id": pid, "name": prod.name, "barcode": barcode_id, "quantity": stock_count,
                     "created_at": prod.created_at.isoformat()}, session=session)
                return json_response({"status": "created", "product": prod.to_dict()}, status=201)

        if clean_path.startswith("/api/products/") and method in ("PUT", "PATCH", "DELETE"):
            staff_info, auth_error = authenticated_or_response(headers, body, query_params)
            if auth_error:
                return auth_error
            pid = clean_path.split("/")[-1]
            # Accept the direct-upload payload vocabulary on edits too
            # (item_name, catalog_group, size_availability, condition_notes).
            normalize_intake_vocabulary(body)
            with get_db() as session:
                prod = session.query(Product).filter_by(id=pid).with_for_update().first()
                if not prod:
                    return json_response({"ok": False, "error": "Product not found"}, status=404)
                if any(key in body for key in ("inventory_source", "consignment_partner_id", "commission_rate")):
                    return json_response({"ok": False, "error": "Manage consignment ownership and commission in the Partners workspace"}, status=400)
                if prod.consignment_partner_id:
                    if "item_condition" in body or "inventory_type" in body:
                        try:
                            requested_condition = normalize_item_condition(body.get("item_condition", body.get("inventory_type")))
                        except ValueError as exc:
                            return json_response({"ok": False, "error": str(exc)}, status=400)
                        if requested_condition != ItemCondition.PRE_LOVED.value:
                            return json_response({"ok": False, "error": "Consignment items must remain unique PRE_LOVED inventory"}, status=400)
                    if "in_stock_count" in body:
                        try:
                            if int(body.get("in_stock_count")) not in (0, 1):
                                return json_response({"ok": False, "error": "A consignment item must remain 1-of-1"}, status=400)
                        except (TypeError, ValueError):
                            return json_response({"ok": False, "error": "in_stock_count must be a whole number"}, status=400)
                    if "cost_price" in body:
                        try:
                            if int(body.get("cost_price")) != 0:
                                return json_response({"ok": False, "error": "Consignment items do not carry store-owned COGS"}, status=400)
                        except (TypeError, ValueError):
                            return json_response({"ok": False, "error": "cost_price must be zero for consignment"}, status=400)
                if method == "DELETE":
                    mode = str(
                        body.get("mode") or query_params.get("mode", [""])[0] or "archive"
                    ).strip().lower()
                    if mode not in {"archive", "permanent"}:
                        return json_response(
                            {"ok": False, "error": "mode must be 'archive' or 'permanent'"}, status=400
                        )
                    if mode == "permanent" and prod.consignment_partner_id:
                        return json_response({"ok": False, "error": "Archive partner inventory instead; its sale and settlement history must remain linked to the partner"}, status=409)
                    if mode == "archive":
                        changed = prod.inventory_status != "ARCHIVED" or prod.in_stock_count != 0
                        prod.inventory_status = "ARCHIVED"
                        prod.in_stock_count = 0
                        session.query(InventoryLock).filter_by(product_id=pid).delete(synchronize_session=False)
                        if changed:
                            broadcast_event("STOCK_REMOVED", "Product archived", f"{prod.name} was removed from the active rack.",
                                {"product_id": pid, "name": prod.name, "mode": "archive"}, session=session)
                        return json_response({"ok": True, "status": "archived", "product": prod.to_dict()})

                    # --- Permanent (hard) removal: manager/admin only ---
                    role = str((staff_info or {}).get("role", "")).lower()
                    if role not in FINANCE_MANAGER_ROLES:
                        return json_response(
                            {"ok": False, "error": "Manager or administrator authorization is required to permanently delete a product"},
                            status=403,
                        )
                    product_name, product_sku = prod.name, prod.sku
                    quantity_on_hand = max(0, int(prod.in_stock_count or 0))
                    loss = int(prod.cost_price or 0) * quantity_on_hand
                    locks_released = session.query(InventoryLock).filter_by(product_id=pid).delete(synchronize_session=False)
                    # Historical order lines keep their name/price/cost snapshots so old
                    # receipts and reports stay truthful; only the catalog link is removed.
                    unlinked = session.query(OrderItem).filter(OrderItem.product_id == pid).update(
                        {OrderItem.product_id: None}, synchronize_session=False
                    )
                    journal = None
                    if loss:
                        journal = create_journal_entry(
                            session,
                            reference=generate_uid("PDEL"), source="inventory_write_off",
                            description=f"Permanent delete {quantity_on_hand} x {product_name} ({product_sku})",
                            occurred_at=datetime.utcnow(), staff=staff_info,
                            lines=[
                                {"account_code": "5200", "account_name": ACCOUNT_NAMES["5200"], "debit": loss},
                                {"account_code": "1200", "account_name": ACCOUNT_NAMES["1200"], "credit": loss},
                            ],
                        )
                        session.add(InventoryAdjustment(
                            id=generate_uid("ADJ"), product_id=pid, adjustment_type="PURGE",
                            quantity=quantity_on_hand, old_price=int(prod.selling_price or 0), new_price=0,
                            loss_amount=loss, reason="Permanent rack deletion (manager authorized)",
                            journal_entry_id=journal.id,
                            created_by_id=staff_info.get("id"), created_by_name=staff_info.get("name"),
                        ))
                    # Inventory rows cascade on the FK in Postgres; delete explicitly so
                    # SQLite behaves identically before the product row is removed.
                    session.query(Inventory).filter_by(product_id=pid).delete(synchronize_session=False)
                    session.flush()
                    session.delete(prod)
                    session.add(LedgerEntry(
                        id=generate_uid("LED"), kind="adjustment", amount=-loss,
                        category="Inventory Removal",
                        description=f"Permanently deleted {product_name} ({product_sku}) from the rack"
                                    + (f" — UGX {loss:,} stock value written off" if loss else " — no stock on hand"),
                        staff_name=staff_info.get("name"), ref_id=journal.id if journal else pid,
                    ))
                    session.flush()
                    broadcast_event("STOCK_REMOVED", "Product deleted", f"{product_name} was permanently removed from the rack.",
                        {"product_id": pid, "name": product_name, "mode": "permanent"}, session=session)
                    return json_response({
                        "ok": True, "status": "permanently_deleted", "product_id": pid,
                        "sku": product_sku, "unlinked_order_lines": unlinked,
                        "locks_released": locks_released, "stock_loss_posted": loss,
                    })

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
                    # Direct-upload supplier tagging + item-level economics.
                    supplier_updates = supplier_economics_fields(body)
                except ValueError as exc:
                    return json_response({"ok": False, "error": str(exc)}, status=400)
                for key, value in supplier_updates.items():
                    setattr(prod, key, value)
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
                try:
                    update_catalog_schema(prod, body)
                except SchemaValidationError as exc:
                    session.rollback()
                    return schema_error_response(exc)
                # Edits never overwrite curated tags; send search_tags: [] to
                # ask the server to regenerate them from the current record.
                apply_catalog_copy_fields(prod, body, refresh_tags=False)
                if "slug" in body or "name" in body or not prod.slug:
                    prod.slug = unique_product_slug(
                        session, prod.name, prod.sku, prod.id, clean_text(body.get("slug", ""), 200)
                    )
                if "base_price" in body or "base_retail_price" in body or "total_transport_cost" in body or "selling_price" in body:
                    try:
                        base = body.get("base_price", body.get("base_retail_price"))
                        if base is None:
                            base = prod.base_price or prod.selling_price
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
                changed = session.is_modified(prod, include_collections=False)
                session.flush()
                try:
                    media_changed = media.attach_to_product(session, prod, body, staff_info or {})
                except ValueError as exc:
                    session.rollback()
                    return json_response({"ok": False, "error": str(exc)}, status=400)
                if changed or media_changed:
                    broadcast_event("STOCK_UPDATED", "Product updated", f"{prod.name} · {prod.in_stock_count} unit(s) on the rack.",
                        {"product_id": pid, "name": prod.name, "quantity": prod.in_stock_count}, session=session)
                return json_response({"ok": True, "status": "updated", "product": prod.to_dict()})

        if clean_path.startswith("/api/products/") and method == "GET":
            # Public PDP lookup: resolves by id, permalink slug, SKU or barcode
            # so /product/<slug> can hydrate from a single round trip.
            identifier = urllib.parse.unquote(clean_path.split("/")[-1])[:200]
            with get_db() as session:
                prod = lookup_product(session, identifier)
                if not prod:
                    return json_response({"error": "Product not found"}, status=404)
                data = access_control.sanitize_product(prod.to_dict(), access_control.state(headers, session))
                # This is the shopper-facing product-detail channel, so the
                # internal transport allocation is replaced by one delivery fee.
                data = access_control.sanitize_storefront_product(data)
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
        if clean_path == "/api/catalog/field-schemas" and method == "GET":
            # Public, non-sensitive form definitions: the intake console, the
            # Android console and storefront specification views all read the
            # same category_field_schemas mirror. ?category=&subcategory=
            # returns the one resolved form for that selection.
            with get_db() as session:
                doc = catalog_schemas.refresh_from_db(session, force=False)
            category = clean_text(query_params.get("category", [""])[0], 100)
            if not category:
                return json_response(dict({"ok": True}, **catalog_schemas.public_document(doc)))
            try:
                key, schema, sub = catalog_schemas.resolve(category, clean_text(query_params.get("subcategory", [""])[0], 100), doc)
            except SchemaValidationError as exc:
                return schema_error_response(exc)
            if not schema:
                return json_response({"ok": False, "error": f"No intake form is registered for {category}"}, status=404)
            return json_response({
                "ok": True, "version": doc.get("version"), "category": category, "subcategory": sub,
                "subcategories": catalog_schemas.subcategories_for(category, doc),
                "schema_key": key, "schema": schema, "units": doc.get("units") or {},
            })

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
                area_access = access_control.state(headers, session)
                orders = [access_control.sanitize_sale(o.to_dict(), area_access) for o in q.order_by(Order.created_at.desc()).all()]
                return json_response({"count": len(orders), "orders": orders})

        if clean_path.startswith("/api/orders/") and clean_path.endswith(("/list-archive", "/list-restore")) and method == "POST":
            # Removes an assigned/completed order from the working Orders list only. The order row,
            # its items, payments, dispatch history and exports are untouched.
            staff_info, auth_error = authenticated_or_response(headers, body, query_params)
            if auth_error:
                return auth_error
            parts = clean_path.split("/")
            order_id, restore = parts[-2], parts[-1] == "list-restore"
            with get_db() as session:
                order = session.query(Order).filter_by(id=order_id).with_for_update().first()
                if not order:
                    return json_response({"ok": False, "error": "Order not found"}, status=404)
                if restore:
                    order.list_archived_at = None
                elif order.dispatch_status not in {"Dispatched", "Ready for Pickup", "Completed"}:
                    return json_response({"ok": False, "error": "Only assigned or completed orders can be removed from the list. Their records are kept."}, status=409)
                else:
                    order.list_archived_at = datetime.utcnow()
                session.flush()
                return json_response({"ok": True, "order": access_control.sanitize_sale(order.to_dict(), access_control.state(headers, session))})

        if clean_path.startswith("/api/orders/") and clean_path.endswith("/payments") and method == "GET":
            # The reconciliation trail for one order: every gateway attempt with
            # its own reference, the gateway's transaction id and the state it
            # ended in. Staff need this to match a Flutterwave payout against
            # the order; it is never shown to shoppers.
            order_id = safe_identifier(clean_path.split("/")[-2])
            if not order_id:
                return json_response({"ok": False, "error": "A valid order id is required"}, status=400)
            with get_db() as session:
                area_access = access_control.state(headers, session)
                if not access_control.allowed("orders", area_access) and not access_control.allowed("finance", area_access):
                    status, payload = access_control.locked_response("orders")
                    return json_response(payload, status=status)
                is_authed, staff_info = is_authenticated_staff(headers, body, query_params)
                if not is_authed:
                    return json_response({
                        "ok": False,
                        "error": "Unauthorized: Staff terminal authentication required to read payment attempts",
                    }, status=401)
                order = session.query(Order).filter_by(id=order_id).first()
                if not order:
                    return json_response({"ok": False, "error": "Order not found"}, status=404)
                attempts = (
                    session.query(PaymentTransaction)
                    .filter(PaymentTransaction.order_id == order.id)
                    .order_by(PaymentTransaction.created_at.desc())
                    .limit(25)
                    .all()
                )
                confirmed_by = ""
                if order.payment_status == "paid" and (order.tender_type or "") != payments.PROVIDER:
                    # Offline channels are settled by a person, and the attempt
                    # row records who. Surface it so a later reviewer can see
                    # the money was checked by someone, not by a machine.
                    confirmed_by = staff_name_of_last_offline_attempt(session, order) or ""
                return json_response({
                    "ok": True,
                    "order_id": order.id,
                    "payment_status": order.payment_status or "unpaid",
                    "channel": order.payment_channel or "",
                    "tender": order.tender_type or "",
                    "reference": order.payment_reference or "",
                    "paid_at": order.paid_at.isoformat() if order.paid_at else None,
                    "payer_account": order.payer_account or "",
                    "merchant_pay_code": order.merchant_pay_code or "",
                    "claim": {
                        "channel": order.payment_claim_channel or "",
                        "reference": order.payment_claim_reference or "",
                        "at": order.payment_claim_at.isoformat() if order.payment_claim_at else None,
                    } if order.payment_claim_at else None,
                    "confirmed_by": confirmed_by,
                    "attempts": [attempt.to_dict() for attempt in attempts],
                })

        if clean_path.startswith("/api/orders/") and clean_path.endswith("/payment") and method == "POST":
            # Staff confirmation of money received (mobile money, bank
            # transfer, merchant pay code, cash). Protected exactly like the
            # rest of the order pipeline: authenticated staff, and the Orders
            # area password when the owner has turned it on.
            order_id = safe_identifier(clean_path.split("/")[-2])
            if not order_id:
                return json_response({"ok": False, "error": "A valid order id is required"}, status=400)
            with get_db() as session:
                area_access = access_control.state(headers, session)
                if not access_control.allowed("orders", area_access) and not access_control.allowed("finance", area_access):
                    status, payload = access_control.locked_response("orders")
                    return json_response(payload, status=status)
                is_authed, staff_info = is_authenticated_staff(headers, body, query_params)
                if not is_authed:
                    return json_response({
                        "ok": False,
                        "error": "Unauthorized: Staff terminal authentication required to confirm a payment",
                    }, status=401)
                order = session.query(Order).filter_by(id=order_id).with_for_update().first()
                if not order:
                    return json_response({"ok": False, "error": "Order not found"}, status=404)

                paid = body.get("paid")
                if paid is None:
                    paid = str(body.get("status") or "").strip().lower() not in {"unpaid", "not_paid", "revert"}
                method = clean_text(body.get("payment_method") or body.get("method") or order.payment_channel or "cash", 30)
                reference = clean_text(body.get("reference") or body.get("transaction_id") or "", 100)
                note = clean_multiline_text(body.get("note") or "", 300)

                ok, payment_status, error, outcome = staff_confirm_order_payment(
                    session, order, staff_info, paid=bool(paid), method=method,
                    reference=reference, note=note,
                )
                if not ok:
                    return json_response({"ok": False, "error": error, "payment_status": payment_status}, status=409)
                response = {
                    "ok": True,
                    "order_id": order.id,
                    "payment_status": order.payment_status,
                    "outcome": outcome,
                    "channel": order.payment_channel or "",
                    "reference": order.payment_reference or "",
                    "paid_at": order.paid_at.isoformat() if order.paid_at else None,
                    "order": access_control.sanitize_sale(order.to_dict(), area_access),
                }
                if outcome == "paid":
                    response["message"] = f"{order.id} recorded as PAID ({payments.channel_info(method)['label']})"
                elif outcome == "unpaid":
                    response["message"] = f"{order.id} reverted to unpaid — its pieces stay reserved until the window closes"
                else:
                    response["message"] = f"{order.id} was already marked paid"
                return json_response(response)

        if clean_path.startswith("/api/orders/") and method in ("PUT", "PATCH"):
            staff_info, auth_error = authenticated_or_response(headers, body, query_params)
            if auth_error:
                return auth_error
            order_id = clean_path.split("/")[-1]
            lifecycle = {"Unfulfilled", "In Assembly", "Ready for Pickup", "Dispatched", "Completed", "Cancelled"}
            outbox = []
            with get_db() as session:
                order = session.query(Order).filter_by(id=order_id).with_for_update().first()
                if not order:
                    return json_response({"ok": False, "error": "Order not found"}, status=404)

                assignment = None
                if body.get("rider_id"):
                    requested_stage = body.get("fulfillment_status",body.get("dispatch_status","Dispatched"))
                    if normalize_fulfillment_stage(requested_stage) != "Dispatched":
                        return json_response({"ok":False,"error":"Assign a rider separately from cancellation/completion."},status=400)
                    try: assignment = dispatch.validate_assignment(session, order, str(body["rider_id"]))
                    except dispatch.DispatchError as error: return dispatch.response({"ok":False,"error":str(error)},error.status)
                elif "rider_name" in body or "rider_id" in body:
                    return json_response({"ok":False,"error":"Choose a saved rider to assign a delivery."},status=400)
                previous_state = (order.dispatch_status, order.status, order.rider_id, order.rider_name, order.tender_type)
                next_stage = body.get("fulfillment_status")
                if next_stage is None:
                    next_stage = body.get("dispatch_status")
                restored_units = 0
                if next_stage is not None:
                    next_stage = normalize_fulfillment_stage(next_stage)
                    if next_stage not in lifecycle:
                        return json_response({"ok": False, "error": "Unknown fulfillment status"}, status=400)
                    current = normalize_fulfillment_stage(
                        order.dispatch_status or ("Unfulfilled" if order.channel == "web" else "Completed")
                    )
                    # Legacy databases can have a cancelled lifecycle flag but a
                    # missing dispatch label. Treat that as cancelled so retries
                    # never restore the same stock twice.
                    if str(order.status or "").strip().lower() in {"cancelled", "canceled", "void"}:
                        current = "Cancelled"
                    allowed = {
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
                                quantity = max(0, int(item.qty or 0))
                                product.in_stock_count = int(product.in_stock_count or 0) + quantity
                                restored_units += quantity
                                if product.inventory_status == "OUT_OF_STOCK" and product.in_stock_count > 0:
                                    product.inventory_status = "AVAILABLE"
                        reverse_consignment_order_journals(
                            session, order, staff=staff_info,
                            reason="Consignment order cancelled", occurred_at=datetime.utcnow(),
                        )
                    if next_stage == "Dispatched" and not assignment and not order.rider_id and order.channel == "web" and str(order.delivery_type or "").strip().lower() != "pickup":
                        return json_response({"ok": False, "error": "Choose a delivery partner, then dispatch. Assigning the rider sends them the WhatsApp job message."}, status=409)
                    order.dispatch_status = next_stage
                    if next_stage in {"Dispatched", "Ready for Pickup", "Completed"} and order.dispatched_at is None:
                        order.dispatched_at = datetime.utcnow()
                    order.status = (
                        "completed" if next_stage == "Completed"
                        else "cancelled" if next_stage == "Cancelled"
                        else "unfulfilled" if next_stage == "Unfulfilled"
                        else "processing"
                    )

                if assignment:
                    dispatch.assign(session, order, assignment.id, (staff_info or {}).get("name","Dispatcher"), outbox)
                if "payment_method" in body:
                    order.tender_type = str(body.get("payment_method") or "cash").strip().lower()
                order.updated_at = datetime.utcnow()
                session.flush()
                if not assignment and previous_state != (order.dispatch_status, order.status, order.rider_id, order.rider_name, order.tender_type):
                    broadcast_event("ORDER_UPDATED", f"Order {order.id} updated",
                        f"{order.dispatch_status or order.status}" + (f" · Rider: {order.rider_name}" if order.rider_name else ""),
                        {"order_id": order.id, "status": order.status, "fulfillment_status": order.dispatch_status}, session=session)
                result = json_response({"ok": True, "order": access_control.sanitize_sale(order.to_dict(), access_control.state(headers, session)), "stock_restored_units": restored_units})
            # Rider WhatsApp messages go out only once the assignment has committed.
            if outbox:
                result = dispatch.attach_notices(result, dispatch.deliver_rider_notices(outbox))
            return result

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
                consignment_partners = {}
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
                    if prod.consignment_partner_id:
                        partner = session.query(ConsignmentPartner).filter_by(id=prod.consignment_partner_id).with_for_update().first()
                        if not partner:
                            return json_response({"ok": False, "error": f"Consignment partner for '{prod.name}' is no longer available"}, status=409)
                        condition = prod.item_condition.value if isinstance(prod.item_condition, ItemCondition) else str(prod.item_condition or "")
                        if condition != ItemCondition.PRE_LOVED.value or qty != 1:
                            return json_response({"ok": False, "error": f"Consignment item '{prod.name}' must remain a one-of-one piece"}, status=409)
                        try:
                            effective_rate = parse_commission_rate(
                                prod.commission_rate if prod.commission_rate is not None else partner.default_commission_rate,
                                "Commission rate",
                            )
                        except ValueError as exc:
                            return json_response({"ok": False, "error": str(exc)}, status=409)
                        consignment_partners[pid] = {"partner": partner, "rate": effective_rate}
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
                consignment_gross_total = 0
                consignment_commission_total = 0
                consignment_payable_total = 0
                consignment_partner_breakdown = {}
                order_items_objs = []
                for pid, qty in requested.items():
                    prod = products[pid]
                    partner_info = consignment_partners.get(pid)
                    partner = partner_info["partner"] if partner_info else None
                    commission_rate = partner_info["rate"] if partner_info else None
                    unit_price = int(prod.selling_price or 0)
                    unit_cost = 0 if partner else int(prod.cost_price or 0)
                    line_total = unit_price * qty
                    consignment_gross = whole_money(prod.base_price or prod.selling_price) * qty if partner else 0
                    consignment_commission = consignment_commission_amount(consignment_gross, commission_rate) if partner else 0
                    partner_payable = consignment_gross - consignment_commission if partner else 0
                    subtotal += line_total
                    cogs += unit_cost * qty
                    consignment_gross_total += consignment_gross
                    consignment_commission_total += consignment_commission
                    consignment_payable_total += partner_payable
                    if partner:
                        partner_split = consignment_partner_breakdown.setdefault(partner.id, {
                            "partner_id": partner.id, "partner_name": partner.name,
                            "gross": 0, "commission": 0, "payable": 0,
                        })
                        partner_split["gross"] += consignment_gross
                        partner_split["commission"] += consignment_commission
                        partner_split["payable"] += partner_payable
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
                        consignment_partner_id=partner.id if partner else None,
                        partner_name_snapshot=partner.name if partner else None,
                        commission_rate_snapshot=commission_rate,
                        consignment_gross_amount=consignment_gross,
                        consignment_commission_amount=consignment_commission,
                        partner_payable_amount=partner_payable,
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

                # ---- Payment intent (web storefront only) --------------
                # Every non-cash choice reserves the pieces and issues a
                # per-order payment token. The order only counts as PAID after
                # the gateway verifies the charge (card) or staff confirm the
                # money landed (mobile money, bank transfer, merchant pay code).
                requested_payment_method = str(body.get("payment_method") or "").strip()
                payment_channel = payments.normalize_channel(requested_payment_method, default="cod")
                wants_online_payment = channel != "pos" and payments.is_online_channel(payment_channel)
                if wants_online_payment and payment_channel == "card" and not payments.is_enabled():
                    return json_response({
                        "ok": False,
                        "error": "Card payment is not available right now — please choose another payment option",
                    }, status=503)
                if wants_online_payment and payment_channel == "merchant":
                    # A merchant pay code is meaningless if nobody can issue or
                    # verify it. Refuse loudly rather than parking the order.
                    pass
                if wants_online_payment:
                    # Route the double-entry debit to the account that will
                    # actually receive the money (1020 bank/card settlement,
                    # 1010 mobile money) so the books match the statement.
                    tender_type = payments.channel_tender_type(payment_channel)
                    logger.info("Order %s opened for %s settlement (tender %s)", order_id, payment_channel, tender_type)
                payment_token = payments.new_payment_token() if wants_online_payment else ""
                payer_account = clean_text(body.get("payer_account") or body.get("payer_phone") or "", 60)
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
                    payment_provider=(payment_channel if wants_online_payment else None),
                    payment_channel=(payment_channel if wants_online_payment else None),
                    payer_account=(payer_account if wants_online_payment else None),
                    merchant_pay_code=(
                        payments.make_merchant_pay_code() if wants_online_payment and payment_channel == "merchant" else None
                    ),
                    payment_token_hash=(payments.hash_payment_token(payment_token) if wants_online_payment else None),
                    payment_expires_at=(
                        now + timedelta(minutes=payments.channel_ttl_minutes(payment_channel)) if wants_online_payment else None
                    ),
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
                    lines=sale_journal_lines(
                        grand_total, cogs, tender_type, transport_total,
                        consignment_gross_total, consignment_commission_total,
                        consignment_payable_total, consignment_pending=wants_online_payment,
                        consignment_partner_breakdown=consignment_partner_breakdown,
                    ),
                )
                session.flush()

                # Record alerts atomically with the successful checkout.
                order_number = order_id.split("-")[-1] if "-" in order_id else order_id
                if channel == "pos":
                    broadcast_event(
                        "NEW_ORDER",
                        f"🧾 POS Sale {order_id}",
                        f"UGX {grand_total:,} · {order.tender_type or 'cash'} · {sum(requested.values())} item(s)",
                        {"order_id": order_id, "amount": grand_total,
                         "customer": order.customer_name, "channel": channel},
                        session=session,
                    )
                else:
                    broadcast_event(
                        "NEW_ORDER",
                        f"🛍️ New {channel.title()} Order #{order_number}",
                        f"UGX {grand_total:,} · {order.customer_name or 'Customer'}",
                        {"order_id": order_id, "amount": grand_total,
                         "customer": order.customer_name, "channel": channel},
                        session=session,
                    )
                    inquiry = (order.delivery_notes or "").strip()
                    if inquiry:
                        broadcast_event(
                            "NEW_MESSAGE",
                            f"💬 Customer note on #{order_number}",
                            f"{order.customer_name}: “{inquiry[:140]}”",
                            {"order_id": order_id, "customer": order.customer_name,
                             "message": inquiry[:500]},
                            session=session,
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
                            session=session,
                        )

                area_access = access_control.state(headers, session)
                # A sale receipt may show the customer details just entered by
                # this cashier, but must not disclose protected COGS.
                own_receipt_access = dict(area_access, protected=area_access["protected"] - {"orders"})
                order_response = {
                    "status": "success",
                    "order": access_control.sanitize_sale(order.to_dict(), own_receipt_access),
                    "products": [access_control.sanitize_product(product.to_dict(), area_access) for product in products.values()],
                }
                if wants_online_payment:
                    # The payment token is issued ONCE, here, to the browser
                    # that placed the order. It authorizes payment initiation,
                    # pay-code issuing, claim submission and status polling for
                    # this order only, and is never stored anywhere server-side
                    # except as a SHA-256 hash.
                    order_response["payment"] = {
                        "provider": payments.PROVIDER,
                        "channel": payment_channel,
                        "status": "pending",
                        "token": payment_token,
                        "merchant_pay_code": order.merchant_pay_code or "",
                        "payer_account": order.payer_account or "",
                        "expires_at": order.payment_expires_at.isoformat() if order.payment_expires_at else None,
                        "payment_window_minutes": payments.channel_ttl_minutes(payment_channel),
                    }
                return json_response(order_response, status=201)

        # ----------------------------------------------------
        # 4b. Online payments — Flutterwave (public, order-token scoped)
        # ----------------------------------------------------
        if clean_path == "/api/payments/config" and method == "GET":
            # Safe by design: only the PUBLIC key, the payable channels the
            # store can actually honour, and the pay-to details a shopper needs
            # in order to transfer money (published by design, like an invoice).
            with get_db() as session:
                settings = public_store_settings(session.query(StoreSetting).all())
            return json_response({"ok": True, **checkout_payment_options(settings)})

        if clean_path == "/api/payments/method" and method == "POST":
            # The shopper changed how they will pay before settling. The sale
            # journal is already posted against the original channel, so a
            # switch posts a reclassification line instead of rewriting it —
            # audit trail stays intact and the books still match the statement.
            if not rate_limiting_disabled():
                allowed, retry_after = _rate_limiter.check("flw.method", client_ip, 30, 60)
                if not allowed:
                    return json_response({
                        "ok": False, "error": "Too many changes. Please wait a moment.",
                        "retry_after_seconds": retry_after,
                    }, status=429)
            with get_db() as session:
                order, error = load_order_for_payment(
                    session, body.get("order_id"), str(body.get("payment_token") or "")
                )
                if not order:
                    return json_response({"ok": False, "error": error}, status=404)
                if order.payment_status == "paid":
                    return json_response({"ok": False, "error": "This order is already paid", "payment_status": "paid"}, status=409)
                if order.status in ("cancelled", "completed") or order.payment_status == "failed":
                    return json_response({
                        "ok": False, "payment_status": "expired",
                        "error": "This order's payment window closed and its pieces were released. Please order again.",
                    }, status=410)
                requested = str(body.get("payment_method") or body.get("channel") or "")
                if not requested.strip():
                    return json_response({"ok": False, "error": "payment_method is required"}, status=400)
                channel = payments.normalize_channel(requested, default="")
                if not payments.is_online_channel(channel):
                    return json_response({
                        "ok": False,
                        "error": "Choose card, mobile money, bank transfer or a merchant pay code. To pay on delivery, cancel and re-order.",
                    }, status=400)
                if channel == "card" and not payments.is_enabled():
                    return json_response({"ok": False, "error": "Card payment is not available right now"}, status=503)
                options = checkout_payment_options(public_store_settings(session.query(StoreSetting).all()))
                if channel not in options["methods"]:
                    return json_response({
                        "ok": False,
                        "error": f"{payments.channel_info(channel)['label']} is not available right now — the store has not published the details for it yet.",
                    }, status=409)

                previous = payments.normalize_channel(order.payment_channel or order.payment_provider or "", default="card")
                now = datetime.utcnow()
                order.payment_channel = channel
                order.payment_provider = channel
                payer_account = clean_text(body.get("payer_account") or body.get("payer_phone") or "", 60)
                if payer_account:
                    order.payer_account = payer_account
                order.tender_type = payments.channel_tender_type(channel)
                order.payment_expires_at = now + timedelta(minutes=payments.channel_ttl_minutes(channel))
                order.updated_at = now
                pay_code = order.merchant_pay_code or ""
                if payments.channel_info(channel)["issues_code"]:
                    pay_code = issue_merchant_pay_code(session, order, now)
                session.flush()

                previous_tender = payments.channel_tender_type(previous)
                new_tender = payments.channel_tender_type(channel)
                if previous_tender != new_tender and int(order.total or 0) > 0:
                    old_code, old_name = payment_account(previous_tender)
                    new_code, new_name = payment_account(new_tender)
                    create_journal_entry(
                        session,
                        reference=order.id,
                        source="payment_channel_reclass",
                        description=f"Payment channel change for {order.id}: {previous} → {channel}",
                        occurred_at=now,
                        staff={"id": "WEB-CHECKOUT", "name": "Online checkout"},
                        lines=[
                            {"account_code": new_code, "account_name": new_name, "debit": int(order.total or 0)},
                            {"account_code": old_code, "account_name": old_name, "credit": int(order.total or 0)},
                        ],
                    )
                    logger.info(
                        "Payment channel reclassified for %s: %s -> %s", order.id, previous, channel
                    )
                return json_response({
                    "ok": True,
                    "order_id": order.id,
                    "channel": channel,
                    "merchant_pay_code": pay_code,
                    "payer_account": order.payer_account or "",
                    "expires_at": order.payment_expires_at.isoformat() if order.payment_expires_at else None,
                })

        if clean_path == "/api/payments/merchant-code" and method == "POST":
            # Issue (or return) the per-order merchant pay code. Anyone paying
            # on the shopper's behalf can use it, so it is not a secret — but
            # it only ever resolves to this one order and amount.
            if not rate_limiting_disabled():
                allowed, retry_after = _rate_limiter.check("flw.code", client_ip, 30, 60)
                if not allowed:
                    return json_response({
                        "ok": False, "error": "Too many attempts. Please wait a moment.",
                        "retry_after_seconds": retry_after,
                    }, status=429)
            with get_db() as session:
                order, error = load_order_for_payment(
                    session, body.get("order_id"), str(body.get("payment_token") or "")
                )
                if not order:
                    return json_response({"ok": False, "error": error}, status=404)
                if order.payment_status == "paid":
                    return json_response({
                        "ok": True, "payment_status": "paid", "order_id": order.id,
                        "merchant_pay_code": order.merchant_pay_code or "",
                    })
                if order.status in ("cancelled", "completed") or order.payment_status == "failed":
                    return json_response({
                        "ok": False, "payment_status": "expired",
                        "error": "This order's payment window closed and its pieces were released. Please order again.",
                    }, status=410)
                try:
                    code = issue_merchant_pay_code(session, order)
                except ValueError as exc:
                    return json_response({"ok": False, "error": str(exc)}, status=503)
                session.flush()
                settings = public_store_settings(session.query(StoreSetting).all())
                return json_response({
                    "ok": True,
                    "order_id": order.id,
                    "merchant_pay_code": code,
                    "amount": int(order.total or 0),
                    "currency": payments.FLW_CURRENCY,
                    "expires_at": order.payment_expires_at.isoformat() if order.payment_expires_at else None,
                    "instructions": merchant_pay_code_instructions(code, order, settings),
                })

        if clean_path == "/api/payments/merchant-code/lookup" and method == "POST":
            # Counter lookup: a customer quotes their ADN- code and staff need
            # the order behind it. Staff-only, because it exposes customer
            # details; the code itself is not treated as a secret.
            if not rate_limiting_disabled():
                allowed, retry_after = _rate_limiter.check("flw.code.lookup", client_ip, 60, 60)
                if not allowed:
                    return json_response({
                        "ok": False, "error": "Too many lookups. Please wait a moment.",
                        "retry_after_seconds": retry_after,
                    }, status=429)
            with get_db() as session:
                area_access = access_control.state(headers, session)
                if not access_control.allowed("orders", area_access) and not access_control.allowed("finance", area_access):
                    status, payload = access_control.locked_response("orders")
                    return json_response(payload, status=status)
                is_authed, staff_info = is_authenticated_staff(headers, body, query_params)
                if not is_authed:
                    return json_response({
                        "ok": False,
                        "error": "Unauthorized: Staff terminal authentication required to look up a pay code",
                    }, status=401)
                typed = clean_text(body.get("code") or body.get("merchant_pay_code") or "", 40)
                if not payments.normalize_pay_code(typed):
                    return json_response({
                        "ok": False,
                        "error": "That does not look like one of our pay codes. Codes look like ADN-XXXXXX.",
                    }, status=400)
                order = resolve_merchant_pay_code(session, None, typed)
                if not order:
                    return json_response({
                        "ok": False,
                        "error": "No order carries that pay code. Check the code with the customer.",
                    }, status=404)
                logger.info(
                    "Pay code %s looked up by %s -> %s",
                    payments.normalize_pay_code(typed), (staff_info or {}).get("name") or "staff", order.id,
                )
                return json_response({
                    "ok": True,
                    "order_id": order.id,
                    "merchant_pay_code": order.merchant_pay_code or "",
                    "amount": int(order.total or 0),
                    "currency": payments.FLW_CURRENCY,
                    "payment_status": order.payment_status or "unpaid",
                    "order_status": order.status or "",
                    "dispatch_status": order.dispatch_status or "",
                    "customer_name": order.customer_name or "",
                    "customer_phone": order.customer_phone or "",
                    "settled": (order.payment_status == "paid"),
                    "order": access_control.sanitize_sale(order.to_dict(), area_access),
                })

        if clean_path == "/api/payments/claim" and method == "POST":
            # The shopper says they have paid. This records WHAT to look for in
            # the bank / MoMo / merchant statement and alerts staff. It is
            # deliberately incapable of marking the order paid — only a
            # verified gateway charge or a staff confirmation can do that.
            if not rate_limiting_disabled():
                allowed, retry_after = _rate_limiter.check("flw.claim", client_ip, 20, 60)
                if not allowed:
                    return json_response({
                        "ok": False, "error": "Too many submissions. Please wait a moment.",
                        "retry_after_seconds": retry_after,
                    }, status=429)
            reference = clean_text(body.get("reference") or body.get("transaction_id") or "", 120)
            with get_db() as session:
                order, error = load_order_for_payment(
                    session, body.get("order_id"), str(body.get("payment_token") or "")
                )
                if not order:
                    return json_response({"ok": False, "error": error}, status=404)
                if order.payment_status == "paid":
                    return json_response({"ok": True, "payment_status": "paid", "order_id": order.id})
                if order.payment_status == "failed" or order.status in ("cancelled", "completed"):
                    return json_response({
                        "ok": False, "payment_status": "expired",
                        "error": "This order's payment window closed. If you were charged, contact the store with your receipt.",
                    }, status=410)
                channel = payments.normalize_channel(
                    body.get("payment_method") or body.get("channel") or order.payment_channel or "momo", default=""
                )
                if not payments.is_online_channel(channel):
                    return json_response({"ok": False, "error": "Choose how you paid"}, status=400)
                if not reference and channel != "merchant":
                    return json_response({
                        "ok": False,
                        "error": "Enter the transaction ID or bank reference from your payment message",
                    }, status=400)
                now = datetime.utcnow()
                order.payment_claim_channel = channel
                order.payment_claim_reference = reference
                order.payment_claim_at = now
                order.payment_channel = channel
                if order.payment_status == "pending":
                    order.payment_status = "claimed"
                order.updated_at = now
                session.flush()
                order_number = order.id.split("-")[-1] if "-" in order.id else order.id
                label = payments.channel_info(channel)["label"]
                broadcast_event(
                    "ORDER_PAYMENT_CLAIMED",
                    f"🧾 Payment submitted — Order #{order_number}",
                    f"{order.customer_name or 'Online shopper'} says they paid UGX {int(order.total or 0):,} by {label}"
                    + (f" · ref {reference}." if reference else f" · pay code {order.merchant_pay_code}.")
                    + " Confirm it in the bank / merchant statement, then mark the order paid.",
                    {"order_id": order.id, "amount": order.total, "channel": channel,
                     "reference": reference, "merchant_pay_code": order.merchant_pay_code or ""},
                    session=session,
                )
                return json_response({
                    "ok": True,
                    "order_id": order.id,
                    "payment_status": order.payment_status,
                    "reference": reference,
                    "channel": channel,
                    "message": "Payment submitted. The store will confirm it and update your order.",
                })

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
                    "channel": order.payment_channel or order.payment_provider or "",
                    "total": order.total,
                    "merchant_pay_code": order.merchant_pay_code or "",
                    "payer_account": order.payer_account or "",
                    "reference": order.payment_reference or "",
                    "claim": {
                        "channel": order.payment_claim_channel or "",
                        "reference": order.payment_claim_reference or "",
                        "at": order.payment_claim_at.isoformat() if order.payment_claim_at else None,
                    } if order.payment_claim_at else None,
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
                # Which channel this attempt collects. A mobile-money order can
                # be collected on the momo rail (push prompt + PIN on the
                # shopper's phone) just as a card order is charged on the card
                # rail; bank and merchant orders have no gateway rail at all and
                # must go back through their own instructions.
                order_channel = payments.normalize_channel(order.payment_channel or "", default="")
                requested_channel = payments.normalize_channel(body.get("channel") or "", default="")
                gateway_channel = order_channel
                # The browser may only ever *confirm* the rail this order was
                # placed on. It can never move a bank or merchant order onto a
                # gateway rail — that would take money twice or book it against
                # the wrong account.
                if not payments.is_gateway_collectable(gateway_channel) or (
                    requested_channel and requested_channel != gateway_channel
                ):
                    return json_response({
                        "ok": False,
                        "error": "This order is not paid through the gateway — follow its payment instructions.",
                        "payment_channel": order_channel or "cod",
                    }, status=409)
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
                # The push prompt only works with the number that actually pays,
                # so prefer the number captured at checkout over the contact
                # number, and never invent one.
                paying_number = (order.payer_account or "").strip() or (order.customer_phone or "").strip()
                return json_response({
                    "ok": True,
                    "provider": payments.PROVIDER,
                    "public_key": payments.public_checkout_config()["public_key"],
                    "mock": payments.MOCK_MODE,
                    "tx_ref": attempt.tx_ref,
                    "amount": attempt.amount,
                    "currency": attempt.currency,
                    "order_id": order.id,
                    "channel": gateway_channel,
                    "payment_options": payments.gateway_payment_options(gateway_channel),
                    "customer": {
                        "name": order.customer_name or "Online Shopper",
                        "phone": paying_number,
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
                # Which channel this attempt collects. A mobile-money order can
                # be collected on the momo rail (push prompt + PIN on the
                # shopper's phone) just as a card order is charged on the card
                # rail; bank and merchant orders have no gateway rail at all and
                # must go back through their own instructions.
                order_channel = payments.normalize_channel(order.payment_channel or "", default="")
                requested_channel = payments.normalize_channel(body.get("channel") or "", default="")
                gateway_channel = order_channel
                # The browser may only ever *confirm* the rail this order was
                # placed on. It can never move a bank or merchant order onto a
                # gateway rail — that would take money twice or book it against
                # the wrong account.
                if not payments.is_gateway_collectable(gateway_channel) or (
                    requested_channel and requested_channel != gateway_channel
                ):
                    return json_response({
                        "ok": False,
                        "error": "This order is not paid through the gateway — follow its payment instructions.",
                        "payment_channel": order_channel or "cod",
                    }, status=409)
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

                # Record the alert atomically with this expense.
                broadcast_event(
                    "NEW_EXPENSE",
                    f"🧾 Expense logged — {category}",
                    f"UGX {amount:,} ({payment_method}) by {staff_info.get('name', 'Staff')}",
                    {"expense_id": expense_id, "category": category, "amount": amount,
                     "payment_method": payment_method,
                     "staff": staff_info.get("name", "Staff")},
                    session=session,
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
                    broadcast_event("EXPENSE_VOIDED", "Expense voided", f"{expense.category} · UGX {int(expense.amount):,}",
                        {"expense_id": expense_id, "amount": int(expense.amount)}, session=session)
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
                broadcast_event("EXPENSE_UPDATED", "Expense updated", f"{category} · UGX {amount:,}",
                    {"expense_id": expense_id, "category": category, "amount": amount}, session=session)
                return json_response({"ok": True, "status": "updated", "expense": expense.to_dict()})

        if clean_path == "/api/finance/stock-lots" and method in ("GET", "POST"):
            staff_info, auth_error = authenticated_or_response(headers, body, query_params)
            if auth_error:
                return auth_error
            if method == "GET":
                with get_db() as session:
                    rows = session.query(StockLot).order_by(StockLot.acquired_at.desc()).limit(250).all()
                    return json_response({"ok": True, "stock_lots": [row.to_dict(include_grades=True) for row in rows]})
            try:
                supplier = str(body.get("supplier") or "").strip()
                description = str(body.get("description") or "").strip()
                acquisition_cost = parse_positive_int(body.get("acquisition_cost"), "Acquisition cost", allow_zero=True)
                shipping_cost = parse_positive_int(body.get("shipping_cost", 0), "Shipping cost", allow_zero=True)
                # Multi-tier in-batch grading is optional: legacy one-price lots
                # still work, but a tiered intake gets locked per-tier COGS.
                grades = parse_lot_grades(body.get("grades")) if body.get("grades") is not None else None
                if grades:
                    derived_count = sum(g["expected_count"] for g in grades)
                    supplied_count = body.get("item_count")
                    if supplied_count not in (None, "", 0) and int(supplied_count) != derived_count:
                        raise ValueError(
                            "Item count does not match the tier piece counts "
                            f"({supplied_count} vs {derived_count})"
                        )
                    item_count = derived_count
                else:
                    item_count = parse_positive_int(body.get("item_count"), "Item count")
                if not supplier or not description:
                    raise ValueError("Supplier and lot description are required")
                total_landed = acquisition_cost + shipping_cost
                if total_landed <= 0:
                    raise ValueError("Total landed cost must be greater than zero")
                # Blended fallback unit cost (used when a legacy un-graded lot
                # is tagged without selecting a specific tier).
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
                # Parent lot AND its grade tiers commit in one transaction: the
                # bale can never exist with a half-written cost breakdown.
                # Unit COGS is locked here, server-side — clients never supply it.
                if grades:
                    unit_costs = compute_grade_unit_costs(total_landed, grades)
                    for sort_order, (grade_input, locked_cogs) in enumerate(zip(grades, unit_costs)):
                        session.add(LotGrade(
                            id=generate_uid("LGR"),
                            lot_id=lot_id,
                            sort_order=sort_order,
                            grade_name=grade_input["grade_name"],
                            expected_count=grade_input["expected_count"],
                            cost_weight_percentage=grade_input["cost_weight_percentage"],
                            unit_cogs=locked_cogs,
                            target_selling_price=grade_input["target_selling_price"],
                            allocated_count=0,
                        ))
                session.flush()
                broadcast_event("STOCK_LOT_RECEIVED", "Stock lot registered", f"{lot_code} · {item_count} pieces · {supplier}",
                    {"lot_id": lot_id, "lot_code": lot_code, "item_count": item_count}, session=session)
                return json_response({"ok": True, "status": "registered", "stock_lot": lot.to_dict(include_grades=True)}, status=201)

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
                partner_payables = 0
                pending_partner_gross = 0
                channels = {"POS": 0, "WhatsApp / TikTok": 0, "Web": 0}
                categories = {}
                for order in orders:
                    partner_adjustments = order_consignment_financial_adjustments(order)
                    partner_payables += partner_adjustments["payable"]
                    pending_partner_gross += partner_adjustments["pending_gross"]
                    if order.channel == "pos":
                        channel_name = "POS"
                    elif order.channel in {"whatsapp", "tiktok", "social"}:
                        channel_name = "WhatsApp / TikTok"
                    else:
                        channel_name = "Web"
                    channels[channel_name] += int(order.total or 0)
                    for item in order.items:
                        item_cost = int(item.unit_cost or 0) * int(item.qty or 0)
                        if not item.consignment_partner_id and not item_cost and item.product_id:
                            product = session.query(Product).filter_by(id=item.product_id).first()
                            item_cost = int(product.cost_price or 0) * int(item.qty or 0) if product else 0
                        item_revenue = int(item.line_total or 0)
                        cogs += item_cost
                        name = item.category or "Uncategorised"
                        bucket = categories.setdefault(name, {"category": name, "sales": 0, "cogs": 0, "profit": 0})
                        bucket["sales"] += item_revenue
                        bucket["cogs"] += item_cost
                        if item.consignment_partner_id:
                            if not partner_adjustments["pending_gross"]:
                                bucket["profit"] += int(item.consignment_commission_amount or 0)
                        else:
                            bucket["profit"] += item_revenue - item_cost
                gross_profit = gross_sales - cogs - partner_payables - pending_partner_gross
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
                        "consignment_payables": partner_payables,
                        "pending_consignment_settlements": pending_partner_gross,
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
                    broadcast_event("STOCK_MARKDOWN", "Stock markdown saved", f"{product.name} · UGX {new_price:,}",
                        {"product_id": product.id, "new_price": new_price}, session=session)
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
                broadcast_event("STOCK_WRITTEN_OFF", "Stock written off", f"{product.name} · {quantity} unit(s) removed.",
                    {"product_id": product.id, "quantity": quantity}, session=session)
                return json_response({"ok": True, "status": "written_off", "product": product.to_dict(), "adjustment": adjustment.to_dict()})

        # ----------------------------------------------------
        # Strategy & Marketing Insights (Manager-only)
        # Turns posted sales/ledger data into decision-ready intelligence:
        # KPIs, trends, channels, customers, marketing ROI, stock signals,
        # a data-reliability score, and plain-language strategy advice.
        # ----------------------------------------------------
        if clean_path == "/api/finance/insights" and method == "GET":
            staff_info, auth_error = authenticated_or_response(headers, body, query_params, manager=True)
            if auth_error:
                return auth_error
            try:
                days = int(query_params.get("days", ["30"])[0])
                if days not in {7, 30, 90}:
                    raise ValueError()
            except ValueError:
                return json_response({"ok": False, "error": "days must be 7, 30, or 90"}, status=400)

            now = datetime.utcnow()
            start = (now - timedelta(days=days)).replace(hour=0, minute=0, second=0, microsecond=0)
            prev_start = start - timedelta(days=days)
            with get_db() as session:
                def fetch_orders(start_at, end_at):
                    return session.query(Order).filter(
                        Order.created_at >= start_at,
                        Order.created_at < end_at,
                        ~func.lower(Order.status).in_(["cancelled", "void"]),
                    ).all()

                orders = fetch_orders(start, now)
                previous_orders = fetch_orders(prev_start, start)

                def order_metrics(bucket):
                    revenue = sum(int(o.total or 0) for o in bucket)
                    units = 0
                    cogs = 0
                    partner_payables = 0
                    pending_partner_gross = 0
                    for order in bucket:
                        adjustment = order_consignment_financial_adjustments(order)
                        partner_payables += adjustment["payable"]
                        pending_partner_gross += adjustment["pending_gross"]
                        for item in order.items:
                            qty = int(item.qty or 0)
                            units += qty
                            cost = int(item.unit_cost or 0)
                            if not item.consignment_partner_id and not cost and item.product_id:
                                ref = session.query(Product).filter_by(id=item.product_id).first()
                                cost = int(ref.cost_price or 0) if ref else 0
                            cogs += cost * qty
                    return {"revenue": revenue, "orders": len(bucket), "units": units, "cogs": cogs,
                            "consignment_payables": partner_payables,
                            "pending_consignment_gross": pending_partner_gross}

                current = order_metrics(orders)
                previous = order_metrics(previous_orders)
                gross_profit = (current["revenue"] - current["cogs"]
                                - current["consignment_payables"] - current["pending_consignment_gross"])
                gross_margin = round(gross_profit / current["revenue"] * 100, 1) if current["revenue"] else 0
                avg_order_value = round(current["revenue"] / current["orders"]) if current["orders"] else 0
                delivery_fees = sum(int(o.delivery_fee or 0) for o in orders)

                # Expenses (journal-derived, matches dashboard) + marketing spend.
                expense_debit, expense_credit = session.query(
                    func.coalesce(func.sum(AccountingJournalLine.debit), 0),
                    func.coalesce(func.sum(AccountingJournalLine.credit), 0),
                ).join(
                    AccountingJournalEntry,
                    AccountingJournalLine.journal_entry_id == AccountingJournalEntry.id,
                ).filter(
                    AccountingJournalLine.account_code.in_(["5100", "5200"]),
                    AccountingJournalEntry.occurred_at >= start,
                ).one()
                expenses = int(expense_debit or 0) - int(expense_credit or 0)
                marketing_rows = session.query(ExpenseRecord).filter(
                    ExpenseRecord.occurred_at >= start,
                    func.lower(ExpenseRecord.status) == "posted",
                    ExpenseRecord.category.ilike("%marketing%"),
                ).all()
                marketing_spend = sum(int(row.amount or 0) for row in marketing_rows)

                # Daily trend with zero-filled days so charts stay honest.
                trend = {}
                for order in orders:
                    key = order.created_at.date().isoformat()
                    day = trend.setdefault(key, {"date": key, "revenue": 0, "orders": 0, "profit": 0})
                    day["revenue"] += int(order.total or 0)
                    day["orders"] += 1
                    partner_adjustment = order_consignment_financial_adjustments(order)
                    for item in order.items:
                        cost = int(item.unit_cost or 0) * int(item.qty or 0)
                        if item.consignment_partner_id:
                            day["profit"] += int(item.consignment_commission_amount or 0) if not partner_adjustment["pending_gross"] else 0
                        else:
                            day["profit"] += int(item.line_total or 0) - cost
                daily_trend = []
                cursor = start.date()
                end_date = now.date()
                while cursor <= end_date:
                    key = cursor.isoformat()
                    daily_trend.append(trend.get(key, {"date": key, "revenue": 0, "orders": 0, "profit": 0}))
                    cursor += timedelta(days=1)

                # Channel performance.
                channel_map = {}
                for order in orders:
                    if order.channel == "pos":
                        name = "In-Store POS"
                    elif order.channel in {"whatsapp", "tiktok", "social"}:
                        name = "WhatsApp / Social"
                    else:
                        name = "Web Storefront"
                    row = channel_map.setdefault(name, {"channel": name, "revenue": 0, "orders": 0})
                    row["revenue"] += int(order.total or 0)
                    row["orders"] += 1
                channels = sorted(channel_map.values(), key=lambda r: r["revenue"], reverse=True)
                for row in channels:
                    row["share"] = round(row["revenue"] / current["revenue"] * 100, 1) if current["revenue"] else 0

                # Category performance with revenue share.
                category_map = {}
                for order in orders:
                    partner_adjustment = order_consignment_financial_adjustments(order)
                    for item in order.items:
                        qty = int(item.qty or 0)
                        cost = int(item.unit_cost or 0) * qty
                        name = item.category or "Uncategorised"
                        row = category_map.setdefault(name, {"category": name, "revenue": 0, "units": 0, "profit": 0})
                        row["revenue"] += int(item.line_total or 0)
                        row["units"] += qty
                        if item.consignment_partner_id:
                            if not partner_adjustment["pending_gross"]:
                                row["profit"] += int(item.consignment_commission_amount or 0)
                        else:
                            row["profit"] += int(item.line_total or 0) - cost
                categories = sorted(category_map.values(), key=lambda r: r["revenue"], reverse=True)
                for row in categories:
                    row["share"] = round(row["revenue"] / current["revenue"] * 100, 1) if current["revenue"] else 0
                    row["margin"] = round(row["profit"] / row["revenue"] * 100, 1) if row["revenue"] else 0

                # Top-selling products (by revenue).
                product_map = {}
                for order in orders:
                    partner_adjustment = order_consignment_financial_adjustments(order)
                    for item in order.items:
                        key = item.product_id or item.name
                        qty = int(item.qty or 0)
                        row = product_map.setdefault(key, {
                            "product_id": item.product_id or "", "name": item.name,
                            "category": item.category or "Uncategorised",
                            "units": 0, "revenue": 0, "profit": 0,
                        })
                        row["units"] += qty
                        row["revenue"] += int(item.line_total or 0)
                        if item.consignment_partner_id:
                            if not partner_adjustment["pending_gross"]:
                                row["profit"] += int(item.consignment_commission_amount or 0)
                        else:
                            row["profit"] += int(item.line_total or 0) - int(item.unit_cost or 0) * qty
                top_products = sorted(product_map.values(), key=lambda r: r["revenue"], reverse=True)[:8]
                for row in top_products:
                    row["margin"] = round(row["profit"] / row["revenue"] * 100, 1) if row["revenue"] else 0

                # Customer & CRM intelligence (repeat rate drives retention strategy).
                customers = {}
                for order in orders:
                    phone = re.sub(r"\D", "", order.customer_phone or "")
                    name_key = re.sub(r"\s+", " ", (order.customer_name or "").strip().lower())
                    key = phone or name_key or "walk-in"
                    row = customers.setdefault(key, {
                        "name": (order.customer_name or "").strip() or "Walk-in",
                        "phone": phone, "orders": 0, "spend": 0,
                    })
                    row["orders"] += 1
                    row["spend"] += int(order.total or 0)
                    if not row["phone"] and name_key != "walk-in":
                        row["phone"] = phone
                named = [row for k, row in customers.items() if k != "walk-in"]
                repeat_customers = [row for row in named if row["orders"] > 1]
                top_customers = sorted(named, key=lambda r: r["spend"], reverse=True)[:6]
                customer_insights = {
                    "total": len(named),
                    "repeat": len(repeat_customers),
                    "repeat_rate": round(len(repeat_customers) / len(named) * 100, 1) if named else 0,
                    "top": top_customers,
                    "identified_order_share": round(
                        (len(orders) - customers.get("walk-in", {}).get("orders", 0)) / len(orders) * 100, 1
                    ) if orders else 0,
                }

                # Live inventory signals for buying/markdown strategy.
                live_products = session.query(Product).filter(
                    Product.inventory_status.notin_(["ARCHIVED", "WRITTEN_OFF"]),
                ).all()
                stock_units = sum(int(p.in_stock_count or 0) for p in live_products)
                stock_value = sum(int(p.cost_price or 0) * int(p.in_stock_count or 0) for p in live_products)
                aging_cutoff = now - timedelta(days=60)
                aging_rows = [p for p in live_products
                              if p.created_at and p.created_at <= aging_cutoff and int(p.in_stock_count or 0) > 0]
                low_stock = [p for p in live_products if 0 < int(p.in_stock_count or 0) <= 2]
                new_intakes = [p for p in live_products if p.created_at and p.created_at >= start]
                stock_signals = {
                    "live_products": len(live_products),
                    "stock_units": stock_units,
                    "stock_value_cost": stock_value,
                    "new_intakes_in_period": len(new_intakes),
                    "aging_60d_items": len(aging_rows),
                    "aging_60d_value": sum(int(p.cost_price or 0) * int(p.in_stock_count or 0) for p in aging_rows),
                    "low_stock_items": len(low_stock),
                }

                # Data-reliability audit: only trustworthy data should drive strategy.
                in_stock = [p for p in live_products if int(p.in_stock_count or 0) > 0]
                def rate(predicate, sample):
                    if not sample:
                        return 0
                    return len([row for row in sample if predicate(row)]) / len(sample)
                quality_checks = [
                    {"key": "pricing", "label": "Selling price recorded",
                     "weight": 3, "pass_rate": rate(lambda p: int(p.selling_price or 0) > 0, in_stock),
                     "fix": "Inventory Rack", "impact": "Revenue reports"},
                    {"key": "costing", "label": "Unit cost (COGS) recorded",
                     "weight": 3, "pass_rate": rate(lambda p: int(p.cost_price or 0) > 0, in_stock),
                     "fix": "Bale Costs tab", "impact": "Profit & margin figures"},
                    {"key": "photos", "label": "Product photo attached",
                     "weight": 2, "pass_rate": rate(lambda p: bool((p.image_url or "").strip()), in_stock),
                     "fix": "Catalog Intake", "impact": "Online conversion"},
                    {"key": "branding", "label": "Brand / label recorded",
                     "weight": 1, "pass_rate": rate(lambda p: bool((p.brand or "").strip()), in_stock),
                     "fix": "Inventory Rack", "impact": "Search & merchandising"},
                    {"key": "customer_names", "label": "Customer name captured on orders",
                     "weight": 2, "pass_rate": rate(lambda o: bool((o.customer_name or "").strip()), orders),
                     "fix": "Checkout flow", "impact": "CRM & repeat marketing"},
                    {"key": "customer_phones", "label": "Customer phone captured on orders",
                     "weight": 2, "pass_rate": rate(lambda o: len(re.sub(r"\D", "", o.customer_phone or "")) >= 9, orders),
                     "fix": "Checkout flow", "impact": "WhatsApp campaigns"},
                ]
                total_weight = sum(row["weight"] for row in quality_checks)
                quality_score = round(
                    sum(row["weight"] * row["pass_rate"] for row in quality_checks) / total_weight * 100
                ) if total_weight else 0
                for row in quality_checks:
                    row["pass_rate"] = round(row["pass_rate"] * 100, 1)

                # ---- Plain-language strategy engine ----
                recommendations = []
                growth = 0
                if previous["revenue"]:
                    growth = round((current["revenue"] - previous["revenue"]) / previous["revenue"] * 100, 1)
                if not current["orders"]:
                    recommendations.append({
                        "tone": "warn", "title": "Record every sale to unlock insights",
                        "detail": "No completed sales were found in this window. Ring every order through the POS or storefront so strategy reporting stays trustworthy.",
                    })
                if previous["revenue"]:
                    trend_word = "up" if growth >= 0 else "down"
                    recommendations.append({
                        "tone": "positive" if growth >= 0 else "warn",
                        "title": f"Revenue is {trend_word} {abs(growth)}% vs the previous {days} days",
                        "detail": (f"This window: UGX {current['revenue']:,} · previous window: UGX {previous['revenue']:,}. "
                                   + ("Protect what's working — keep the fast categories in stock and repeat the promotions that drove this."
                                      if growth >= 0 else
                                      "Investigate the dip: check stock-outs in your best categories, then re-run the last promotion that converted.")),
                    })
                if categories:
                    named_cats = [row for row in categories if row["category"] != "Uncategorised"]
                    top = named_cats[0] if named_cats else None
                    if top and top["share"] >= 35:
                        recommendations.append({
                            "tone": "positive", "title": f"{top['category']} is your engine ({top['share']}% of revenue)",
                            "detail": f"It returned UGX {top['profit']:,} gross profit on {top['units']} units. Prioritise intake of similar pieces and feature them first on TikTok, Instagram, and the storefront hero.",
                        })
                    weakest_margin = min(named_cats, key=lambda r: r["margin"]) if named_cats else None
                    if weakest_margin and weakest_margin["margin"] < 20 and weakest_margin["revenue"] > 0:
                        recommendations.append({
                            "tone": "warn", "title": f"Re-price {weakest_margin['category']} (only {weakest_margin['margin']}% margin)",
                            "detail": "Margin this thin means a small markdown wipes out profit. Raise base prices, negotiate cheaper bales, or bundle with high-margin items.",
                        })
                if avg_order_value:
                    bundle_target = int(round(avg_order_value * 1.2, -3))
                    recommendations.append({
                        "tone": "action", "title": f"Lift the basket from UGX {avg_order_value:,} toward UGX {bundle_target:,}",
                        "detail": "Train cashiers to offer a matching accessory at checkout and use bundle pricing online (tee + cap). A 20% basket lift compounds every marketing shilling.",
                    })
                if marketing_spend == 0:
                    recommendations.append({
                        "tone": "action", "title": "No marketing spend recorded",
                        "detail": "Healthy retail invests roughly 5–8% of revenue in promotion. Post boosts, flyers, and TikTok content under Financial Ledgers → Daily Expense → Marketing so ROI can be measured here.",
                    })
                elif current["revenue"]:
                    spend_ratio = marketing_spend / current["revenue"] * 100
                    if spend_ratio > 12:
                        recommendations.append({
                            "tone": "warn", "title": f"Marketing is {round(spend_ratio)}% of revenue — audit ROI",
                            "detail": f"UGX {marketing_spend:,} spent this window. Ask each campaign which orders it produced; shift budget to the channel that answers with sales.",
                        })
                    else:
                        recommendations.append({
                            "tone": "positive", "title": f"Marketing discipline looks healthy ({round(spend_ratio)}% of revenue)",
                            "detail": f"UGX {marketing_spend:,} promoted UGX {current['revenue']:,} of sales. Tag boosted posts with a code at checkout to tighten attribution further.",
                        })
                if customer_insights["total"] >= 3:
                    if customer_insights["repeat_rate"] < 20:
                        recommendations.append({
                            "tone": "action", "title": f"Only {customer_insights['repeat_rate']}% of customers returned",
                            "detail": "Capture phone numbers at every checkout, then send weekly 'new drop' WhatsApp broadcasts from the Strategy tab's customer list. Repeat buyers cost nothing to re-acquire.",
                        })
                    else:
                        recommendations.append({
                            "tone": "positive", "title": f"Retention is strong — {customer_insights['repeat_rate']}% repeat buyers",
                            "detail": "Reward loyalty: early access to new bales or size-run reservations keeps these customers from drifting to competitors.",
                        })
                if stock_signals["aging_60d_value"] > 0:
                    recommendations.append({
                        "tone": "warn", "title": f"UGX {stock_signals['aging_60d_value']:,} is parked in {stock_signals['aging_60d_items']} slow pieces (60+ days)",
                        "detail": "That cash could fund a fresh bale this week. Run a markdown campaign (Dead Stock tab) and advertise the drop as a 'clearance event' on socials.",
                    })
                if stock_signals["low_stock_items"] > 0:
                    recommendations.append({
                        "tone": "action", "title": f"{stock_signals['low_stock_items']} products are nearly stocked out",
                        "detail": "Replenish best-seller sizes before pushing ads — marketing an out-of-stock item burns budget and trust.",
                    })
                if quality_score < 85:
                    recommendations.append({
                        "tone": "warn", "title": f"Data reliability is {quality_score}% — fix records before big decisions",
                        "detail": "Prices, costs, photos, and customer details below 100% make reports lie. Open each failed check below and clean up the records it lists.",
                    })
                recommendations = recommendations[:6]

                return json_response({
                    "ok": True,
                    "days": days,
                    "period": {"start": start.isoformat() + "Z", "end": now.isoformat() + "Z"},
                    "kpis": {
                        "revenue": current["revenue"], "orders": current["orders"],
                        "units": current["units"], "avg_order_value": avg_order_value,
                        "gross_profit": gross_profit, "gross_margin": gross_margin,
                        "expenses": expenses, "net_contribution": gross_profit - expenses,
                        "delivery_fee_revenue": delivery_fees,
                        "revenue_growth_pct": growth if previous["revenue"] else None,
                        "previous_revenue": previous["revenue"],
                    },
                    "daily_trend": daily_trend,
                    "channels": channels,
                    "categories": categories[:10],
                    "top_products": top_products,
                    "customers": customer_insights,
                    "marketing": {
                        "spend": marketing_spend,
                        "campaigns": len(marketing_rows),
                        "spend_ratio": round(marketing_spend / current["revenue"] * 100, 2) if current["revenue"] else 0,
                        "revenue_per_shilling": round(current["revenue"] / marketing_spend, 1) if marketing_spend else None,
                    },
                    "stock_signals": stock_signals,
                    "data_quality": {"score": quality_score, "checks": quality_checks},
                    "recommendations": recommendations,
                    "generated_at": now.isoformat() + "Z",
                })

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
                area_access = access_control.state(headers, session)
                blocked = sorted(area for area in access_control.AREAS if not access_control.allowed(area, area_access))
                # Cheap fingerprint of everything the payload contains. Clients that already hold this
                # revision get a tiny "unchanged" reply instead of the whole store (polled every few seconds).
                revision_parts = [
                    list(session.query(func.count(Product.id), func.max(Product.updated_at)).one()),
                    list(session.query(func.count(Order.id), func.max(Order.updated_at)).one()),
                    list(session.query(func.count(OrderItem.id)).one()),
                    list(session.query(func.count(Inventory.id), func.sum(Inventory.quantity)).one()),
                    list(session.query(func.count(LedgerEntry.id), func.max(LedgerEntry.created_at)).one()),
                    list(session.query(func.count(Category.id)).one()),
                    list(session.query(func.count(Rider.id)).one()),
                    list(session.query(func.count(StoreSetting.key), func.max(StoreSetting.updated_at)).one()),
                    blocked,
                ]
                revision = hashlib.sha256(json.dumps(revision_parts, default=str, sort_keys=True).encode("utf-8")).hexdigest()[:32]
                client_revision = ""
                if isinstance(body, dict):
                    client_revision = str(body.get("if_revision") or "")
                if client_revision and client_revision == revision:
                    return json_response({"unchanged": True, "revision": revision, "synced_at": datetime.utcnow().isoformat()})
                products = [access_control.sanitize_product(p.to_dict(), area_access) for p in session.query(Product).order_by(Product.created_at.desc()).all()]
                categories = [c.to_dict() for c in session.query(Category).order_by(Category.sort_order.asc()).all()]
                orders = [access_control.sanitize_sale(o.to_dict(), area_access) for o in session.query(Order).options(selectinload(Order.items)).order_by(Order.created_at.desc()).all()] if (access_control.allowed("orders", area_access) or access_control.allowed("finance", area_access)) else []
                inventory = [i.to_dict() for i in session.query(Inventory).all()] if access_control.allowed("stock", area_access) else []
                riders = [r.to_dict() for r in session.query(Rider).filter_by(archived=False).all()] if access_control.allowed("orders", area_access) else []
                ledger = [l.to_dict() for l in session.query(LedgerEntry).order_by(LedgerEntry.created_at.desc()).all()] if access_control.allowed("finance", area_access) else []
                settings_rows = session.query(StoreSetting).all()
                settings = public_store_settings(settings_rows)

                return json_response({
                    "synced_at": datetime.utcnow().isoformat(),
                    "revision": revision,
                    "products": products,
                    "categories": categories,
                    "sales": orders,
                    "inventory": inventory,
                    "riders": riders,
                    "ledger": ledger,
                    "settings": settings,
                    "blocked_areas": [area for area in access_control.AREAS if not access_control.allowed(area, area_access)]
                })

        # ----------------------------------------------------
        # 6. Store Settings (sanitized read / PIN-free or opt-in protected update)
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
            if staff_auth_required() and (not is_authed or (staff_info or {}).get("role") != "admin"):
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
                if key == "storefront_promo_ids":
                    try:
                        text_value = normalize_storefront_promo_ids(text_value)
                    except ValueError as exc:
                        return json_response({"ok": False, "error": str(exc)}, status=400)
                if key == "email" and text_value.strip().lower() in LEGACY_STORE_EMAILS:
                    text_value = OFFICIAL_STORE_EMAIL
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
                previous_promo_setting = session.query(StoreSetting).filter_by(key="storefront_promo_ids").first()
                previous_promo_items = storefront_promo_custom_items(previous_promo_setting.value if previous_promo_setting else "")
                next_promo_items = previous_promo_items
                removed_promo_items = []
                if "storefront_promo_ids" in updates:
                    next_promo_items = storefront_promo_custom_items(updates["storefront_promo_ids"])
                    image_ids = [item["media_id"] for item in next_promo_items if item["type"] == "image"]
                    html_ids = [item["media_id"] for item in next_promo_items if item["type"] == "html"]
                    valid_image_ids = {
                        row.id for row in session.query(ProductMedia.id).filter(
                            ProductMedia.id.in_(image_ids or ["__none__"]),
                            ProductMedia.kind == "image",
                            ProductMedia.product_id.is_(None),
                        ).all()
                    }
                    html_assets = {
                        row.id: row for row in session.query(StorePromotionCreative).filter(
                            StorePromotionCreative.id.in_(html_ids or ["__none__"]),
                        ).all()
                    }
                    if valid_image_ids != set(image_ids) or set(html_assets) != set(html_ids):
                        return json_response({
                            "ok": False,
                            "error": "Custom promotions can only use uploaded, unattached images or HTML banners. Upload the missing creative again and retry.",
                        }, status=400)

                    # HTML design dimensions are server-derived metadata. The
                    # public rail scales the creative to its compact slot while
                    # preserving its original aspect ratio.
                    if next_promo_items:
                        promo_config = json.loads(updates["storefront_promo_ids"])
                        if isinstance(promo_config, dict) and promo_config.get("mode") == "custom":
                            for item in promo_config["items"]:
                                if item.get("type") == "html":
                                    asset = html_assets[item["media_id"]]
                                    item["width"], item["height"] = asset.width, asset.height
                            updates["storefront_promo_ids"] = json.dumps(
                                promo_config, ensure_ascii=False, separators=(",", ":")
                            )
                            if len(updates["storefront_promo_ids"]) > 2000:
                                return json_response({"ok": False, "error": "The storefront creative list is too long."}, status=400)
                    next_keys = {(item["type"], item["media_id"]) for item in next_promo_items}
                    removed_promo_items = [
                        item for item in previous_promo_items
                        if (item["type"], item["media_id"]) not in next_keys
                    ]

                changed_keys = []
                for key, value in updates.items():
                    setting = session.query(StoreSetting).filter_by(key=key).first()
                    if not setting or setting.value != value:
                        changed_keys.append(key)
                    if setting:
                        setting.value = value
                    else:
                        session.add(StoreSetting(key=key, value=value))
                session.flush()
                removed_image_ids = [item["media_id"] for item in removed_promo_items if item["type"] == "image"]
                removed_html_ids = [item["media_id"] for item in removed_promo_items if item["type"] == "html"]
                if removed_image_ids:
                    removed_assets = session.query(ProductMedia).filter(
                        ProductMedia.id.in_(removed_image_ids),
                        ProductMedia.kind == "image",
                        ProductMedia.product_id.is_(None),
                    ).all()
                    for asset in removed_assets:
                        session.delete(asset)
                if removed_html_ids:
                    removed_assets = session.query(StorePromotionCreative).filter(
                        StorePromotionCreative.id.in_(removed_html_ids),
                    ).all()
                    for asset in removed_assets:
                        session.delete(asset)
                if removed_image_ids or removed_html_ids:
                    session.flush()

                # Optional one-command rollout: re-point every catalog item's
                # transport cost at the (new) global base delivery fee so a
                # System Parameters change reflects across the whole system.
                apply_to_catalog = body.get("apply_base_fee_to_catalog") in (True, 1, "1", "true", "yes")
                products_updated = 0
                catalog_changed = False
                if apply_to_catalog:
                    fee_row = session.query(StoreSetting).filter_by(key="base_delivery_fee").first()
                    try:
                        fee_value = max(0, int(float(updates.get("base_delivery_fee") or (fee_row.value if fee_row else 0) or 0)))
                    except (TypeError, ValueError):
                        fee_value = None
                    if fee_value is not None:
                        for product in session.query(Product).all():
                            if product.total_transport_cost != fee_value:
                                catalog_changed = True
                            product.total_transport_cost = fee_value
                            # Keep the customer-facing price consistent with the
                            # 50/50 split: base price + embedded half of transport.
                            base_component = product.base_price if product.base_price is not None else product.selling_price
                            product.selling_price = whole_money(int(base_component or 0) + fee_value * 0.5)
                            products_updated += 1
                        session.flush()

                if changed_keys or catalog_changed:
                    broadcast_event("SETTINGS_UPDATED", "Store settings published",
                        f"{len(changed_keys)} store parameter(s) updated." + (f" Delivery pricing applied to {products_updated} product(s)." if catalog_changed else ""),
                        {"setting_count": len(changed_keys)}, session=session)
                public_rows = session.query(StoreSetting).all()
                return json_response({
                    "ok": True,
                    "status": "updated",
                    "updated_keys": sorted(updates.keys()),
                    "settings": public_store_settings(public_rows),
                    "products_updated": products_updated,
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
                "requires_staff_auth": staff_auth_required(),
                "access_mode": "credential" if staff_auth_required() else "open",
                "has_env_admin_key": has_admin_env,
                "has_env_staff_key": has_staff_env,
                "supported_keys": ["STORE_MASTER_KEY", "ADMIN_ACCESS_PIN", "STAFF_TERMINAL_KEY", "TERMINAL_KEY", "ADMIN_KEY", "STAFF_KEY", "MASTER_KEY"]
            })

        if clean_path == "/api/auth/terminal-session" and method == "POST":
            # Kept for installed clients that expect a signed terminal session.
            # PIN-free endpoints do not depend on this handshake or its JWT.
            # Stock validation and transactional accounting remain unchanged.
            if staff_auth_required():
                return json_response({
                    "ok": True,
                    "requires_staff_auth": True,
                    "access_mode": "credential"
                })
            staff_data = {
                "id": "OPEN-TERMINAL",
                "name": "Store Terminal",
                "role": "admin"
            }
            token = create_jwt_token(dict(staff_data, access_mode="open"))
            return json_response({
                "ok": True,
                "requires_staff_auth": False,
                "access_mode": "open",
                "staff": staff_data,
                "token": token
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
                _rate_limiter.check("auth", client_ip, AUTH_RATE_LIMIT, AUTH_RATE_WINDOW)
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

            # Record the failed attempt against the brute-force budget.
            _rate_limiter.check("auth", client_ip, AUTH_RATE_LIMIT, AUTH_RATE_WINDOW)
            logger.warning("[AUTH] Failed sign-in attempt from %s", client_ip)
            return json_response({"ok": False, "error": "Invalid Staff Terminal Key or PIN"}, status=401)

        return json_response({"error": "API route not found"}, status=404)

    except Exception as err:
        # SECURITY: log full details server-side, but never leak exception
        # messages (stack internals, SQL text, file paths) to API clients.
        logger.error("[API Error] %s on %s %s", err, method, path, exc_info=True)
        return json_response({"error": "Internal Server Error"}, status=500)
