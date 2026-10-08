#!/usr/bin/env python3
"""
End-to-end coverage for multi-tier lot grading (stock_lots → lot_grades → catalog tagging).

Boots the real API handler in-process against a throwaway SQLite database and
walks the checklist operators perform by hand:

1. Register a tier-graded lot (weights must total exactly 100%).
2. Confirm per-tier locked unit COGS is recomputed server-side and reconciles
   against the landed investment.
3. Tag catalog pieces against a tier — COGS auto-locks (manual cost ignored),
   price pre-fills from the tier target, and per-tier/lot capacity is enforced.
4. Prove legacy un-graded lots still work exactly as before.

Run from the repository root:  python3 tests/test_multi_tier_grading.py
"""
import json
import os
import sys
import tempfile

# --- Environment must be pinned BEFORE importing the app modules -----------
_TMP_DB = os.path.join(tempfile.mkdtemp(prefix="adonai-grading-test-"), "grading.db")
os.environ["DATABASE_URL"] = f"sqlite:///{_TMP_DB}"
os.environ["STORE_MASTER_KEY"] = "test-master-key-grading"
os.environ["JWT_SECRET"] = "test-jwt-secret-grading"
os.environ["ADONAI_RATE_LIMIT_DISABLED"] = "1"

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, REPO_ROOT)
os.chdir(REPO_ROOT)

from db_init import init_db  # noqa: E402
from api import handle_api_request  # noqa: E402

AUTH = {"x-terminal-key": "test-master-key-grading"}
PASSED = []
FAILED = []


NO_AUTH = object()  # sentinel: send an explicit empty header set


def call(method, path, body=None, headers=None):
    status, _ctype, payload = handle_api_request(
        method,
        path,
        {},
        json.dumps(body or {}).encode("utf-8"),
        AUTH if headers is None else ({} if headers is NO_AUTH else headers),
        client_addr="127.0.0.1",
    )
    return status, json.loads(payload.decode("utf-8"))


def check(label, condition, detail=""):
    if condition:
        PASSED.append(label)
        print(f"  PASS  {label}")
    else:
        FAILED.append(label)
        print(f"  FAIL  {label}  {detail}")


def banner(title):
    print(f"\n=== {title} ===")


def main():
    assert init_db(), "database init failed"

    banner("1. Tier-graded lot registration (100% weight rule)")
    status, data = call("POST", "/api/finance/stock-lots", {
        "supplier": "Owino Supplier A",
        "description": "Grade A Mixed Denim Bale",
        "acquisition_cost": 500000,
        "shipping_cost": 50000,
        "payment_method": "cash",
        # Client also lies about unit COGS on purpose — the server must ignore it.
        "grades": [
            {"grade_name": "Tier 1 — Premium", "expected_count": 10, "cost_weight_percentage": 40,
             "target_selling_price": 35000, "unit_cogs": 1},
            {"grade_name": "Tier 2 — Standard", "expected_count": 30, "cost_weight_percentage": 40,
             "target_selling_price": 20000, "unit_cogs": 1},
            {"grade_name": "Tier 3 — Clearance", "expected_count": 20, "cost_weight_percentage": 20,
             "target_selling_price": 10000, "unit_cogs": 1},
        ],
    })
    check("tiered lot registers with 201", status == 201, data)
    lot = data.get("stock_lot", {})
    check("item count derives from tier pieces (60)", lot.get("item_count") == 60, lot)
    check("total landed cost sums acquisition+shipping", lot.get("total_landed_cost") == 550000, lot)
    grades = {g["grade_name"]: g for g in lot.get("grades", [])}
    check("three tiers persisted", len(grades) == 3, lot)
    # 550000 landed → tier budgets 220000 / 220000 / 110000.
    check("tier 1 COGS locked server-side (client's 1 ignored)",
          grades.get("Tier 1 — Premium", {}).get("unit_cogs") in (22000, 22001),
          grades)
    check("tier 2 COGS ~ 220000/30 rounded", grades.get("Tier 2 — Standard", {}).get("unit_cogs") in (7333, 7334), grades)
    check("tier 3 COGS = 110000/20", grades.get("Tier 3 — Clearance", {}).get("unit_cogs") == 5500, grades)
    recovered = sum(g["unit_cogs"] * g["expected_count"] for g in grades.values())
    check("selling every piece recovers the investment within one piece's shillings",
          abs(recovered - 550000) <= 60, f"recovered={recovered}")

    banner("2. Weight validation is enforced server-side")
    status, data = call("POST", "/api/finance/stock-lots", {
        "supplier": "Bad Weight Supplier",
        "description": "Unbalanced bale",
        "acquisition_cost": 100000,
        "grades": [
            {"grade_name": "Tier A", "expected_count": 10, "cost_weight_percentage": 40, "target_selling_price": 0},
            {"grade_name": "Tier B", "expected_count": 10, "cost_weight_percentage": 19.99, "target_selling_price": 0},
        ],
    })
    check("weights totalling 59.99% rejected with 400", status == 400 and "100%" in data.get("error", ""), data)
    status, data = call("POST", "/api/finance/stock-lots", {
        "supplier": "Mismatch Supplier",
        "description": "Count mismatch bale",
        "acquisition_cost": 100000,
        "item_count": 99,
        "grades": [
            {"grade_name": "Only Tier", "expected_count": 5, "cost_weight_percentage": 100, "target_selling_price": 0},
        ],
    })
    check("item_count mismatching tier pieces rejected", status == 400, data)
    status, data = call("POST", "/api/finance/stock-lots", {"supplier": "No Auth Check"})
    check("malformed payload rejected (no grades, no item_count)", status == 400, data)
    status, data = call("GET", "/api/finance/stock-lots", headers=NO_AUTH)
    check("finance endpoint still requires auth", status == 401, data)

    banner("3. GET exposes tiers to the intake/tagging UI")
    status, data = call("GET", "/api/finance/stock-lots")
    lots = data.get("stock_lots", [])
    graded_lot = next((row for row in lots if row.get("grades")), None)
    check("graded lot listed with embedded tiers", graded_lot is not None, data)
    tier1 = next(g for g in graded_lot["grades"] if g["grade_name"].startswith("Tier 1"))
    tier2 = next(g for g in graded_lot["grades"] if g["grade_name"].startswith("Tier 2"))

    banner("4. Catalog tagging locks COGS from the tier")
    # (a) Graded lot refuses tagging without a tier.
    status, data = call("POST", "/api/products", {
        "name": "Untiered Denim", "demographic": "Men", "category": "Pants & Jeans",
        "item_condition": "PRE_LOVED", "stock_lot_id": lot["id"],
        "selling_price": 30000, "in_stock_count": 1,
    })
    check("graded lot without tier is refused", status == 400 and "tier" in data.get("error", "").lower(), data)

    # (b) Tier tag: manual cost 999 must be overridden by locked tier COGS.
    status, data = call("POST", "/api/products", {
        "name": "Vintage Oversized Denim Jacket", "demographic": "Men",
        "category": "Outerwear & Jackets", "size": "L",
        "item_condition": "PRE_LOVED", "in_stock_count": 1,
        "lot_grade_id": tier1["id"],
        "cost_price": 999,            # attempted manual override — must be ignored
        "base_price": 0,              # blank → pre-fill from tier target
        "total_transport_cost": 0,
    })
    product = data.get("product", {})
    check("tier tag creates product", status == 201, data)
    check("COGS locked to tier unit (manual 999 ignored)", product.get("cost_price") == tier1["unit_cogs"], product)
    check("base price pre-filled from tier target 35000", product.get("base_price") == 35000, product)
    check("product records its grade tier link", product.get("lot_grade_id") == tier1["id"], product)
    check("product records its parent lot link", product.get("stock_lot_id") == lot["id"], product)

    # (c) Allocation counts move on BOTH the tier and the lot.
    status, data = call("GET", "/api/finance/stock-lots")
    row = next(r for r in data["stock_lots"] if r["id"] == lot["id"])
    t1 = next(g for g in row["grades"] if g["grade_name"].startswith("Tier 1"))
    check("tier allocation count is 1 after tag", t1["allocated_count"] == 1, t1)
    check("lot allocation count is 1 after tag", row["allocated_count"] == 1, row)

    # (d) Brand-new multi-qty intake draws down many pieces atomically.
    status, data = call("POST", "/api/products", {
        "name": "Essential Standard Tee", "demographic": "Unisex", "category": "Tops & Shirts",
        "item_condition": "BRAND_NEW", "in_stock_count": 30,
        "lot_grade_id": tier2["id"], "total_transport_cost": 0,
    })
    check("multi-qty tag against tier 2 (30 pcs) accepted", status == 201, data)
    tee = data.get("product", {})
    check("multi-qty COGS locked to tier 2 unit", tee.get("cost_price") == tier2["unit_cogs"], tee)
    check("multi-qty base pre-filled from tier 2 target", tee.get("base_price") == 20000, tee)
    status, data = call("GET", "/api/finance/stock-lots")
    row = next(r for r in data["stock_lots"] if r["id"] == lot["id"])
    t2 = next(g for g in row["grades"] if g["grade_name"].startswith("Tier 2"))
    check("tier 2 fully allocated (30/30)", t2["remaining_count"] == 0, t2)

    # (e) Capacity guard: one more piece than a tier holds must fail.
    status, data = call("POST", "/api/products", {
        "name": "One Piece Too Many", "demographic": "Men", "category": "Tops & Shirts",
        "item_condition": "BRAND_NEW", "in_stock_count": 1,
        "lot_grade_id": tier2["id"], "total_transport_cost": 0,
    })
    check("over-capacity tag rejected with 409", status == 409, data)

    # (f) Unknown tier fails cleanly.
    status, data = call("POST", "/api/products", {
        "name": "Ghost Tier Item", "demographic": "Men", "category": "Tops & Shirts",
        "item_condition": "PRE_LOVED", "lot_grade_id": "LGR-DOES-NOT-EXIST",
        "selling_price": 10000, "in_stock_count": 1,
    })
    check("unknown tier rejected with 404", status == 404, data)

    banner("5. Legacy un-graded lot flow is unchanged")
    status, data = call("POST", "/api/finance/stock-lots", {
        "supplier": "Kikuubo Bulk", "description": "Flat-cost accessories bale",
        "acquisition_cost": 100000, "shipping_cost": 20000,
        "item_count": 12, "payment_method": "mobile_money",
    })
    check("legacy flat lot registers", status == 201, data)
    flat_lot = data["stock_lot"]
    check("flat lot has no tiers", flat_lot.get("grades") == [], flat_lot)
    check("flat blended unit cost 120000/12", flat_lot.get("unit_cost") == 10000, flat_lot)
    status, data = call("POST", "/api/products", {
        "name": "Canvas Belt", "demographic": "Men", "category": "Accessories",
        "item_condition": "PRE_LOVED", "in_stock_count": 1,
        "stock_lot_id": flat_lot["id"], "base_price": 25000, "total_transport_cost": 0,
    })
    check("legacy lot tag fills blended cost without a tier",
          status == 201 and data.get("product", {}).get("cost_price") == 10000, data)
    check("legacy tag has no tier link", not data.get("product", {}).get("lot_grade_id"), data)

    banner("RESULTS")
    print(f"  {len(PASSED)} passed, {len(FAILED)} failed")
    if FAILED:
        print("  Failing checks:", *FAILED, sep="\n   - ")
        return 1
    print("  All multi-tier lot grading checks passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
