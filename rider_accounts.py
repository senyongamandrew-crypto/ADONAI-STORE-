"""Adonai Delivery accounts: sign-up / sign-in, daily attendance, and linking.

Order of operations for a delivery partner (enforced server-side):

  1. Sign up or sign in with phone + password        -> account token
  2. Daily attendance: a selfie and a drawn signature -> one record per Kampala day
  3. Connection code from dispatch                    -> links the account to the
                                                         roster rider and issues the
                                                         device token that job routes use

A new account grants no jobs. Jobs are reachable only after the code links the
account to a roster rider, and accepting a job requires today's attendance.
Images are validated by their magic bytes and size limits, never trusted by MIME.
"""
import base64
import binascii
import re
import secrets
from datetime import timedelta

from database import get_db
from media import MediaResponse
from models import (
    Rider, RiderAccount, RiderAccountSession, RiderAttendance, RiderDevice, RiderPairing,
)
from security import hash_pin, verify_pin
import dispatch
from dispatch import DispatchError, fail, iso, kampala_day, now, notify_rider, response, text, uid, digest

ACCOUNT_LIFE = timedelta(days=30)
SELFIE_MAX_BYTES = 300 * 1024
SIGNATURE_MAX_BYTES = 120 * 1024
SELFIE_TYPES = {"jpeg", "png"}
SIGNATURE_TYPES = {"png"}
MAGIC = {"jpeg": b"\xff\xd8\xff", "png": b"\x89PNG\r\n\x1a\n"}
TOKEN_RE = re.compile(r"[A-Za-z0-9_-]{43}")
DEFAULT_CONTENT = {"Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer"}


def normalize_phone(value):
    digits = re.sub(r"\D", "", str(value or ""))
    if len(digits) == 10 and digits.startswith("0"):
        digits = "256" + digits[1:]
    if not re.fullmatch(r"2567\d{8}", digits):
        fail("Enter a valid Ugandan mobile number, for example 0772 123 456.", 400, "PHONE_INVALID")
    return digits


def _account_dict(account):
    return {"id": account.id, "name": account.name, "phone": account.phone,
            "linked": bool(account.rider_id), "rider_id": account.rider_id or ""}


def _attendance_dict(row):
    return {"id": row.id, "day": row.day, "taken_at": iso(row.taken_at), "signed": True,
            "selfie_type": row.selfie_type}


def _issue_session(session, account):
    token = secrets.token_urlsafe(32)
    expires = now() + ACCOUNT_LIFE
    session.add(RiderAccountSession(token_hash=digest(token), account_id=account.id,
                                    expires_at=expires, created_at=now()))
    session.flush()
    return {"session_token": token, "account": _account_dict(account), "expires_at": iso(expires)}


def account_from_request(session, headers):
    authorization = next((str(v) for k, v in (headers or {}).items() if k.lower() == "authorization"), "")
    token = authorization[7:] if authorization.startswith("Bearer ") else ""
    if not TOKEN_RE.fullmatch(token):
        fail("Sign in to your Adonai Delivery account.", 401, "SIGN_IN_REQUIRED")
    row = session.query(RiderAccountSession).filter_by(token_hash=digest(token)).first()
    if not row or row.expires_at <= now():
        fail("Your sign-in expired. Sign in again.", 401, "SIGN_IN_REQUIRED")
    account = session.get(RiderAccount, row.account_id)
    if not account or not account.active:
        fail("This account is no longer active. Contact dispatch.", 401, "SIGN_IN_REQUIRED")
    return account, row


def attendance_today(session, account):
    return session.query(RiderAttendance).filter_by(account_id=account.id, day=kampala_day()).first()


def signup(session, body):
    name = text(body.get("name", ""), 100, "Full name", True)
    if len(name) < 2:
        fail("Enter your full name.")
    phone = normalize_phone(body.get("phone"))
    password = str(body.get("password", ""))
    if not 8 <= len(password) <= 128:
        fail("Choose a password of at least 8 characters.", 400, "PASSWORD_INVALID")
    if session.query(RiderAccount).filter_by(phone=phone).first():
        fail("An account with this phone number already exists. Sign in instead.", 409, "ACCOUNT_EXISTS")
    account = RiderAccount(id=uid("RAC"), phone=phone, name=name, password_hash=hash_pin(password),
                           active=True, created_at=now())
    session.add(account)
    session.flush()
    return response({"ok": True, **_issue_session(session, account)}, 201)


def login(session, body):
    try:
        phone = normalize_phone(body.get("phone"))
    except DispatchError:
        phone = ""
    password = str(body.get("password", ""))
    account = session.query(RiderAccount).filter_by(phone=phone).first() if phone else None
    if not account or not account.active or not verify_pin(password, account.password_hash):
        fail("Phone number or password is not correct.", 401, "BAD_CREDENTIALS")
    return response({"ok": True, **_issue_session(session, account)})


def me(session, headers):
    account, _ = account_from_request(session, headers)
    row = attendance_today(session, account)
    return response({"ok": True, "account": _account_dict(account), "day": kampala_day(),
                     "attendance": _attendance_dict(row) if row else None})


def logout(session, headers):
    account, row = account_from_request(session, headers)
    session.delete(row)
    device = session.query(RiderDevice).filter_by(rider_id=account.rider_id).first() if account.rider_id else None
    if device:
        device.revoked = True
        device.sharing = False
        device.duty_until = None
    return response({"ok": True})


def decode_image(value, allowed_types, maximum, label):
    if not isinstance(value, str) or not value.startswith("data:image/"):
        fail(f"The {label} picture is missing. Take it again.", 400, "IMAGE_INVALID")
    head, _, payload = value.partition(",")
    if not head.endswith(";base64"):
        fail(f"The {label} picture is not in a supported format.", 400, "IMAGE_INVALID")
    kind = head[len("data:image/"):-len(";base64")]
    if kind not in allowed_types:
        fail(f"The {label} picture is not in a supported format.", 400, "IMAGE_INVALID")
    try:
        raw = base64.b64decode(payload, validate=True)
    except (binascii.Error, ValueError):
        fail(f"The {label} picture could not be read. Take it again.", 400, "IMAGE_INVALID")
    if not raw or len(raw) > maximum:
        fail(f"The {label} picture is too large. Try again.", 413, "IMAGE_TOO_LARGE")
    if not raw.startswith(MAGIC[kind]):
        fail(f"The {label} picture does not match its format. Take it again.", 400, "IMAGE_INVALID")
    return kind, raw


def check_in(session, account, body):
    if body.get("consent") is not True:
        fail("Confirm that this selfie and signature are your attendance for today.", 400, "CONSENT_REQUIRED")
    selfie_kind, selfie = decode_image(body.get("selfie"), SELFIE_TYPES, SELFIE_MAX_BYTES, "selfie")
    sig_kind, signature = decode_image(body.get("signature"), SIGNATURE_TYPES, SIGNATURE_MAX_BYTES, "signature")
    existing = attendance_today(session, account)
    if existing:
        return response({"ok": True, "already": True, "attendance": _attendance_dict(existing)})
    row = RiderAttendance(id=uid("ATT"), account_id=account.id, rider_id=account.rider_id,
                          day=kampala_day(), taken_at=now(), selfie_type=selfie_kind, selfie=selfie,
                          signature_type=sig_kind, signature=signature,
                          device_label=text(body.get("device_label", "Adonai Delivery phone"), 100, "Device label"))
    session.add(row)
    session.flush()
    return response({"ok": True, "already": False, "attendance": _attendance_dict(row)}, 201)


def connect(session, account, body, staff_required):
    if not attendance_today(session, account):
        fail("Check in for today first: take your selfie and sign.", 409, "ATTENDANCE_REQUIRED")
    code = re.sub(r"[\s-]", "", str(body.get("code", ""))).upper()
    if not re.fullmatch(r"[A-Z2-7]{10}", code):
        fail("That connection code is not valid. Ask dispatch for a fresh one.", 403)
    pairing = session.query(RiderPairing).filter_by(code_hash=digest(code)).with_for_update().first()
    if not pairing or pairing.expires_at <= now():
        fail("That connection code expired. Ask dispatch for a fresh one.", 403)
    rider = dispatch.rider_by_id(session, pairing.rider_id, True)
    if account.rider_id and account.rider_id != rider.id:
        fail("This account is already linked to a different rider profile. Ask dispatch.", 409, "ACCOUNT_LINKED")
    other = session.query(RiderAccount).filter(RiderAccount.rider_id == rider.id,
                                               RiderAccount.id != account.id).first()
    if other:
        fail("This rider profile is already linked to another account. Ask dispatch to reset it.",
             409, "PROFILE_LINKED")
    label = text(body.get("device_label", "Adonai Delivery phone"), 100, "Phone label", True)
    account.rider_id = rider.id
    today = attendance_today(session, account)
    if today:
        today.rider_id = rider.id
    device = session.query(RiderDevice).filter_by(rider_id=rider.id).with_for_update().first()
    token = secrets.token_urlsafe(32)
    if not device:
        device = RiderDevice(id=uid("RDP"), rider_id=rider.id)
        session.add(device)
    device.label = label
    device.token_hash = digest(token)
    device.expires_at = now() + dispatch.SESSION_LIFE
    device.revoked = False
    device.sharing = False
    device.duty_until = None
    device.latitude = device.longitude = device.accuracy = None
    device.fix_at = device.received_at = None
    device.sequence = 0
    device.paired_at = now()
    session.delete(pairing)
    session.flush()
    notify_rider(session, "DELIVERY_APP_CONNECTED", "Delivery app connected",
                 f"{rider.name} signed in to the Adonai Delivery app. Location sharing stays off until a duty starts.",
                 rider)
    return response({"ok": True, "session_token": token, "rider": rider.to_dict(),
                     "device_id": device.id, "expires_at": iso(device.expires_at),
                     "gps_policy": dispatch.policy_active(session, staff_required),
                     "demo": dispatch.demo_mode()}, 201)


def dispatch_attendance(session):
    """Today's check-ins for dispatch. Staff-only (the /api/dispatch/ guard applies)."""
    rows = session.query(RiderAttendance).filter_by(day=kampala_day()).order_by(RiderAttendance.taken_at).all()
    out = []
    for row in rows:
        account = session.get(RiderAccount, row.account_id)
        rider = session.get(Rider, row.rider_id) if row.rider_id else None
        out.append({"id": row.id, "name": account.name if account else "Rider", "phone": account.phone if account else "",
                    "rider_id": row.rider_id or "", "rider_name": rider.name if rider else "",
                    "taken_at": iso(row.taken_at), "device_label": row.device_label or "",
                    "selfie_url": f"/api/dispatch/attendance/{row.id}/selfie",
                    "signature_url": f"/api/dispatch/attendance/{row.id}/signature"})
    return response({"ok": True, "day": kampala_day(), "attendance": out})


def dispatch_image(session, attendance_id, which):
    row = session.get(RiderAttendance, attendance_id)
    if not row or row.day != kampala_day():
        fail("That attendance record was not found for today.", 404)
    if which == "selfie":
        kind, data = row.selfie_type, row.selfie
    else:
        kind, data = row.signature_type, row.signature
    return MediaResponse(200, f"image/{kind}", bytes(data), dict(DEFAULT_CONTENT))


def route_request(method, path, body, headers, staff_required=False):
    try:
        with get_db() as session:
            if path == "/api/rider-account/signup" and method == "POST":
                return signup(session, body)
            if path == "/api/rider-account/login" and method == "POST":
                return login(session, body)
            if path == "/api/rider-account/me" and method == "GET":
                return me(session, headers)
            if path == "/api/rider-account/logout" and method == "POST":
                return logout(session, headers)
            if path == "/api/rider-account/attendance" and method == "POST":
                account, _ = account_from_request(session, headers)
                return check_in(session, account, body)
            if path == "/api/rider-account/connect" and method == "POST":
                account, _ = account_from_request(session, headers)
                return connect(session, account, body, staff_required)
            return response({"ok": False, "error": "Account route not found."}, 404)
    except DispatchError as error:
        return response({"ok": False, "error": str(error), "code": error.code}, error.status)
