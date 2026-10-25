#!/usr/bin/env python3
"""End-to-end coverage for the direct-upload supplier catalog workflow.

Boots the real API handler in-process against a throwaway SQLite database and
walks the checklist a direct-upload operator performs:

1. Ingest a piece with the ingestion-service payload vocabulary
   (item_name, supplier_name, catalog_group, subcategory, fixed_unit_cost,
   base_retail_price, size_availability, color, image_url, condition_notes).
2. Confirm the supplier tag and item-level economics persist and are exposed
   to every channel (storefront product payload).
3. Confirm cost/price projections (cost_price, base_price, selling_price)
   derive from the direct-upload figures.
4. Prove the canonical catalog vocabulary still works, with optional supplier
   tagging fields layered on top.
5. Reject negative financial figures server-side.
6. Update supplier tagging + economics through PATCH.

Run from the repository root:  python3 tests/test_direct_supplier_upload.py
"""
import json
import os
import sys
import tempfile

# --- Environment must be pinned BEFORE importing the app modules -----------
_TMP_DB = os.path.join(tempfile.mkdtemp(prefix="adonai-direct-upload-test-"), "direct.db")
os.environ["DATABASE_URL"] = f"sqlite:///{_TMP_DB}"
os.environ["STORE_MASTER_KEY"] = "test-master-key-direct-upload"
os.environ["ADONAI_REQUIRE_STAFF_AUTH"] = "1"
os.environ["JWT_SECRET"] = "test-jwt-secret-direct-upload"
os.environ["ADONAI_RATE_LIMIT_DISABLED"] = "1"

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, REPO_ROOT)
os.chdir(REPO_ROOT)

from db_init import init_db  # noqa: E402
from api import handle_api_request  # noqa: E402

AUTH = {"x-terminal-key": "test-master-key-direct-upload"}
PASSED = []
FAILED = []


def call(method, path, body=None, headers=None):
    status, _ctype, payload = handle_api_request(
        method,
        path,
        {},
        json.dumps(body or {}).encode("utf-8"),
        AUTH if headers is None else headers,
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

    banner("1. Direct-upload ingestion payload (supplier_ingestion.py vocabulary)")
    status, data = call("POST", "/api/products", {
        "item_name": "Adidas Red & White Full-Zip Windbreaker",
        "supplier_name": "Finds Ug",
        "catalog_group": "Outerwear",
        "subcategory": "Full-Zip Hooded Windbreaker",
        "fixed_unit_cost": 45000.00,
        "base_retail_price": 85000.00,
        "size_availability": "Medium / Large",
        "color": "Red / White",
        "image_url": "/assets/products/p1001.jpg",
        "condition_notes": "Excellent vintage condition, inspected and approved.",
    })
    check("direct-upload payload creates product (201)", status == 201, data)
    product = data.get("product", {})

    banner("2. Supplier tagging + item-level economics persist")
    check("supplier_name tagged", product.get("supplier_name") == "Finds Ug", product)
    check("fixed_unit_cost recorded", product.get("fixed_unit_cost") == 45000.0, product)
    check("base_retail_price recorded", product.get("base_retail_price") == 85000.0, product)

    banner("3. Intake vocabulary maps onto catalog fields")
    check("item_name maps to name",
          product.get("name") == "Adidas Red & White Full-Zip Windbreaker", product)
    check("catalog_group maps to category", product.get("category") == "Outerwear", product)
    check("subcategory maps through", product.get("subcategory") == "Full-Zip Hooded Windbreaker", product)
    check("size_availability maps to size", product.get("size") == "Medium / Large", product)
    check("condition_notes maps to condition",
          product.get("condition") == "Excellent vintage condition, inspected and approved.", product)
    check("color maps through", product.get("color") == "Red / White", product)

    banner("4. Cost & price projections derive from the direct-upload figures")
    check("cost_price COGS equals fixed unit cost", product.get("cost_price") == 45000, product)
    check("base_price equals base retail price", product.get("base_price") == 85000.0, product)
    check("selling price equals base retail (no transport allocation)",
          product.get("selling_price") == 85000, product)
    check("defaults to unique pre-loved piece (1-of-1)",
          product.get("item_condition") == "PRE_LOVED" and product.get("in_stock_count") == 1, product)

    banner("5. Storefront payload exposes supplier economics to every channel")
    status, data = call("GET", "/api/products")
    rows = data.get("products", data if isinstance(data, list) else [])
    row = next((p for p in rows if p.get("id") == product.get("id")), None)
    check("product listed on the storefront feed", row is not None, data)
    if row:
        check("storefront row carries supplier_name", row.get("supplier_name") == "Finds Ug", row)
        check("storefront row carries fixed_unit_cost", row.get("fixed_unit_cost") == 45000.0, row)
        check("storefront row carries base_retail_price", row.get("base_retail_price") == 85000.0, row)

    banner("6. Negative financial figures are rejected server-side")
    status, data = call("POST", "/api/products", {
        "item_name": "Bad Cost Jacket", "supplier_name": "Finds Ug",
        "fixed_unit_cost": -1, "base_retail_price": 5000,
    })
    check("negative fixed_unit_cost rejected (400)", status == 400, data)
    status, data = call("POST", "/api/products", {
        "item_name": "Bad Price Jacket", "supplier_name": "Finds Ug",
        "fixed_unit_cost": 1000, "base_retail_price": -0.01,
    })
    check("negative base_retail_price rejected (400)", status == 400, data)
    status, data = call("POST", "/api/products", {
        "item_name": "", "supplier_name": "Finds Ug",
        "fixed_unit_cost": 1000, "base_retail_price": 2000,
    })
    check("missing item name rejected (400)", status == 400, data)
    status, data = call("POST", "/api/products", {
        "item_name": "No Supplier Jacket",
        "fixed_unit_cost": 1000, "base_retail_price": 2000,
    })
    check("missing supplier name rejected (400)", status == 400 and
          "Item name and supplier name" in data.get("error", ""), data)

    banner("7. Canonical catalog vocabulary + supplier tagging layer")
    status, data = call("POST", "/api/products", {
        "name": "Curated Windbreaker Olive", "demographic": "Men",
        "category": "Outerwear & Jackets", "size": "L",
        "item_condition": "PRE_LOVED", "in_stock_count": 1,
        "cost_price": 30000, "base_price": 60000, "total_transport_cost": 0,
        "supplier_name": "Kampala Vintage Hub",
        "fixed_unit_cost": 30000.50,
        "base_retail_price": 60000,
    })
    check("canonical payload with supplier fields creates product (201)", status == 201, data)
    classic = data.get("product", {})
    check("supplier tag layered onto canonical intake",
          classic.get("supplier_name") == "Kampala Vintage Hub", classic)
    check("fractional fixed_unit_cost keeps two decimals",
          classic.get("fixed_unit_cost") == 30000.5, classic)

    banner("8. PATCH updates supplier tagging + economics")
    pid = product.get("id")
    status, data = call("PATCH", f"/api/products/{pid}", {
        "supplier_name": "Finds Ug · Restock",
        "fixed_unit_cost": 47000.25,
        "base_retail_price": 89000,
    })
    check("patch succeeds", status == 200, data)
    updated = data.get("product", {})
    check("supplier_name updated", updated.get("supplier_name") == "Finds Ug · Restock", updated)
    check("fixed_unit_cost updated", updated.get("fixed_unit_cost") == 47000.25, updated)
    check("base_retail_price updated + repriced", updated.get("base_retail_price") == 89000.0, updated)
    check("selling price follows the new retail price", updated.get("selling_price") == 89000, updated)

    banner("9. PATCH rejects negative figures and clears tags with null")
    status, data = call("PATCH", f"/api/products/{pid}", {"fixed_unit_cost": -5})
    check("negative fixed_unit_cost patch rejected (400)", status == 400, data)
    status, data = call("PATCH", f"/api/products/{pid}", {"supplier_name": ""})
    check("empty supplier_name clears the tag", status == 200 and not data.get("product", {}).get("supplier_name"), data)

    print(f"\n{'=' * 60}")
    print(f"PASSED: {len(PASSED)}   FAILED: {len(FAILED)}")
    if FAILED:
        for label in FAILED:
            print(f"  ✗ {label}")
        sys.exit(1)
    print("All direct-upload supplier workflow checks passed.")


if __name__ == "__main__":
    main()
