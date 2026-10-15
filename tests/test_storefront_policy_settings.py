"""Storefront contact-email migrations and public settings serialization."""
import json
import unittest

from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from api import OFFICIAL_STORE_EMAIL, normalize_storefront_promo_ids, public_store_settings
from db_init import seed_settings
from models import StoreSetting


class StorefrontPolicySettingsTests(unittest.TestCase):
    def test_boot_migrates_the_retired_gmail_setting(self):
        engine = create_engine("sqlite:///:memory:")
        StoreSetting.__table__.create(engine)
        try:
            with Session(engine) as session:
                session.add(StoreSetting(key="email", value="AdonaiThriftStore@gmail.com"))
                session.flush()
                seed_settings(session)
                session.commit()
                current = session.query(StoreSetting).filter_by(key="email").one()
                self.assertEqual(current.value, OFFICIAL_STORE_EMAIL)
        finally:
            engine.dispose()

    def test_public_settings_never_expose_the_retired_email(self):
        legacy = StoreSetting(key="email", value="adonaithriftstore@gmail.com")
        blank = StoreSetting(key="email", value=" ")
        official = StoreSetting(key="email", value=OFFICIAL_STORE_EMAIL)
        self.assertEqual(public_store_settings([legacy])["email"], OFFICIAL_STORE_EMAIL)
        self.assertEqual(public_store_settings([blank])["email"], OFFICIAL_STORE_EMAIL)
        self.assertEqual(public_store_settings([official])["email"], OFFICIAL_STORE_EMAIL)

    def test_storefront_promotion_selection_is_normalized_and_bounded(self):
        self.assertEqual(normalize_storefront_promo_ids("AUTO"), "auto")
        self.assertEqual(normalize_storefront_promo_ids("none"), "none")
        self.assertEqual(normalize_storefront_promo_ids('["SKU-2", "SKU-1", "SKU-2"]'), '["SKU-2","SKU-1"]')
        with self.assertRaises(ValueError):
            normalize_storefront_promo_ids("[]")
        with self.assertRaises(ValueError):
            normalize_storefront_promo_ids("not-json")
        with self.assertRaises(ValueError):
            normalize_storefront_promo_ids('["SKU-1", "SKU-2", "SKU-3", "SKU-4", "SKU-5", "SKU-6", "SKU-7", "SKU-8", "SKU-9"]')

    def test_custom_promotion_images_are_validated_ordered_and_accessible(self):
        custom = '{"mode":"custom","items":[{"media_id":"' + "a" * 32 + '","alt_text":"Campaign artwork"},{"media_id":"' + "b" * 32 + '","alt_text":""}]}'
        normalized = normalize_storefront_promo_ids(custom)
        self.assertEqual(normalized, '{"mode":"custom","items":[{"media_id":"' + "a" * 32 + '","alt_text":"Campaign artwork"},{"media_id":"' + "b" * 32 + '","alt_text":""}]}')
        with self.assertRaises(ValueError):
            normalize_storefront_promo_ids('{"mode":"custom","items":[]}')
        with self.assertRaises(ValueError):
            normalize_storefront_promo_ids('{"mode":"custom","items":[{"media_id":"not-an-image-id"}]}')
        with self.assertRaises(ValueError):
            normalize_storefront_promo_ids('{"mode":"custom","items":[{"media_id":"' + "a" * 32 + '"},{"media_id":"' + "a" * 32 + '"}]}')
        too_many = [{"media_id": format(index, "032x"), "alt_text": ""} for index in range(9)]
        with self.assertRaises(ValueError):
            normalize_storefront_promo_ids(json.dumps({"mode": "custom", "items": too_many}))


if __name__ == "__main__":
    unittest.main()
