"""Regression: successful passkey sign-ins must not consume the brute-force budget."""
import os
import sys
import unittest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from security import RateLimiter  # noqa: E402


class AuthRateLimitBudgetTests(unittest.TestCase):
    def test_peek_does_not_consume_slots(self):
        rl = RateLimiter()
        for _ in range(50):
            allowed, _ = rl.peek("auth", "1.2.3.4", 10, 300)
            self.assertTrue(allowed)
        self.assertEqual(rl._hits.get(("auth", "1.2.3.4")), None)

    def test_failures_lock_out_after_limit_and_peek_reports_it(self):
        rl = RateLimiter()
        for _ in range(10):
            self.assertTrue(rl.check("auth", "1.2.3.4", 10, 300)[0])
        allowed, retry = rl.peek("auth", "1.2.3.4", 10, 300)
        self.assertFalse(allowed)
        self.assertGreater(retry, 0)
        self.assertFalse(rl.check("auth", "1.2.3.4", 10, 300)[0])

    def test_other_clients_unaffected(self):
        rl = RateLimiter()
        for _ in range(10):
            rl.check("auth", "1.2.3.4", 10, 300)
        self.assertTrue(rl.peek("auth", "5.6.7.8", 10, 300)[0])


if __name__ == "__main__":
    unittest.main()
