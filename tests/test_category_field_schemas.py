"""Dynamic category field schemas: definitions, API and server validation.

Catalog Intake resolves ONE JSON form per category + sub-group
(category_field_schemas). These tests pin the contract the browser relies
on: the public schema endpoint, unit-aware validation (earrings in mm, never
inches), hidden fields that never leak, required details that block intake,
inspection points for pre-loved shoes only, legacy column projections,
automated search tags, and edit rules that keep complete records complete.
"""
import copy
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from urllib.parse import parse_qs

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
_TEMP = tempfile.TemporaryDirectory(prefix="adonai-schema-tests-")
os.environ.update({
    "DATABASE_URL": "sqlite:///" + str(Path(_TEMP.name) / "schemas.db"),
    "ADONAI_REQUIRE_STAFF_AUTH": "0",
    "ADONAI_RATE_LIMIT_DISABLED": "1",
    "ADONAI_SEED_DEMO_CATALOG": "0",
    "ADONAI_SEED_DEMO_USERS": "0",
})
import database
database.IS_POSTGRES = False
from db_init import init_db
import api
import catalog_schemas
from database import get_db
from models import CategoryFieldSchema, Category, Product

_SKU = [0]


def call(method, path, body=None, query=""):
    raw = json.dumps(body).encode() if body is not None else b""
    status, _headers, payload = api.handle_api_request(
        method, path, parse_qs(query) if query else {}, raw, headers={}, client_addr="schema-tests")[:3]
    return status, json.loads(payload)


def new_item(category, subcategory, attributes=None, **extra):
    _SKU[0] += 1
    sku = f"ADN-SCH-{_SKU[0]:04d}"
    body = {
        "name": f"{subcategory} test piece", "category": category, "subcategory": subcategory,
        "base_price": 25000, "sku": sku, "barcode_id": sku, "item_condition": "BRAND_NEW", "in_stock_count": 2,
    }
    if attributes is not None:
        body["attributes"] = attributes
    body.update(extra)
    if body["item_condition"] == "PRE_LOVED":
        body["barcode_id"] = f"{sku}-1OF1"
        body["in_stock_count"] = 1
    return body


EARRINGS = {
    "schema_key": "earrings",
    "values": {
        "length": {"value": 8, "unit": "mm"}, "stud_depth": {"value": 6, "unit": "mm"},
        "pair_weight": {"value": 1.8, "unit": "g"}, "primary_metal": "925 sterling silver",
        "accent_material": "Cubic Zirconia", "backing_type": "Lever-Back", "nickel_free": True,
    },
    "photo_angles": {"macro_front": 0, "hallmark": 1},
}

BOOTS = {
    "schema_key": "footwear",
    "values": {
        "tagged_size": {"value": "42", "scale": "EU"}, "insole_length": {"value": 27, "unit": "cm"},
        "shaft_height": {"value": 14, "unit": "cm"}, "upper_material": "Suede", "fastening": "Elastic Gusset",
    },
    "inspection": {"tread_wear": "Light wear", "insole_compression": "Like new",
                   "heel_counter": "Like new", "toebox_creasing": "Moderate wear"},
}


class SchemaDocumentTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        assert init_db(), "Isolated schema database failed to initialize"

    def test_bundled_document_is_valid_and_covers_every_category(self):
        doc = catalog_schemas.load_defaults()
        catalog_schemas.validate_document(catalog_schemas.expand_document(copy.deepcopy(doc)))
        with get_db() as session:
            names = {row.name for row in session.query(Category).all()}
        self.assertTrue(names, "categories are seeded")
        for name in names:
            self.assertTrue(catalog_schemas.subcategories_for(name), f"{name} has at least one sub-group form")

    def test_requested_option_sets_and_units_are_present(self):
        doc = catalog_schemas.document()
        def field(schema, key):
            return next(f for _, f in catalog_schemas.iter_fields(doc["schemas"][schema]) if f["key"] == key)
        # Earrings: millimetres and grams only — never inches or fabric.
        for key in ("length", "width", "diameter", "stud_depth"):
            self.assertEqual(field("earrings", key)["units"], ["mm"])
        self.assertEqual(field("earrings", "pair_weight")["units"], ["g"])
        self.assertTrue({"925 Sterling Silver", "18K Gold Plated", "Stainless Steel", "Brass"} <= set(field("earrings", "primary_metal")["options"]))
        self.assertTrue({"Cubic Zirconia", "Glass", "Pearl", "Acrylic"} <= set(field("earrings", "accent_material")["options"]))
        self.assertEqual(len(field("earrings", "backing_type")["options"]), 7)
        self.assertTrue({"High-Gloss Polish", "Brushed Matte", "Hammered", "Antique Patina"} <= set(field("rings_bracelets", "metal_finish")["options"]))
        self.assertTrue({"Lobster Claw", "Toggle", "Box Latch", "Magnetic"} <= set(field("rings_bracelets", "clasp_type")["options"]))
        self.assertEqual(field("rings_bracelets", "ring_size")["scales"], ["US", "EU", "UK"])
        self.assertTrue({"Curb", "Rope", "Box", "Snake", "Figaro", "Cuban"} <= set(field("necklaces", "chain_link_type")["options"]))
        self.assertEqual(field("necklaces", "chain_length")["units"], ["in", "cm"])
        self.assertTrue({"French Terry", "Single Jersey", "Ripstop"} <= set(field("tops", "knit_weave")["options"]))
        self.assertTrue({"Cashmere", "Acrylic Knit", "Silk", "Pashmina", "Wool"} <= set(field("scarves", "material_type")["options"]))
        self.assertTrue({"Full-Grain Leather", "Synthetic Mesh", "Canvas", "EVA Foam"} <= set(field("footwear", "upper_material")["options"]))
        self.assertEqual(field("footwear", "tagged_size")["scales"], ["EU", "US", "UK", "CM"])
        self.assertTrue({"Cordura Nylon", "Canvas", "Genuine Leather"} <= set(field("bags", "exterior_shell")["options"]))
        self.assertEqual(field("bags", "capacity")["units"], ["L"])
        # Every schema ships a photo protocol, and jewelry hides garment size.
        for key, schema in doc["schemas"].items():
            self.assertTrue(schema.get("photo_protocol"), f"{key} has photo angles")
        for key in ("earrings", "rings_bracelets", "necklaces"):
            self.assertIn("size", doc["schemas"][key]["core"]["hide"])
        self.assertEqual(len(doc["schemas"]["footwear"]["inspection"]["points"]), 4)

    def test_measurements_are_optional_and_never_block_saving(self):
        """Dimensions & Sizing is opt-in detail: no measure field — in any
        schema, for any condition — may keep staff from saving an item."""
        doc = catalog_schemas.load_defaults()
        for key, schema in doc["schemas"].items():
            for section, field in catalog_schemas.iter_fields(schema):
                if field.get("type") == "measure":
                    self.assertFalse(field.get("required"), f"{key}.{field['key']} must stay optional")
                    self.assertFalse(field.get("required_when"), f"{key}.{field['key']} must stay optional")
                self.assertNotIn("require_any", section, f"{key}.{section['id']} must not demand a measurement")
        # A pre-loved tee with composition but no dimensions normalises fine…
        result = catalog_schemas.normalize_attributes(
            {"schema_key": "tops", "values": {"material_composition": "100% Cotton"}},
            "Tops & Shirts", "T-Shirts", "PRE_LOVED", enforce_required=True)
        self.assertNotIn("chest", result["attributes"]["values"])
        self.assertNotIn("length", result["attributes"]["values"])
        # …and so does a bracelet with neither wrist measurement.
        result = catalog_schemas.normalize_attributes(
            {"schema_key": "rings_bracelets", "values": {
                "core_metal": "Brass", "adjustability": "Fixed diameter"}},
            "Bracelets & Bangles", "Bracelets", "BRAND_NEW", enforce_required=True)
        self.assertNotIn("inner_diameter", result["attributes"]["values"])
        # Entered measurements are still validated (wrong units stay wrong).
        with self.assertRaises(catalog_schemas.SchemaValidationError):
            catalog_schemas.normalize_attributes(
                {"schema_key": "tops", "values": {
                    "material_composition": "100% Cotton",
                    "chest": {"value": 56, "unit": "in"}}},
                "Tops & Shirts", "T-Shirts", "PRE_LOVED", enforce_required=True)

    def test_parity_fixture_matches_server_engine(self):
        """The same fixture is asserted by tests/catalog-schemas-engine.test.js."""
        fixture = json.loads((ROOT / "tests/fixtures/catalog-schema-parity.json").read_text())
        for case in fixture["cases"]:
            expected = case["expected"]
            with self.subTest(case["name"]):
                try:
                    result = catalog_schemas.normalize_attributes(
                        case["payload"], case["category"], case["subcategory"], case["item_condition"], enforce_required=True)
                except catalog_schemas.SchemaValidationError as exc:
                    self.assertFalse(expected["ok"])
                    self.assertEqual(exc.field_errors, expected["errors"])
                    continue
                self.assertTrue(expected["ok"])
                attributes = result["attributes"]
                self.assertEqual(attributes["values"], expected["values"])
                self.assertEqual(attributes.get("inspection", {}), expected["inspection"])
                self.assertEqual(result["projections"], expected["projections"])
                tags = catalog_schemas.auto_search_tags(
                    category=case["category"], subcategory=result["subcategory"], brand=case.get("brand", ""),
                    color=case.get("color", ""), item_condition=case["item_condition"], attributes=attributes)
                self.assertEqual(tags, expected["tags"])
                self.assertEqual(catalog_schemas.specifications(attributes), expected["specifications"])

    def test_resolution_and_conditional_fields(self):
        key, _schema, sub = catalog_schemas.resolve("Rings & Earrings", "hoop earrings")
        self.assertEqual((key, sub), ("earrings", "Hoop Earrings"))
        key, _schema, sub = catalog_schemas.resolve("Rings & Earrings", "")
        self.assertEqual(sub, "Stud Earrings", "empty sub-group falls back to the first entry")
        with self.assertRaises(catalog_schemas.SchemaValidationError):
            catalog_schemas.resolve("Rings & Earrings", "Tiaras")
        _, bags, _ = catalog_schemas.resolve("Bags & Handbags", "Clutches & Evening Bags")
        strap = next(f for _, f in catalog_schemas.iter_fields(bags) if f["key"] == "strap_drop")
        self.assertFalse(catalog_schemas.field_visible(strap, {"subcategory": "Clutches & Evening Bags"}))
        self.assertTrue(catalog_schemas.field_visible(strap, {"subcategory": "Backpacks"}))


class SchemaApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        assert init_db(), "Isolated schema database failed to initialize"

    def test_public_schema_endpoint(self):
        status, data = call("GET", "/api/catalog/field-schemas")
        self.assertEqual(status, 200)
        self.assertTrue(data["ok"])
        self.assertIn("earrings", data["schemas"])
        self.assertIn("Rings & Earrings", data["taxonomy"])
        status, data = call("GET", "/api/catalog/field-schemas", query="category=Boots&subcategory=Chelsea Boots")
        self.assertEqual(status, 200)
        self.assertEqual(data["schema_key"], "footwear")
        self.assertEqual(data["subcategory"], "Chelsea Boots")
        self.assertIn("Knee-High Boots", data["subcategories"])
        self.assertIn("cm", data["units"])
        status, data = call("GET", "/api/catalog/field-schemas", query="category=Boots&subcategory=Tiaras")
        self.assertEqual(status, 400)

    def test_required_details_and_units_block_intake(self):
        status, data = call("POST", "/api/products", new_item("Rings & Earrings", "Stud Earrings", {"schema_key": "earrings", "values": {"length": {"value": 8, "unit": "mm"}}}))
        self.assertEqual(status, 400)
        self.assertEqual(set(data["field_errors"]), {"primary_metal", "backing_type", "nickel_free"})
        inches = copy.deepcopy(EARRINGS)
        inches["values"]["length"] = {"value": 0.3, "unit": "in"}
        status, data = call("POST", "/api/products", new_item("Rings & Earrings", "Stud Earrings", inches))
        self.assertEqual(status, 400)
        self.assertIn("mm", data["field_errors"]["length"], "earrings are never measured in inches")
        mismatch = copy.deepcopy(EARRINGS)
        mismatch["schema_key"] = "tops"
        status, data = call("POST", "/api/products", new_item("Rings & Earrings", "Stud Earrings", mismatch))
        self.assertEqual(status, 400)
        self.assertIn("schema_key", data["field_errors"])

    def test_valid_earrings_store_attributes_projections_and_tags(self):
        payload = copy.deepcopy(EARRINGS)
        payload["values"]["chest"] = {"value": 40, "unit": "in"}            # garment key → dropped
        payload["values"]["diameter"] = {"value": 12, "unit": "mm"}          # visible for studs
        payload["photo_angles"]["not_an_angle"] = 2
        status, data = call("POST", "/api/products", new_item("Rings & Earrings", "Stud Earrings", payload, fulfillment_notes="Ships in a padded jewelry box"))
        self.assertEqual(status, 201, data)
        product = data["product"]
        attributes = product["attributes"]
        self.assertEqual(attributes["schema_key"], "earrings")
        self.assertTrue(attributes["complete"])
        self.assertNotIn("chest", attributes["values"])
        self.assertEqual(attributes["values"]["primary_metal"], "925 Sterling Silver", "option casing is normalised")
        self.assertEqual(attributes["photo_angles"], {"macro_front": 0, "hallmark": 1})
        self.assertEqual(product["subcategory"], "Stud Earrings")
        self.assertEqual(product["fabric"], "925 Sterling Silver · Cubic Zirconia")
        self.assertEqual(product["measurements"], {}, "jewelry never gets inch flat-lay rows")
        self.assertIn("nickel-free", product["search_tags"])
        self.assertIn("lever-back", product["search_tags"])
        self.assertEqual(product["fulfillment_notes"], "Ships in a padded jewelry box")
        labels = {row["label"]: row["value"] for row in product["specifications"]}
        self.assertEqual(labels["Length"], "8 mm")
        self.assertEqual(product["photo_angle_labels"]["0"], "Macro front face")

    def test_hidden_subgroup_fields_never_leak(self):
        payload = copy.deepcopy(EARRINGS)
        status, data = call("POST", "/api/products", new_item("Rings & Earrings", "Dangle Earrings", payload))
        self.assertEqual(status, 201, data)
        self.assertNotIn("stud_depth", data["product"]["attributes"]["values"], "stud depth is a stud-only field")

    def test_footwear_inspection_only_for_pre_loved_and_inch_projection(self):
        partial = copy.deepcopy(BOOTS)
        partial["inspection"] = {"tread_wear": "Light wear"}
        status, data = call("POST", "/api/products", new_item("Boots", "Chelsea Boots", partial, item_condition="PRE_LOVED"))
        self.assertEqual(status, 400)
        self.assertIn("inspection.heel_counter", data["field_errors"])
        status, data = call("POST", "/api/products", new_item("Boots", "Chelsea Boots", copy.deepcopy(BOOTS), item_condition="PRE_LOVED"))
        self.assertEqual(status, 201, data)
        product = data["product"]
        self.assertEqual(product["size"], "EU 42")
        self.assertEqual(product["fabric"], "Suede")
        self.assertEqual(product["measurements"], {"insole": 10.63})
        self.assertEqual(product["attributes"]["inspection"]["toebox_creasing"], "Moderate wear")
        brand_new = copy.deepcopy(BOOTS)
        brand_new.pop("inspection")
        del brand_new["values"]["insole_length"]
        status, data = call("POST", "/api/products", new_item("Boots", "Chelsea Boots", brand_new))
        self.assertEqual(status, 201, data)
        self.assertNotIn("inspection", data["product"]["attributes"])

    def test_legacy_payload_without_attributes_still_saves(self):
        body = new_item("Tops & Shirts", "", None)
        body.pop("subcategory")
        status, data = call("POST", "/api/products", body)
        self.assertEqual(status, 201, data)
        self.assertEqual(data["product"]["attributes"], {})
        self.assertTrue(data["product"]["search_tags"], "tags are generated even for legacy intake")

    def test_custom_tags_override_and_edits_keep_them(self):
        status, data = call("POST", "/api/products", new_item("Rings & Earrings", "Stud Earrings", copy.deepcopy(EARRINGS), search_tags="Gift Idea, studs , gift idea"))
        self.assertEqual(status, 201, data)
        pid = data["product"]["id"]
        self.assertEqual(data["product"]["search_tags"], ["gift idea", "studs"])
        status, data = call("PUT", f"/api/products/{pid}", {"brand": "Pandora"})
        self.assertEqual(data["product"]["search_tags"], ["gift idea", "studs"], "edits never overwrite curated tags")
        status, data = call("PUT", f"/api/products/{pid}", {"search_tags": []})
        self.assertIn("pandora", data["product"]["search_tags"], "an empty list regenerates tags")

    def test_complete_records_cannot_regress_and_failed_edit_rolls_back(self):
        status, data = call("POST", "/api/products", new_item("Rings & Earrings", "Stud Earrings", copy.deepcopy(EARRINGS)))
        pid = data["product"]["id"]
        status, data = call("PUT", f"/api/products/{pid}", {"name": "Renamed studs", "attributes": {"schema_key": "earrings", "values": {"length": {"value": 9, "unit": "mm"}}}})
        self.assertEqual(status, 400)
        self.assertIn("primary_metal", data["field_errors"])
        with get_db() as session:
            stored = session.get(Product, pid)
            self.assertNotEqual(stored.name, "Renamed studs", "a rejected edit must not half-apply")
            self.assertEqual(stored.attribute_record["values"]["length"]["value"], 8)

    def test_category_resend_keeps_and_subgroup_switch_clears(self):
        status, data = call("POST", "/api/products", new_item("Rings & Earrings", "Hoop Earrings", copy.deepcopy(EARRINGS)))
        pid = data["product"]["id"]
        status, data = call("PUT", f"/api/products/{pid}", {"category": "Rings & Earrings", "selling_price": 30000})
        self.assertEqual(status, 200, data)
        self.assertEqual(data["product"]["subcategory"], "Hoop Earrings")
        self.assertEqual(data["product"]["attributes"]["schema_key"], "earrings")
        status, data = call("PUT", f"/api/products/{pid}", {"subcategory": "Rings"})
        self.assertEqual(status, 200, data)
        self.assertEqual(data["product"]["subcategory"], "Rings")
        self.assertEqual(data["product"]["attributes"], {}, "an earring record is never relabelled as a ring")

    def test_seeding_is_idempotent_and_respects_custom_rows(self):
        self.assertTrue(init_db())
        with get_db() as session:
            self.assertEqual(session.query(CategoryFieldSchema).count(), len(catalog_schemas.load_defaults()["schemas"]))
            row = session.get(CategoryFieldSchema, "scarves")
            definition = copy.deepcopy(row.definition)
            definition["label"] = "Scarves, Wraps & Shawls"
            row.definition = definition
            row.label = "Scarves, Wraps & Shawls"
            row.source = "custom"
        self.assertTrue(init_db())
        with get_db() as session:
            row = session.get(CategoryFieldSchema, "scarves")
            self.assertEqual(row.label, "Scarves, Wraps & Shawls", "custom Supabase edits survive deploys")
            doc = catalog_schemas.refresh_from_db(session, force=True)
        self.assertEqual(doc["schemas"]["scarves"]["label"], "Scarves, Wraps & Shawls")
        status, data = call("GET", "/api/catalog/field-schemas", query="category=Accessories&subcategory=Scarves %26 Wraps")
        self.assertEqual(data["schema"]["label"], "Scarves, Wraps & Shawls")
        with get_db() as session:
            row = session.get(CategoryFieldSchema, "scarves")
            row.source = "system"
        self.assertTrue(init_db())
        with get_db() as session:
            catalog_schemas.refresh_from_db(session, force=True)
            self.assertEqual(session.get(CategoryFieldSchema, "scarves").label, "Scarves & Wraps")

    def test_categories_endpoint_lists_subgroups(self):
        status, data = call("GET", "/api/categories")
        boots = next(row for row in data["categories"] if row["name"] == "Boots")
        self.assertIn("Chelsea Boots", boots["subcategories"])


if __name__ == "__main__":
    unittest.main()
