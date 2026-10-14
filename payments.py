"""
Adonai Store — Flutterwave v3 Payment Gateway Client
============================================================================
Server-side integration with Flutterwave (https://flutterwave.com) for the
web storefront. The storefront opens the Flutterwave *Inline* checkout popup
with nothing more than the PUBLIC key; every charge is settled and trusted
ONLY after this module re-verifies the transaction with the SECRET key.

Trust model (never violate):
  * Amounts always come from the server-side Order row — never the browser.
  * A payment is only marked paid after GET /v3/transactions/{id}/verify
    confirms: status == successful, currency matches, amount >= order total,
    and the tx_ref belongs to the order being settled.
  * Webhooks are authenticated with the `verif-hash` header and are also
    re-verified against the API — webhook payloads alone are never trusted.

Environment (see .env.example):
  FLW_PUBLIC_KEY    — Flutterwave public key (used by the browser popup).
                      Also accepted: FLWPUBK / FLWPUBK_TEST / FLWPUBK_LIVE.
  FLW_SECRET_KEY    — Flutterwave secret key (server only, never exposed).
                      Also accepted: FLWSECK / FLWSECK_TEST / FLWSECK_LIVE.
  FLW_SECRET_HASH   — Webhook verification hash configured in the dashboard.
  FLW_BASE_URL      — API base, default https://api.flutterwave.com.
  FLW_CURRENCY      — Charge currency, default UGX.
  FLW_PAYMENT_TTL_MINUTES — How long an unpaid order holds stock, default 30.
  FLW_MOCK_MODE=1   — DEV ONLY. When no secret key is set, simulate a gateway
                      so the full flow can be exercised locally.
============================================================================
"""
import hashlib
import hmac as hmac_module
import json
import logging
import os
import secrets
import time
import urllib.error
import urllib.request
import uuid

logger = logging.getLogger("adonai.payments")

PROVIDER = "flutterwave"

# ============================================================================
# Payment channels
# ============================================================================
# Every non-cash web order still reserves stock up front, but the *way* the
# shopper settles decides who confirms the money landed:
#
#   card      — Flutterwave popup (card / wallet). Confirmed by the gateway,
#               re-verified server-side. Books: 1020 Bank Account.
#   momo      — shopper sends mobile money straight to the store's merchant
#               line, then submits the transaction id. Confirmed by staff.
#               Books: 1010 Mobile Money.
#   bank      — shopper pays into the store bank account and submits the
#               reference. Confirmed by staff. Books: 1020 Bank Account.
#   merchant  — the system issues a per-order MERCHANT PAY CODE that the
#               shopper (or whoever is paying for them) presents at any
#               Adonai merchant point / agent. Confirmed by staff.
#               Books: 1010 Mobile Money.
#   cod       — pay on delivery / pickup. Untouched legacy behaviour.
#
# `card` and `momo` can both be collected by the gateway. For mobile money that
# is the *instant* path: the shopper types the paying number, the network pushes
# the approval prompt to their phone, they confirm it with their own MoMo PIN,
# and the gateway tells this server the money landed — no staff step. The bank
# and merchant channels are honest about what they are: instructions + a
# reference trail + a staff confirmation step. The browser can submit a *claim*,
# never a settlement.
CHANNEL_CATALOG = {
    "card": {
        "id": "card", "label": "Card & wallet", "short": "Card",
        "blurb": "Visa / Mastercard and mobile-wallet checkout.",
        "tender_type": "flutterwave", "needs_gateway": True,
        "pay_prompt": False, "issues_code": False,
    },
    "momo": {
        "id": "momo", "label": "Mobile Money (MTN / Airtel)", "short": "Mobile Money",
        "blurb": "Approve the prompt on your phone with your MoMo PIN, or send the total to our merchant line.",
        "tender_type": "mobile_money", "needs_gateway": False,
        "pay_prompt": True, "issues_code": False,
    },
    "bank": {
        "id": "bank", "label": "Bank transfer", "short": "Bank",
        "blurb": "Transfer to our store account and submit the reference.",
        "tender_type": "bank_transfer", "needs_gateway": False,
        "pay_prompt": False, "issues_code": False,
    },
    "merchant": {
        "id": "merchant", "label": "Merchant pay code", "short": "Pay code",
        "blurb": "Get a code to pay at any Adonai merchant point, or send to whoever is paying for you.",
        "tender_type": "merchant_code", "needs_gateway": False,
        "pay_prompt": True, "issues_code": True,
    },
    "cod": {
        "id": "cod", "label": "Pay on delivery / pickup", "short": "On delivery",
        "blurb": "Pay the rider or at the counter when your piece arrives.",
        "tender_type": None, "needs_gateway": False,
        "pay_prompt": False, "issues_code": False,
    },
}

# Channels a gateway collection can settle. `card` is charged on the card rail;
# `momo` is collected on the mobile-money rail (push prompt + PIN on the phone).
GATEWAY_CHANNELS = {
    "card": {"payment_options": "mobilemoneyuganda,card", "label": "Card / wallet"},
    "momo": {"payment_options": "mobilemoneyuganda", "label": "Mobile money"},
}


def gateway_payment_options(channel) -> str:
    """Popup payment options for a gateway-collected channel ('' when it cannot)."""
    info = GATEWAY_CHANNELS.get(str(channel or "").strip().lower())
    return info["payment_options"] if info else ""


def is_gateway_collectable(channel) -> bool:
    """True when the gateway can take this channel's money and confirm it."""
    return str(channel or "").strip().lower() in GATEWAY_CHANNELS


# What a shopper may pick at checkout. `cod` is always offered.
ONLINE_CHANNELS = ("card", "momo", "bank", "merchant")

# Values clients have historically posted for the same idea.
CHANNEL_ALIASES = {
    "flutterwave": "card", "online": "card", "visa": "card", "mastercard": "card",
    "mobile_money": "momo", "mobilemoneyuganda": "momo", "mtn": "momo", "airtel": "momo",
    "bank_transfer": "bank", "transfer": "bank", "banktransfer": "bank",
    "merchant_code": "merchant", "pay_code": "merchant", "paycode": "merchant", "code": "merchant",
    "cash": "cod", "delivery": "cod", "pickup": "cod", "pod": "cod",
}


def normalize_channel(value, default="cod") -> str:
    """Map whatever a client called the payment method onto a real channel."""
    key = str(value or "").strip().lower().replace("-", "_").replace(" ", "_")
    if not key:
        return default
    if key in CHANNEL_CATALOG:
        return key
    return CHANNEL_ALIASES.get(key, default)


def channel_info(channel) -> dict:
    return CHANNEL_CATALOG.get(normalize_channel(channel), CHANNEL_CATALOG["cod"])


def is_online_channel(channel) -> bool:
    """True when the shopper must settle now (not pay on delivery)."""
    return normalize_channel(channel) in ONLINE_CHANNELS


def channel_tender_type(channel) -> str:
    """Ledger tender for the channel that actually receives the money."""
    info = channel_info(channel)
    return info["tender_type"] or "cash"


# ---------------------------------------------------------------- pay codes
# Crockford-style alphabet: no O/0 or I/1, so a code read aloud on a phone
# call cannot be mistyped into a different valid-looking code.
PAY_CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"


def make_merchant_pay_code() -> str:
    """Human-readable per-order merchant pay code, e.g. ADN-7K4P2Q."""
    body = "".join(secrets.choice(PAY_CODE_ALPHABET) for _ in range(6))
    return f"ADN-{body}"


def normalize_pay_code(value) -> str:
    """Accept 'adn 7k4p2q' / 'ADN-7K4P2Q' and return the canonical form.

    Only alphabet characters survive, so separators, spacing and casing can
    never change which code is being looked up. Characters outside the
    alphabet are dropped rather than guessed at — a code is either right or
    it is not the customer's code.
    """
    raw = "".join(ch for ch in str(value or "").upper() if ch in PAY_CODE_ALPHABET)
    if len(raw) > 6:
        # A pasted "ADN7K4P2Q" keeps the six code characters after the mark.
        raw = raw[3:] if raw.startswith("ADN") else raw[-6:]
    return f"ADN-{raw}" if len(raw) == 6 else ""


# ------------------------------------------------------- offline lifetime
# Card checkout may complete in minutes. An offline transfer needs room: the
# shopper may be queueing at a bank or sending money from upcountry. Stock is
# still protected, because the pieces are released when this window lapses.
def offline_ttl_minutes() -> int:
    try:
        return max(PAYMENT_TTL_MINUTES, min(24 * 60, int(os.environ.get("ADONAI_OFFLINE_PAYMENT_TTL_MINUTES", "180"))))
    except ValueError:
        return max(PAYMENT_TTL_MINUTES, 180)


def channel_ttl_minutes(channel) -> int:
    return PAYMENT_TTL_MINUTES if normalize_channel(channel) == "card" else offline_ttl_minutes()


def _first_env(*names: str) -> tuple[str, str]:
    """Return (name, value) of the first environment variable that is set."""
    for name in names:
        value = (os.environ.get(name) or "").strip()
        if value:
            return name, value
    return "", ""


def _normalize_key(env_name: str, value: str, kind: str) -> str:
    """
    Reconstruct the full Flutterwave key format when operators paste only the
    token body. Dashboard keys look like FLWPUBK_TEST-xxxx-X / FLWSECK-xxxx-XXX;
    the Inline popup and the API both accept the canonical prefixed form.
    """
    upper = value.upper()
    if upper.startswith(("FLWPUBK", "FLWSECK")):
        return value
    if "_TEST" in env_name.upper():
        return f"FLWPUBK_TEST-{value}" if kind == "public" else f"FLWSECK_TEST-{value}"
    if "_LIVE" in env_name.upper():
        return f"FLWPUBK_LIVE-{value}" if kind == "public" else f"FLWSECK_LIVE-{value}"
    return value


_pub_name, _pub_raw = _first_env("FLW_PUBLIC_KEY", "FLWPUBK", "FLWPUBK_TEST", "FLWPUBK_LIVE")
_sec_name, _sec_raw = _first_env("FLW_SECRET_KEY", "FLWSECK", "FLWSECK_TEST", "FLWSECK_LIVE")
FLW_PUBLIC_KEY = _normalize_key(_pub_name, _pub_raw, "public")
FLW_SECRET_KEY = _normalize_key(_sec_name, _sec_raw, "secret")
FLW_SECRET_HASH = (os.environ.get("FLW_SECRET_HASH") or "").strip()
FLW_BASE_URL = (os.environ.get("FLW_BASE_URL") or "https://api.flutterwave.com").strip().rstrip("/")
FLW_CURRENCY = (os.environ.get("FLW_CURRENCY") or "UGX").strip().upper() or "UGX"

try:
    PAYMENT_TTL_MINUTES = max(5, int(os.environ.get("FLW_PAYMENT_TTL_MINUTES", "30")))
except ValueError:
    PAYMENT_TTL_MINUTES = 30

# Mock/dev mode: usable only when there is NO real secret key configured, so
# a deployed store can never silently fall into a fake-payment state.
MOCK_MODE = (os.environ.get("FLW_MOCK_MODE") or "") == "1" and not FLW_SECRET_KEY

HTTP_TIMEOUT_SECONDS = 20


def is_enabled() -> bool:
    """Online payment is offered when the gateway is fully configured (or dev-mocked)."""
    return is_configured() or MOCK_MODE


def is_configured() -> bool:
    return bool(FLW_PUBLIC_KEY and FLW_SECRET_KEY)


def public_checkout_config() -> dict:
    """Nothing secret. Returned to the storefront so it can open the popup."""
    return {
        "enabled": is_enabled(),
        "provider": PROVIDER,
        "public_key": FLW_PUBLIC_KEY if is_configured() else ("" if not MOCK_MODE else "FLWPUBK-MOCK-DEV-ONLY"),
        "currency": FLW_CURRENCY,
        "payment_window_minutes": PAYMENT_TTL_MINUTES,
        "offline_window_minutes": offline_ttl_minutes(),
        "mock": MOCK_MODE,
        # Static channel metadata. Whether a channel can actually be used also
        # depends on the store's published pay-to details, which api.py folds
        # in before answering the storefront.
        "channels": [
            {key: info[key] for key in ("id", "label", "short", "blurb", "needs_gateway", "pay_prompt", "issues_code")}
            for info in (CHANNEL_CATALOG[key] for key in ("card", "momo", "bank", "merchant", "cod"))
        ],
    }


def new_payment_token() -> str:
    """Per-order bearer token that authorizes payment actions for one order."""
    return uuid.uuid4().hex + uuid.uuid4().hex


def hash_payment_token(token: str) -> str:
    return hashlib.sha256(str(token or "").encode("utf-8")).hexdigest()


def payment_token_matches(stored_hash: str, supplied_token: str) -> bool:
    if not stored_hash or not supplied_token:
        return False
    return hmac_module.compare_digest(stored_hash, hash_payment_token(supplied_token))


def make_tx_ref(order_id: str) -> str:
    """
    Unique reference for one payment ATTEMPT. Flutterwave requires a fresh
    tx_ref for each retry, and (like every string heading to the gateway) it
    must stay short and strictly alphanumeric/dash.
    """
    safe_order = "".join(ch for ch in str(order_id) if ch.isalnum() or ch == "-")[:40]
    return f"ATFLW-{safe_order}-{int(time.time() * 1000) % 100000}-{uuid.uuid4().hex[:6]}"[:100]


def verify_webhook_hash(headers: dict) -> bool:
    """
    Authenticate an incoming webhook. The Flutterwave dashboard lets you set a
    secret hash; every webhook then carries it in the `verif-hash` header.
    """
    if not FLW_SECRET_HASH:
        return False
    supplied = ""
    for name, value in (headers or {}).items():
        if str(name).lower() == "verif-hash":
            supplied = str(value or "")
            break
    return bool(supplied) and hmac_module.compare_digest(FLW_SECRET_HASH, supplied)


class FlutterwaveApiError(Exception):
    """Raised when the gateway cannot be reached or answers unexpectedly."""


def _api_request(path: str, method: str = "GET", payload: dict = None) -> dict:
    if not FLW_SECRET_KEY:
        raise FlutterwaveApiError("Flutterwave secret key is not configured")
    url = f"{FLW_BASE_URL}{path}"
    body = json.dumps(payload).encode("utf-8") if payload is not None else None
    request = urllib.request.Request(
        url,
        data=body,
        method=method,
        headers={
            "Authorization": f"Bearer {FLW_SECRET_KEY}",
            "Content-Type": "application/json",
            "Accept": "application/json",
            "User-Agent": "AdonaiStore/1.0 (+flutterwave-v3)",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=HTTP_TIMEOUT_SECONDS) as response:
            return json.loads(response.read().decode("utf-8") or "{}")
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")[:500]
        logger.warning("Flutterwave API %s %s -> HTTP %s: %s", method, path, exc.code, detail)
        raise FlutterwaveApiError(f"Flutterwave answered HTTP {exc.code}")
    except (urllib.error.URLError, TimeoutError, ValueError) as exc:
        logger.warning("Flutterwave API %s %s failed: %s", method, path, exc)
        raise FlutterwaveApiError("Could not reach Flutterwave — please try again")


def verify_transaction(transaction_id) -> dict:
    """
    Re-verify a charge with the secret key. Returns a normalized dict:
      {ok, flw_id, status, amount, currency, tx_ref, payment_type, customer, charged_amount}
    Only `ok` settlements may ever mark an order paid.
    """
    safe_id = "".join(ch for ch in str(transaction_id or "") if ch.isdigit())
    if not safe_id:
        raise FlutterwaveApiError("A numeric Flutterwave transaction id is required")

    if MOCK_MODE:
        # Dev mode: pretend the gateway confirms whatever the local popup said.
        return {
            "ok": True,
            "flw_id": int(safe_id),
            "status": "successful",
            "amount": None,  # caller treats None as "not supplied" — must still pass its own checks
            "currency": FLW_CURRENCY,
            "tx_ref": None,
            "payment_type": "mock",
            "charged_amount": None,
            "raw": {"mock": True},
        }

    response = _api_request(f"/v3/transactions/{safe_id}/verify")
    data = response.get("data") or {}
    return {
        "ok": (
            str(response.get("status", "")).lower() == "success"
            and str(data.get("status", "")).lower() == "successful"
        ),
        "flw_id": data.get("id"),
        "status": str(data.get("status") or ""),
        "amount": data.get("amount"),
        "charged_amount": data.get("charged_amount"),
        "currency": str(data.get("currency") or ""),
        "tx_ref": str(data.get("tx_ref") or ""),
        "payment_type": str(data.get("payment_type") or data.get("auth_model") or ""),
        "raw": {
            "id": data.get("id"),
            "tx_ref": data.get("tx_ref"),
            "flw_ref": data.get("flw_ref"),
            "status": data.get("status"),
            "amount": data.get("amount"),
            "currency": data.get("currency"),
            "payment_type": data.get("payment_type"),
        },
    }


def transaction_summary(verified: dict, limit: int = 1500) -> str:
    """Compact JSON audit snapshot stored on the payment attempt row."""
    try:
        return json.dumps(verified.get("raw") or {}, default=str)[:limit]
    except (TypeError, ValueError):
        return "{}"
