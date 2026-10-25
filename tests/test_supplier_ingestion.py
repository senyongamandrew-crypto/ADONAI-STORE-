#!/usr/bin/env python3
"""Direct-upload supplier ingestion service contract tests.

Covers SupplierCatalogIngestionService.sanitize_item_payload validation and
the ingest_single_item Supabase insert contract, plus the migration/DDL the
service depends on (catalog_items supplier + economics columns).

Run from the repository root:  python3 tests/test_supplier_ingestion.py
"""
import os
import re
import sys
import unittest
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import supplier_ingestion  # noqa: E402
from supplier_ingestion import (  # noqa: E402
    CATALOG_ITEMS_TABLE,
    SupplierCatalogIngestionService,
)

SPEC_PAYLOAD_KEYS = {
    "item_name", "supplier_name", "catalog_group", "subcategory",
    "fixed_unit_cost", "base_retail_price", "size_availability", "color",
    "image_url", "condition_notes", "created_at",
}


class FakeResponse:
    def __init__(self, data):
        self.data = data


class FakeInsertQuery:
    def __init__(self, store, table):
        self._store = store
        self._table = table

    def insert(self, payload):
        self._store["payload"] = payload
        self._store["table"] = self._table
        if self._store.get("fail"):
            raise RuntimeError("connection refused")
        return self

    def execute(self):
        return FakeResponse([dict(self._store["payload"])])


class FakeSupabase:
    def __init__(self, fail=False):
        self.store = {"fail": fail}

    def table(self, name):
        return FakeInsertQuery(self.store, name)


def make_service(fake=None):
    fake = fake or FakeSupabase()
    with mock.patch.object(supplier_ingestion, "create_client", lambda url, key: fake):
        service = SupplierCatalogIngestionService("https://demo.supabase.co", "service-key")
    return service, fake


class SanitizePayloadTests(unittest.TestCase):
    def setUp(self):
        self.service, _ = make_service()

    def sample(self, **overrides):
        values = dict(
            item_name="  Adidas Red & White Full-Zip Windbreaker  ",
            supplier_name="  Finds Ug  ",
            catalog_group=" Outerwear ",
            subcategory=" Full-Zip Hooded Windbreaker ",
            fixed_unit_cost=45000.00,
            base_retail_price=85000.00,
            size_availability=" Medium / Large ",
            color=" Red / White ",
            image_url=" https://storage.googleapis.com/adonai-assets/adidas-windbreaker.jpg ",
            condition_notes=" Excellent vintage condition, inspected and approved. ",
        )
        values.update(overrides)
        return self.service.sanitize_item_payload(**values)

    def test_payload_keys_match_the_contract_exactly(self):
        self.assertEqual(set(self.sample().keys()), SPEC_PAYLOAD_KEYS)

    def test_values_are_stripped(self):
        payload = self.sample()
        self.assertEqual(payload["item_name"], "Adidas Red & White Full-Zip Windbreaker")
        self.assertEqual(payload["supplier_name"], "Finds Ug")
        self.assertEqual(payload["catalog_group"], "Outerwear")
        self.assertEqual(payload["size_availability"], "Medium / Large")

    def test_required_fields(self):
        with self.assertRaises(ValueError) as ctx:
            self.sample(item_name="")
        self.assertIn("Item name and supplier name are required fields.", str(ctx.exception))
        with self.assertRaises(ValueError) as ctx:
            self.sample(supplier_name="   ")
        self.assertIn("Item name and supplier name are required fields.", str(ctx.exception))

    def test_negative_financials_rejected(self):
        with self.assertRaises(ValueError) as ctx:
            self.sample(fixed_unit_cost=-1)
        self.assertIn("Financial figures cannot be negative.", str(ctx.exception))
        with self.assertRaises(ValueError) as ctx:
            self.sample(base_retail_price=-0.01)
        self.assertIn("Financial figures cannot be negative.", str(ctx.exception))

    def test_non_finite_financials_rejected(self):
        for bad in (float("nan"), float("inf"), "not-a-number", None, True):
            with self.assertRaises(ValueError):
                self.sample(fixed_unit_cost=bad)

    def test_money_keeps_two_decimal_precision(self):
        payload = self.sample(fixed_unit_cost="45000.5", base_retail_price=85000.125)
        self.assertEqual(payload["fixed_unit_cost"], 45000.5)
        self.assertEqual(payload["base_retail_price"], 85000.13)  # ROUND_HALF_UP

    def test_condition_notes_defaults_to_premium_grade(self):
        payload = self.service.sanitize_item_payload(
            item_name="Jacket", supplier_name="Finds Ug", catalog_group="Outerwear",
            subcategory="Windbreaker", fixed_unit_cost=1, base_retail_price=2,
            size_availability="L", color="Red", image_url="https://img/x.jpg",
        )
        self.assertEqual(payload["condition_notes"], "Premium Grade 1")

    def test_created_at_sentinels_resolve_to_iso_utc(self):
        for sentinel in (None, "NOW()", "now()", "CURRENT_TIMESTAMP", ""):
            payload = self.sample(created_at=sentinel)
            parsed = datetime.fromisoformat(payload["created_at"])
            self.assertEqual(parsed.tzinfo, timezone.utc)

    def test_created_at_accepts_iso_and_rejects_junk(self):
        payload = self.sample(created_at="2026-10-25T10:00:00+00:00")
        self.assertTrue(payload["created_at"].startswith("2026-10-25T10:00:00"))
        with self.assertRaises(ValueError):
            self.sample(created_at="not-a-timestamp")

    def test_decimal_inputs_are_accepted(self):
        payload = self.sample(
            fixed_unit_cost=Decimal("45000.00"), base_retail_price=Decimal("85000.00")
        )
        self.assertEqual(payload["fixed_unit_cost"], 45000.0)
        self.assertEqual(payload["base_retail_price"], 85000.0)


class IngestSingleItemTests(unittest.TestCase):
    def test_insert_targets_catalog_items_with_the_payload(self):
        service, fake = make_service()
        payload = service.sanitize_item_payload(
            item_name="Adidas Red & White Full-Zip Windbreaker",
            supplier_name="Finds Ug",
            catalog_group="Outerwear",
            subcategory="Full-Zip Hooded Windbreaker",
            fixed_unit_cost=45000.00,
            base_retail_price=85000.00,
            size_availability="Medium / Large",
            color="Red / White",
            image_url="https://storage.googleapis.com/adonai-assets/adidas-windbreaker.jpg",
            condition_notes="Excellent vintage condition, inspected and approved.",
        )
        result = service.ingest_single_item(payload)
        self.assertEqual(result["status"], "success")
        self.assertEqual(result["data"], [payload])
        self.assertEqual(fake.store["table"], CATALOG_ITEMS_TABLE)
        self.assertEqual(fake.store["payload"], payload)

    def test_database_failures_return_error_dictionary(self):
        service, _ = make_service(FakeSupabase(fail=True))
        result = service.ingest_single_item({"item_name": "x"})
        self.assertEqual(result["status"], "error")
        self.assertIn("connection refused", result["message"])

    def test_missing_supabase_package_raises_clear_error(self):
        with mock.patch.object(supplier_ingestion, "create_client", None):
            with self.assertRaises(RuntimeError) as ctx:
                SupplierCatalogIngestionService("https://demo.supabase.co", "key")
        self.assertIn("supabase", str(ctx.exception))

    def test_blank_credentials_rejected(self):
        with self.assertRaises(ValueError):
            SupplierCatalogIngestionService("", "")


class MigrationContractTests(unittest.TestCase):
    """The Supabase schema must carry the documented catalog_items columns."""

    SQL = (ROOT / "migrations" / "20261025_direct_supplier_upload.sql").read_text(encoding="utf-8")

    def test_columns_and_checks_are_present(self):
        self.assertIn("ADD COLUMN IF NOT EXISTS supplier_name VARCHAR(255)", self.SQL)
        self.assertIn("ADD COLUMN IF NOT EXISTS fixed_unit_cost NUMERIC(12, 2)", self.SQL)
        self.assertIn("ADD COLUMN IF NOT EXISTS base_retail_price NUMERIC(12, 2)", self.SQL)
        self.assertRegex(self.SQL, re.compile(r"CHECK \(fixed_unit_cost[^)]*\)"))
        self.assertRegex(self.SQL, re.compile(r"CHECK \(base_retail_price[^)]*\)"))

    def test_view_exposes_supplier_and_economics_columns(self):
        for column in ("supplier_name", "fixed_unit_cost", "base_retail_price",
                       "item_name", "catalog_group", "size_availability", "condition_notes"):
            self.assertIn(column, self.SQL)

    def test_insert_trigger_maps_direct_uploads_onto_products(self):
        self.assertIn("INSTEAD OF INSERT ON catalog_items", self.SQL)
        self.assertIn("adonai_catalog_items_insert()", self.SQL)


if __name__ == "__main__":
    unittest.main(verbosity=2)
