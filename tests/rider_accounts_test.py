"""Adonai Delivery rider accounts: sign-up/sign-in, daily selfie + signature
check-in, connection-code linking, and the check-in gate on accepting jobs.
Runs against a temporary SQLite database only."""
import base64
import hashlib
import json
import os
import sys
import tempfile
import unittest
from datetime import datetime, timedelta
from pathlib import Path
from unittest import mock
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
_TEMP = tempfile.TemporaryDirectory(prefix="adonai-rider-accounts-tests-")
os.environ.update({
    "DATABASE_URL": "sqlite:///" + str(Path(_TEMP.name) / "rider_accounts.db"),
    "ADONAI_REQUIRE_STAFF_AUTH": "0",
    "ADONAI_RATE_LIMIT_DISABLED": "1",
    "ADONAI_SEED_DEMO_CATALOG": "0",
    "ADONAI_SEED_DEMO_USERS": "0",
    "ADONAI_DELIVERY_DEMO": "0",
})
import database  # noqa: E402

database.IS_POSTGRES = False
from database import Base, engine, get_db  # noqa: E402
from models import (  # noqa: E402
    DeliveryEvent, LedgerEntry, NotificationEvent, Order, OrderItem, PosAccessKey, PosAccessSession,
    Rider, RiderAccount, RiderAccountSession, RiderAttendance, RiderDevice, RiderPairing, StoreSetting,
)
import access_control  # noqa: E402
import api  # noqa: E402
import dispatch  # noqa: E402
import rider_accounts  # noqa: E402

ADMIN_TOKEN = "A" * 43
HEADERS = {"X-Pos-Access": ADMIN_TOKEN}
JPEG = b"\xff\xd8\xff\xe0" + b"\x00" * 400
PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 400
KAMPALA = ZoneInfo("Africa/Kampala")


def data_url(kind, raw):
    return f"data:image/{kind};base64," + base64.b64encode(raw).decode()


def result_text(payload):
    return json.dumps(payload)


def kampala_today():
    return datetime.now(KAMPALA).strftime("%Y-%m-%d")


class RiderAccountTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        Base.metadata.create_all(engine)

    def setUp(self):
        with get_db() as s:
            for model in [RiderAttendance, RiderAccountSession, RiderAccount, DeliveryEvent, RiderPairing,
                          RiderDevice, OrderItem, Order, Rider, LedgerEntry, PosAccessSession, PosAccessKey,
                          StoreSetting, NotificationEvent]:
                s.query(model).delete(synchronize_session=False)
            s.add(Rider(id="R1", name="Kato Brian", phone="0772555010", vehicle="Motorbike", zone="Kampala", archived=False))
            s.add(Rider(id="R2", name="Other rider", phone="0700111333", archived=False))
        self.protect()

    # ---------------------------------------------------------------- helpers
    def protect(self):
        with get_db() as s:
            s.add(StoreSetting(key=access_control.POLICY_KEY, value='["orders"]'))
            s.add(PosAccessKey(id="OWNER", name="Owner", password_hash="unused", is_admin=True, enabled=True, version=1, areas="[]"))
            s.add(PosAccessSession(token_hash=hashlib.sha256(ADMIN_TOKEN.encode()).hexdigest(), key_id="OWNER",
                                   key_version=1, expires_at=datetime.utcnow() + timedelta(hours=1)))

    def raw(self, method, path, body=None, headers=None):
        return api.handle_api_request(method, path, {}, json.dumps(body).encode() if body is not None else b"",
                                      headers or {}, "rider-accounts-test")

    def call(self, method, path, body=None, headers=None, status=200):
        result = self.raw(method, path, body, headers)
        self.assertEqual(result[0], status, result[2])
        return json.loads(result[2])

    def bearer(self, token):
        return {"Authorization": "Bearer " + token}

    def signup(self, phone="0772 123 456", password="correct-horse", name="Sarah Rider"):
        return self.call("POST", "/api/rider-account/signup", {"name": name, "phone": phone, "password": password}, status=201)

    def check_in(self, token, status=201, **overrides):
        body = {"consent": True, "selfie": data_url("jpeg", JPEG), "signature": data_url("png", PNG),
                "device_label": "Test phone"}
        body.update(overrides)
        return self.call("POST", "/api/rider-account/attendance", body, self.bearer(token), status=status)

    def app_code(self, rider="R1"):
        return self.call("POST", f"/api/dispatch/riders/{rider}/app-code", {}, HEADERS, status=201)["code"]

    def connect(self, token, code, status=201):
        return self.call("POST", "/api/rider-account/connect", {"code": code, "device_label": "Test phone"},
                         self.bearer(token), status=status)

    def onboard(self, rider="R1", phone="0772 123 456", name="Sarah Rider"):
        """Sign up, check in and link to a roster rider. Returns (account token, device token, data)."""
        account = self.signup(phone=phone, name=name)
        token = account["session_token"]
        self.check_in(token)
        linked = self.connect(token, self.app_code(rider))
        return token, linked["session_token"], linked

    def device(self, token):
        return self.bearer(token)

    def add_order(self, order_id, rider_id, dispatch_status="Dispatched"):
        with get_db() as s:
            order = Order(id=order_id, channel="web", status="processing", dispatch_status=dispatch_status,
                          payment_status="paid", customer_name="Sarah Nansubuga", customer_phone="+256772123456",
                          customer_address="Plot 12 Kololo", subtotal=20000, total=25000, delivery_fee=5000,
                          delivery_type="boda", rider_id=rider_id)
            order.items = [OrderItem(id="IT-" + order_id, name="Denim jacket", qty=1, unit_price=20000,
                                     unit_cost=5000, line_total=20000)]
            s.add(order)

    def accept(self, device_token, order_id, status=200):
        return self.call("POST", f"/api/rider/orders/{order_id}/progress", {"stage": "accepted"},
                         self.device(device_token), status=status)

    # ------------------------------------------------------------------ tests
    def test_phone_numbers_are_normalised_to_2567_format(self):
        for raw in ["0772 123 456", "+256 772-123-456", "256772123456", "0772123456"]:
            self.assertEqual(rider_accounts.normalize_phone(raw), "256772123456", raw)
        for raw in ["772123456", "0312123456", "", "abc"]:
            with self.assertRaises(dispatch.DispatchError, msg=raw):
                rider_accounts.normalize_phone(raw)

    def test_signup_stores_hashed_credentials_and_grants_no_jobs(self):
        data = self.signup()
        self.assertEqual(data["account"]["phone"], "256772123456")
        self.assertFalse(data["account"]["linked"])
        self.assertEqual(len(data["session_token"]), 43)
        self.call("POST", "/api/rider-account/signup", {"name": "Again", "phone": "+256772123456", "password": "another-pass"},
                  status=409)
        self.call("POST", "/api/rider-account/signup", {"name": "Short", "phone": "0700000001", "password": "short"},
                  status=400)
        me = self.call("GET", "/api/rider-account/me", headers=self.bearer(data["session_token"]))
        self.assertIsNone(me["attendance"])
        self.assertFalse(me["account"]["linked"])
        with get_db() as s:
            account = s.query(RiderAccount).one()
            self.assertTrue(account.password_hash.startswith("pbkdf2_sha256$"))
            self.assertNotIn("correct-horse", account.password_hash)
            session_row = s.query(RiderAccountSession).one()
            self.assertEqual(session_row.token_hash, hashlib.sha256(data["session_token"].encode()).hexdigest())
            self.assertNotEqual(session_row.token_hash, data["session_token"])

    def test_sign_in_checks_the_password_and_requires_a_session(self):
        self.signup()
        self.call("POST", "/api/rider-account/login", {"phone": "0772123456", "password": "wrong-pass"}, status=401)
        ok = self.call("POST", "/api/rider-account/login", {"phone": "+256 772 123 456", "password": "correct-horse"})
        self.assertTrue(ok["session_token"])
        self.call("GET", "/api/rider-account/me", status=401)
        self.call("GET", "/api/rider-account/me", headers=self.bearer("Z" * 43), status=401)
        self.call("GET", "/api/rider-account/me", headers=self.bearer(ok["session_token"]))

    def test_daily_check_in_needs_consent_and_valid_images(self):
        token = self.signup()["session_token"]
        self.check_in(token, status=400, consent=False)
        body = self.check_in(token, status=400, selfie=data_url("jpeg", PNG))
        self.assertEqual(body["code"], "IMAGE_INVALID", "selfie bytes must match the declared JPEG type")
        self.check_in(token, status=400, selfie="not-an-image")
        self.check_in(token, status=400, selfie=data_url("gif", JPEG))
        big_selfie = data_url("jpeg", b"\xff\xd8\xff" + b"0" * (300 * 1024))
        self.assertEqual(self.check_in(token, status=413, selfie=big_selfie)["code"], "IMAGE_TOO_LARGE")
        self.check_in(token, status=400, signature=data_url("jpeg", JPEG))
        big_signature = data_url("png", b"\x89PNG\r\n\x1a\n" + b"0" * (120 * 1024))
        self.assertEqual(self.check_in(token, status=413, signature=big_signature)["code"], "IMAGE_TOO_LARGE")

        first = self.check_in(token)
        self.assertFalse(first["already"])
        self.assertEqual(first["attendance"]["day"], kampala_today())
        second = self.check_in(token, status=200)
        self.assertTrue(second["already"], "a second check-in the same day is not stored again")
        with get_db() as s:
            rows = s.query(RiderAttendance).all()
            self.assertEqual(len(rows), 1)
            self.assertEqual(rows[0].selfie_type, "jpeg")
            self.assertEqual(bytes(rows[0].selfie), JPEG)
            self.assertEqual(bytes(rows[0].signature), PNG)
        me = self.call("GET", "/api/rider-account/me", headers=self.bearer(token))
        self.assertEqual(me["attendance"]["day"], kampala_today())

    def test_connection_code_is_only_accepted_after_todays_check_in(self):
        token = self.signup()["session_token"]
        code = self.app_code("R1")
        self.connect(token, code, status=409)  # no check-in yet
        self.check_in(token)
        self.connect(token, "AAAAAAAAAA", status=403)
        linked = self.connect(token, code)
        self.assertEqual(linked["rider"]["id"], "R1")
        self.assertTrue(linked["session_token"])
        self.connect(token, code, status=403)  # single use
        me = self.call("GET", "/api/rider/me", headers=self.bearer(linked["session_token"]))
        self.assertTrue(me["attendance_required"])
        self.assertTrue(me["checked_in_today"])
        self.call("POST", "/api/rider/connect", {"code": code}, status=410)

    def test_expired_connection_code_is_refused(self):
        token = self.signup()["session_token"]
        self.check_in(token)
        code = self.app_code("R1")
        with get_db() as s:
            s.get(RiderPairing, "R1").expires_at = datetime.utcnow() - timedelta(minutes=1)
        self.connect(token, code, status=403)

    def test_one_account_per_roster_rider_and_one_rider_per_account(self):
        self.onboard("R1", phone="0772 123 456")
        other = self.signup(phone="0700 000 999", name="Second Rider")["session_token"]
        self.check_in(other)
        self.connect(other, self.app_code("R1"), status=409)
        first_account = self.call("POST", "/api/rider-account/login", {"phone": "0772123456", "password": "correct-horse"})
        self.connect(first_account["session_token"], self.app_code("R2"), status=409)

    def test_accepting_needs_todays_check_in_for_account_riders(self):
        token, device_token, _ = self.onboard("R1")
        self.add_order("AT-T1", "R1")
        with get_db() as s:
            s.query(RiderAttendance).delete()  # the next Kampala day, no check-in yet
        me = self.call("GET", "/api/rider/me", headers=self.device(device_token))
        self.assertTrue(me["attendance_required"])
        self.assertFalse(me["checked_in_today"])
        self.assertEqual([o["id"] for o in me["orders"]], ["AT-T1"])
        blocked = self.accept(device_token, "AT-T1", status=409)
        self.assertEqual(blocked["code"], "ATTENDANCE_REQUIRED")
        self.check_in(token)
        self.accept(device_token, "AT-T1")
        me = self.call("GET", "/api/rider/me", headers=self.device(device_token))
        self.assertTrue(me["checked_in_today"])

    def test_apk_paired_riders_without_an_account_are_not_gated(self):
        apk_token = "P" * 43
        with get_db() as s:
            s.add(RiderDevice(id="RDP-APK", rider_id="R2", label="APK phone", token_hash=dispatch.digest(apk_token),
                              expires_at=datetime.utcnow() + timedelta(days=1), revoked=False, sharing=False,
                              mock_location=False, sequence=0, paired_at=datetime.utcnow()))
        self.add_order("AT-APK", "R2")
        me = self.call("GET", "/api/rider/me", headers=self.device(apk_token))
        self.assertFalse(me["attendance_required"])
        self.accept(apk_token, "AT-APK")

    def test_a_linked_rider_only_sees_their_own_orders(self):
        _, device_token, _ = self.onboard("R1")
        self.add_order("AT-MINE", "R1")
        self.add_order("AT-OTHERS", "R2")
        me = self.call("GET", "/api/rider/me", headers=self.device(device_token))
        self.assertEqual([o["id"] for o in me["orders"]], ["AT-MINE"])
        self.call("POST", "/api/rider/orders/AT-OTHERS/progress", {"stage": "accepted"}, self.device(device_token), status=404)

    def test_dispatch_sees_todays_attendance_with_images_and_riders_cannot(self):
        token, device_token, _ = self.onboard("R1")
        listing = self.call("GET", "/api/dispatch/attendance", headers=HEADERS)
        self.assertEqual(len(listing["attendance"]), 1)
        row = listing["attendance"][0]
        self.assertEqual(row["name"], "Sarah Rider")
        self.assertEqual(row["rider_name"], "Kato Brian")
        self.assertEqual(row["phone"], "256772123456")
        self.assertNotIn("data:image", result_text(listing), "image bytes are never inlined in the listing")
        selfie = self.raw("GET", row["selfie_url"], headers=HEADERS)
        self.assertEqual(selfie[0], 200)
        self.assertEqual(selfie[1], "image/jpeg")
        self.assertEqual(selfie[2], JPEG)
        signature = self.raw("GET", row["signature_url"], headers=HEADERS)
        self.assertEqual(signature[1], "image/png")
        self.assertEqual(signature[2], PNG)
        for denied in [self.raw("GET", "/api/dispatch/attendance"),
                       self.raw("GET", row["selfie_url"], headers=self.device(device_token))]:
            self.assertIn(denied[0], (401, 403), "dispatch attendance is staff-only")
            self.assertNotIn(b"\xff\xd8\xff", denied[2], "no image bytes leak to unauthenticated or rider callers")

    def test_account_session_expiry_and_logout_revoke_access(self):
        token, device_token, _ = self.onboard("R1")
        self.call("POST", "/api/rider-account/logout", {}, self.bearer(token))
        self.call("GET", "/api/rider-account/me", headers=self.bearer(token), status=401)
        self.call("GET", "/api/rider/me", headers=self.device(device_token), status=401)

        token2 = self.signup(phone="0700 000 111")["session_token"]
        with get_db() as s:
            s.query(RiderAccountSession).update({"expires_at": datetime.utcnow() - timedelta(minutes=1)})
        self.call("GET", "/api/rider-account/me", headers=self.bearer(token2), status=401)

    def test_sign_in_attempts_are_rate_limited(self):
        self.signup()
        with mock.patch.object(api, "rate_limiting_disabled", return_value=False), \
                mock.patch.object(api, "_rate_limiter", api.RateLimiter()):
            for _ in range(api.AUTH_RATE_LIMIT):
                self.call("POST", "/api/rider-account/login", {"phone": "0772123456", "password": "nope-nope"}, status=401)
            limited = self.call("POST", "/api/rider-account/login", {"phone": "0772123456", "password": "correct-horse"}, status=429)
            self.assertIn("retry_after_seconds", limited)


if __name__ == "__main__":
    unittest.main()
