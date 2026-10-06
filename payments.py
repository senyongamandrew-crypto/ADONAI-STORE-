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
import time
import urllib.error
import urllib.request
import uuid

logger = logging.getLogger("adonai.payments")

PROVIDER = "flutterwave"


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
        "mock": MOCK_MODE,
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
