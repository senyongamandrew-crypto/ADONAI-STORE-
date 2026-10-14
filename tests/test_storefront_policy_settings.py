"""Storefront contact-email migrations and public settings serialization."""
import unittest

from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from api import OFFICIAL_STORE_EMAIL, public_store_settings
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


if __name__ == "__main__":
    unittest.main()
