"""The expanded fashion taxonomy is persisted and exposed by the public API."""
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
_TEMP = tempfile.TemporaryDirectory(prefix="adonai-category-tests-")
os.environ.update({
    "DATABASE_URL": "sqlite:///" + str(Path(_TEMP.name) / "categories.db"),
    "ADONAI_REQUIRE_STAFF_AUTH": "0",
    "ADONAI_RATE_LIMIT_DISABLED": "1",
    "ADONAI_SEED_DEMO_CATALOG": "0",
    "ADONAI_SEED_DEMO_USERS": "0",
})
import database
database.IS_POSTGRES = False
from db_init import init_db
import api


EXPECTED = {
    "Outerwear & Jackets", "Tops & Shirts", "Dresses & Skirts", "Pants & Jeans", "Shoes", "Accessories",
    "Children Wear", "Boots", "Sandals", "Activewear & Sportswear", "Suits & Formalwear", "Underwear & Sleepwear",
    "Bags & Handbags", "Necklaces & Chains", "Bracelets & Bangles", "Rings & Earrings", "Watches",
    "Eyewear & Sunglasses", "Hats, Scarves & Belts", "Traditional & Occasionwear", "Swimwear & Beachwear",
}


class CatalogCategoryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        assert init_db(), "Isolated category schema failed to initialize"

    def test_expanded_categories_are_seeded_and_publicly_listed(self):
        result = api.handle_api_request("GET", "/api/categories", {}, b"", headers={}, client_addr="category-tests")
        self.assertEqual(result[0], 200, result[2])
        categories = json.loads(result[2])["categories"]
        by_name = {row["name"]: row for row in categories}
        self.assertTrue(EXPECTED.issubset(by_name.keys()))
        for name in EXPECTED:
            self.assertTrue(by_name[name]["code"], f"{name} has a category code")
        self.assertEqual(len({row["code"] for row in categories}), len(categories), "category codes remain unique")
        self.assertEqual(len({row["sort_order"] for row in categories}), len(categories), "category order remains deterministic")

    def test_category_seeding_is_idempotent(self):
        self.assertTrue(init_db())
        result = api.handle_api_request("GET", "/api/categories", {}, b"", headers={}, client_addr="category-tests")
        categories = json.loads(result[2])["categories"]
        self.assertEqual(len(categories), 21)
        self.assertTrue(EXPECTED.issubset({row["name"] for row in categories}))


if __name__ == "__main__":
    unittest.main()
