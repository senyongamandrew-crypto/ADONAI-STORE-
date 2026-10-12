#!/usr/bin/env python3
"""End-to-end coverage for partner consignment (intake → checkout split → payout).

Boots the real API handler in-process against a throwaway SQLite database and
walks the controls the Bale Costs panel depends on:

1. Pure rules: 5% split reconciles exactly; media standard; payout account formats.
2. Supplier onboarding: starts PENDING_KYC; the creator cannot verify their own file.
3. Consignment intake: refused without a verified partner or a compliant media set,
   and a refused intake leaves nothing behind (no lot, no garments).
4. Storefront boundary: public catalogue exposes no supplier or partner fields.
5. Checkout split: a consignment line posts partner payable (2100) + commission (4200),
   the journal balances, and the split row reconciles to the line total.
6. Payouts: only fulfilled sales are payable; idempotent requests; dual approval
   above the threshold; payment reference required and unique; reconciliation holds.

Run from the repository root:  python3 tests/test_consignment.py
"""
import json
import os
import sys
import tempfile
import uuid
from datetime import datetime

# --- Environment must be pinned BEFORE importing the app modules -----------
_TMP_DB = os.path.join(tempfile.mkdtemp(prefix="adonai-consignment-test-"), "consignment.db")
# TEST_DATABASE_URL lets the same suite run against PostgreSQL (a fresh database per run).
os.environ["DATABASE_URL"] = os.environ.get("TEST_DATABASE_URL") or f"sqlite:///{_TMP_DB}"
os.environ["STORE_MASTER_KEY"] = "test-master-key-consignment"
os.environ["ADONAI_REQUIRE_STAFF_AUTH"] = "1"
os.environ["JWT_SECRET"] = "test-jwt-secret-consignment"
os.environ["ADONAI_RATE_LIMIT_DISABLED"] = "1"

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, REPO_ROOT)
os.chdir(REPO_ROOT)

from db_init import init_db  # noqa: E402
import consignment  # noqa: E402
import api  # noqa: E402
from api import handle_api_request, create_jwt_token  # noqa: E402
from database import get_db  # noqa: E402
from models import ProductMedia, Order, ConsignmentSalesSplit, Product  # noqa: E402

PASSED = []
FAILED = []
NO_AUTH = object()


def token_for(staff_id, name, role):
    return {"authorization": "Bearer " + create_jwt_token({"id": staff_id, "name": name, "role": role}, 3600)}


MGR1 = token_for("MGR-1", "Manager One", "manager")
MGR2 = token_for("MGR-2", "Manager Two", "manager")
CASHIER = token_for("CSH-1", "Cashier", "cashier")


def call(method, path, body=None, headers=None, query=None):
    status, _ctype, payload = handle_api_request(
        method,
        path,
        query or {},
        json.dumps(body or {}).encode("utf-8"),
        {} if headers is NO_AUTH else (headers or MGR1),
        client_addr="127.0.0.1",
    )
    text = payload.decode("utf-8")
    try:
        return status, json.loads(text)
    except ValueError:
        return status, {"raw": text}


def check(label, condition, detail=""):
    if condition:
        PASSED.append(label)
        print(f"  PASS  {label}")
    else:
        FAILED.append(label)
        print(f"  FAIL  {label}  {detail}")


def add_media(kind, uploader, duration=None):
    """Create a durable media asset the way the upload endpoint would (unattached)."""
    asset_id = uuid.uuid4().hex
    with get_db() as session:
        session.add(ProductMedia(
            id=asset_id,
            product_id=None,
            kind=kind,
            mime_type="image/jpeg" if kind == "image" else "video/mp4",
            filename=f"{asset_id}.{'jpg' if kind == 'image' else 'mp4'}",
            byte_length=1024,
            width=800,
            height=1000,
            duration=duration,
            data=b"x",
            uploaded_by=uploader,
            created_at=datetime.utcnow(),
        ))
    return asset_id


def compliant_item(name, price, photos=5, video_seconds=12.0, uploader="MGR-1"):
    images = [f"/api/media/{add_media('image', uploader)}" for _ in range(photos)]
    video = add_media("video", uploader, duration=video_seconds) if video_seconds is not None else ""
    return {
        "name": name,
        "brand": "Partner Brand",
        "category": "Outerwear & Jackets",
        "size": "M",
        "selling_price": price,
        "reference_value": int(price * 0.6),
        "images": images,
        "video_id": video,
    }


def supplier_payload(name, channel="MOBILE_MONEY", account="0770123456"):
    return {
        "partner_name": name,
        "business_name": f"{name} Trading",
        "phone_whatsapp": "+256770123456",
        "identity_reference": "CM9800123456789",
        "payout_channel": channel,
        "payout_account": account,
    }


def main():
    print("\n[1] Pure rules")
    check("5% commission on UGX 80,000 is 4,000 and partner gets 76,000",
          consignment.split_sale_line(80_000) == (4_000, 76_000))
    commission, partner = consignment.split_sale_line(12_345)
    check("odd amounts reconcile exactly (half-up commission)", commission + partner == 12_345 and commission == 617)
    commission, partner = consignment.split_sale_line(12_350)
    check("half-shilling rounds up and still reconciles", commission == 618 and commission + partner == 12_350)
    check("media: 5 photos and a 12s video are compliant", consignment.validate_media(5, 12.0) == [])
    check("media: 4 photos are refused", any("at least 5" in p for p in consignment.validate_media(4, 12.0)))
    check("media: 7 photos are refused", any("at most 6" in p for p in consignment.validate_media(7, 12.0)))
    check("media: video over 15s is refused", any("15 seconds" in p for p in consignment.validate_media(5, 20.0)))
    check("media: missing video is refused", any("required" in p for p in consignment.validate_media(5, None)))
    check("mobile money accepts +256 form and normalises", consignment.validate_payout_account("MOBILE_MONEY", "+256770123456") == "0770123456")
    try:
        consignment.validate_payout_account("MOBILE_MONEY", "12345")
        check("mobile money rejects a short number", False)
    except ValueError:
        check("mobile money rejects a short number", True)
    check("masking shows only the last three characters", consignment.mask_account("0770123456") == "•••••••456")

    print("\n[2] Supplier onboarding and KYC")
    status, data = call("POST", "/api/finance/consignment/suppliers", supplier_payload("Derek Corrections"))
    check("supplier created", status == 201, f"{status} {data}")
    supplier = data.get("supplier", {})
    check("new supplier starts PENDING_KYC", supplier.get("kyc_status") == "PENDING_KYC")
    check("supplier response masks the payout account", supplier.get("payout_account", "").endswith("456") and "0770" not in supplier.get("payout_account", ""))
    supplier_id = supplier.get("id")
    status, data = call("POST", f"/api/finance/consignment/suppliers/{supplier_id}/verify", {}, MGR1)
    check("creator cannot verify their own supplier file", status == 403, f"{status} {data}")
    status, data = call("POST", "/api/finance/consignment/suppliers", {**supplier_payload("Bad Account"), "payout_account": "x"})
    check("invalid payout account is rejected at onboarding", status == 400)
    status, data = call("POST", f"/api/finance/consignment/suppliers/{supplier_id}/verify", {}, MGR2)
    check("a second manager verifies KYC", status == 200 and data.get("supplier", {}).get("kyc_status") == "VERIFIED", f"{status} {data}")

    print("\n[3] Intake gates")
    status, data = call("POST", "/api/finance/consignment/lots", {"supplier_id": supplier_id, "description": "Test bale", "agreement_ref": "AGR-1", "items": [compliant_item("Gate test", 50_000)]}, CASHIER)
    check("staff cannot attach another staff member's uploads to consignment intake", status == 400 and "another staff member" in data.get("error", ""), f"{status} {data}")
    unverified = call("POST", "/api/finance/consignment/suppliers", supplier_payload("Unverified Partner"), MGR1)[1]["supplier"]["id"]
    status, data = call("POST", "/api/finance/consignment/lots", {"supplier_id": unverified, "description": "x", "agreement_ref": "AGR-X", "items": [compliant_item("Blocked", 40_000)]}, MGR1)
    check("unverified partner cannot receive stock", status == 409, f"{status} {data}")
    status, data = call("POST", "/api/finance/consignment/lots", {"supplier_id": supplier_id, "description": "x", "agreement_ref": "", "items": [compliant_item("No agreement", 40_000)]}, MGR1)
    check("agreement reference is mandatory", status == 400)
    status, data = call("POST", "/api/finance/consignment/lots", {
        "supplier_id": supplier_id, "description": "Atomic test", "agreement_ref": "AGR-2", "lot_code": "CON-ATOMIC-1",
        "items": [compliant_item("Good one", 45_000), compliant_item("Only four photos", 45_000, photos=4)],
    }, MGR1)
    check("a non-compliant garment refuses the whole intake", status == 400 and "media standard" in data.get("error", ""), f"{status} {data}")
    with get_db() as session:
        leftover = session.query(Product).filter(Product.name.in_(["Good one", "Only four photos"])).count()
    check("a refused intake leaves no garments behind", leftover == 0, f"found {leftover}")

    print("\n[4] Compliant intake")
    lot_body = {
        "supplier_id": supplier_id, "description": "Mixed denim consignment", "agreement_ref": "AGR-2026-001",
        "lot_code": "CON-TEST-001",
        "items": [compliant_item("Indigo Denim Jacket", 80_000), compliant_item("Olive Field Jacket", 50_000)],
    }
    status, data = call("POST", "/api/finance/consignment/lots", lot_body, MGR1)
    check("compliant consignment lot registers", status == 201, f"{status} {data}")
    lot = data.get("lot", {})
    check("lot is typed PARTNER_CONSIGNMENT with zero upfront cost", lot.get("lot_type") == "PARTNER_CONSIGNMENT" and lot.get("total_landed_cost") == 0)
    with get_db() as session:
        rows = session.query(Product).filter(Product.stock_lot_id == lot.get("id")).all()
        products = [{"id": p.id, "name": p.name, "ok": bool(p.is_consignment and p.supplier_id == supplier_id and int(p.cost_price or 0) == 0 and int(p.total_transport_cost or 0) == 0)} for p in rows]
    check("garments are consignment items with zero Adonai cost and no transport", len(products) == 2 and all(p["ok"] for p in products))
    indigo_id = next((p["id"] for p in products if p["name"] == "Indigo Denim Jacket"), None)
    olive_id = next((p["id"] for p in products if p["name"] == "Olive Field Jacket"), None)

    print("\n[5] Storefront boundary")
    status, data = call("GET", "/api/products", {}, NO_AUTH)
    text = json.dumps(data)
    check("public catalogue lists consignment garments", status == 200 and "Indigo Denim Jacket" in text)
    check("public catalogue exposes no supplier identity or consignment fields",
          supplier_id not in text and "Derek" not in text and "supplier_id" not in text and "consignment_reference_value" not in text and "CM9800123456789" not in text)

    print("\n[6] Checkout split")
    status, data = call("POST", "/api/orders", {"channel": "web", "items": [{"product_id": indigo_id, "qty": 2}], "delivery_type": "pickup", "customer_name": "Qty Test"}, NO_AUTH)
    check("a consignment piece cannot be sold in quantity 2", status == 409, f"{status} {data}")
    with get_db() as session:
        still_available = session.query(Product).filter_by(id=indigo_id).first().in_stock_count
    check("the refused quantity-2 order did not touch stock", still_available == 1, f"stock={still_available}")

    status, data = call("POST", "/api/orders", {"channel": "web", "items": [{"product_id": indigo_id, "qty": 1}, {"product_id": olive_id, "qty": 1}], "delivery_type": "pickup", "customer_name": "Consignment Buyer", "customer_phone": "+256700000111"}, NO_AUTH)
    check("web checkout of two consignment pieces succeeds", status in (200, 201), f"{status} {data}")
    order_id = (data.get("order") or {}).get("id") or data.get("order_id") or data.get("id")
    with get_db() as session:
        splits = session.query(ConsignmentSalesSplit).filter_by(order_id=order_id).all()
        split_totals = sorted((s.line_total, s.commission_amount, s.partner_share) for s in splits)
        journal_id = splits[0].journal_entry_id if splits else None
    check("two split rows are written, one per consignment line", len(splits) == 2, f"{len(splits)}")
    check("each split reconciles to its line total", all(line == com + part for line, com, part in split_totals))
    check("split amounts: 80,000 → 4,000 / 76,000 and 50,000 → 2,500 / 47,500",
          split_totals == sorted([(80_000, 4_000, 76_000), (50_000, 2_500, 47_500)]), f"{split_totals}")
    with get_db() as session:
        from models import AccountingJournalLine
        lines = session.query(AccountingJournalLine).filter_by(journal_entry_id=journal_id).all()
        debit = sum(int(l.debit or 0) for l in lines)
        credit = sum(int(l.credit or 0) for l in lines)
        p2100 = sum(int(l.credit or 0) - int(l.debit or 0) for l in lines if l.account_code == "2100")
        c4200 = sum(int(l.credit or 0) for l in lines if l.account_code == "4200")
    check("the sale journal balances", debit == credit and debit > 0, f"dr={debit} cr={credit}")
    check("partner payable (2100) is credited with the partner shares", p2100 == 76_000 + 47_500)
    check("commission revenue (4200) is credited with the commission only", c4200 == 4_000 + 2_500)

    # Simulate staff fulfilment of the web order (status completed) through the ledger.
    with get_db() as session:
        session.query(Order).filter_by(id=order_id).update({"status": "completed"})

    print("\n[7] Payouts")
    status, data = call("GET", "/api/finance/consignment/overview", {}, CASHIER)
    check("cashier cannot open the cash-share dashboard", status == 403)
    status, data = call("GET", "/api/finance/consignment/overview", {}, MGR1)
    check("overview loads for a manager", status == 200, f"{status} {data}")
    sup_row = next((s for s in data.get("suppliers", []) if s["id"] == supplier_id), {})
    check("fulfilled partner share is 123,500 (76,000 + 47,500)", sup_row.get("eligible") == 76_000 + 47_500, f"{sup_row}")
    check("nothing has been paid yet, so payable now is 123,500", sup_row.get("payable_now") == 76_000 + 47_500, f"{sup_row}")
    check("balance matches the journal for account 2100", data.get("reconciliation", {}).get("partner_payable", {}).get("balanced") is True, f"{data.get('reconciliation')}")
    check("commission matches the journal for account 4200", data.get("reconciliation", {}).get("commission", {}).get("balanced") is True)

    payable_now = sup_row.get("payable_now", 0)
    status, data = call("POST", "/api/finance/consignment/payouts", {"supplier_id": supplier_id, "amount": payable_now + 1, "idempotency_key": "pay-over-1"}, MGR1)
    check("payout above the payable balance is refused", status == 409, f"{status} {data}")
    status, data = call("POST", "/api/finance/consignment/payouts", {"supplier_id": supplier_id, "amount": 40_000, "idempotency_key": "pay-key-1"}, MGR1)
    check("valid payout request is recorded as REQUESTED", status == 201 and data.get("payout", {}).get("status") == "REQUESTED", f"{status} {data}")
    payout_id = data.get("payout", {}).get("id")
    status, again = call("POST", "/api/finance/consignment/payouts", {"supplier_id": supplier_id, "amount": 40_000, "idempotency_key": "pay-key-1"}, MGR1)
    check("repeating the same request key does not create a second payout",
          status == 200 and again.get("status") == "existing" and again.get("payout", {}).get("id") == payout_id)
    status, data = call("POST", f"/api/finance/consignment/payouts/{payout_id}/pay", {"payment_reference": "MM-REF-1"}, MGR2)
    check("cannot pay before approval", status == 409)
    status, data = call("POST", f"/api/finance/consignment/payouts/{payout_id}/approve", {}, MGR1)
    check("small payouts may be approved by the requester's manager", status == 200 and data.get("payout", {}).get("status") == "APPROVED", f"{status} {data}")
    status, data = call("POST", f"/api/finance/consignment/payouts/{payout_id}/pay", {"payment_reference": "x"}, MGR2)
    check("a payment reference is required", status == 400)
    status, data = call("POST", f"/api/finance/consignment/payouts/{payout_id}/pay", {"payment_reference": "MM-REF-1"}, MGR2)
    check("payment recorded with a reference", status == 200 and data.get("payout", {}).get("status") == "PAID", f"{status} {data}")

    # Dual approval above the threshold: a separate high-value sale.
    big = compliant_item("Heritage Leather Coat", 400_000)
    status, data = call("POST", "/api/finance/consignment/lots", {"supplier_id": supplier_id, "description": "Premium", "agreement_ref": "AGR-3", "lot_code": "CON-TEST-002", "items": [big]}, MGR1)
    big_id = data.get("product_ids", [None])[0]
    status, data = call("POST", "/api/orders", {"channel": "web", "items": [{"product_id": big_id, "qty": 1}], "delivery_type": "pickup", "customer_name": "Big Buyer"}, NO_AUTH)
    big_order = (data.get("order") or {}).get("id") or data.get("order_id") or data.get("id")
    with get_db() as session:
        session.query(Order).filter_by(id=big_order).update({"status": "completed"})
    status, data = call("POST", "/api/finance/consignment/payouts", {"supplier_id": supplier_id, "amount": 350_000, "idempotency_key": "pay-big-1"}, MGR1)
    big_payout = data.get("payout", {}).get("id")
    check("a high-value payout can be requested", status == 201, f"{status} {data}")
    status, data = call("POST", f"/api/finance/consignment/payouts/{big_payout}/approve", {}, MGR1)
    check("requester cannot self-approve a payout at or above the threshold", status == 403, f"{status} {data}")
    status, data = call("POST", f"/api/finance/consignment/payouts/{big_payout}/approve", {}, MGR2)
    check("a second manager approves the high-value payout", status == 200, f"{status} {data}")
    status, data = call("POST", f"/api/finance/consignment/payouts/{big_payout}/pay", {"payment_reference": "MM-REF-1"}, MGR2)
    check("a reused payment reference is refused", status == 409, f"{status} {data}")
    status, data = call("POST", f"/api/finance/consignment/payouts/{big_payout}/pay", {"payment_reference": "MM-REF-BIG"}, MGR2)
    check("high-value payment recorded", status == 200 and data.get("payout", {}).get("status") == "PAID", f"{status} {data}")

    status, data = call("GET", "/api/finance/consignment/overview", {}, MGR1)
    recon = data.get("reconciliation", {}).get("partner_payable", {})
    check("after payouts the 2100 journal still equals the expected payable", recon.get("balanced") is True, f"{recon}")
    kpi = data.get("kpis", {})
    check("paid-out KPI reflects both PAID payouts", kpi.get("paid_out") == 40_000 + 350_000, f"{kpi}")

    print("\n[8] Transport cannot leak onto consignment pieces")
    status, data = call("POST", "/api/finance/consignment/lots", {
        "supplier_id": supplier_id, "description": "Transport probe", "agreement_ref": "AGR-4",
        "lot_code": "CON-TRANSPORT-1", "items": [compliant_item("Transport probe jacket", 40_000)],
    }, MGR1)
    check("transport probe consignment lot registers", status == 201, f"{status} {data}")
    with get_db() as session:
        probe_id = session.query(Product).filter(Product.name == "Transport probe jacket").one().id
    # A routine System Parameters change with the catalogue roll-out must not put transport on consignment stock.
    ADMIN = token_for("ADM-1", "Store Admin", "admin")
    status, data = call("POST", "/api/settings", {"settings": {"base_delivery_fee": "5000"}, "apply_base_fee_to_catalog": True}, ADMIN)
    check("base delivery fee change with catalogue roll-out is accepted", status == 200, f"{status} {data}")
    with get_db() as session:
        probe_transport = int(session.query(Product).filter_by(id=probe_id).one().total_transport_cost or 0)
    check("consignment piece keeps zero transport after the roll-out", probe_transport == 0, f"transport={probe_transport}")
    status, data = call("POST", "/api/orders", {
        "channel": "web", "items": [{"product_id": probe_id, "qty": 1}],
        "delivery_type": "pickup", "customer_name": "Transport Probe",
    }, NO_AUTH)
    check("web checkout of a consignment piece still succeeds after the roll-out", status in (200, 201), f"{status} {data}")
    probe_order = (data.get("order") or {}).get("id") or data.get("order_id") or data.get("id")
    with get_db() as session:
        probe_split = session.query(ConsignmentSalesSplit).filter_by(order_id=probe_order).first()
        probe_journal = probe_split.journal_entry_id if probe_split else None
    if probe_journal:
        with get_db() as session:
            from models import AccountingJournalLine
            plines = session.query(AccountingJournalLine).filter_by(journal_entry_id=probe_journal).all()
            pdr = sum(int(l.debit or 0) for l in plines)
            pcr = sum(int(l.credit or 0) for l in plines)
        check("the probe sale journal balances", pdr == pcr and pdr > 0, f"dr={pdr} cr={pcr}")
    else:
        check("the probe sale journal balances", False, "no split row was written for the probe sale")

    print("\n" + "=" * 60)
    print(f"  {len(PASSED)} passed, {len(FAILED)} failed")
    if FAILED:
        print("  Failed checks:")
        for label in FAILED:
            print(f"   - {label}")
        return 1
    print("  All consignment checks passed.")
    return 0


if __name__ == "__main__":
    init_db()
    sys.exit(main())
