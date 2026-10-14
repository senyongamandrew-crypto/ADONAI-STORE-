"""Regression tests for explicit SQLite DATABASE_URL handling."""
import json
import os
import subprocess
import sys
import unittest


class DatabaseUrlDetectionTests(unittest.TestCase):
    def test_sqlite_url_selects_sqlite_mode(self):
        env = os.environ.copy()
        env["DATABASE_URL"] = "sqlite:///:memory:"
        result = subprocess.run(
            [
                sys.executable,
                "-c",
                "import json; from database import get_formatted_database_url; "
                "url, is_postgres = get_formatted_database_url(); "
                "print(json.dumps({'url': url, 'is_postgres': is_postgres}))",
            ],
            cwd=os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
            env=env,
            capture_output=True,
            check=True,
            text=True,
        )
        payload = json.loads(result.stdout.strip().splitlines()[-1])
        self.assertEqual(payload["url"], "sqlite:///:memory:")
        self.assertFalse(payload["is_postgres"])


if __name__ == "__main__":
    unittest.main()
