import asyncio
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from dashboard import plugin_api


class TurboApiTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent)
        self.store_path = Path(self.temp.name) / "turbo.json"
        self.patch = patch.object(plugin_api, "_TURBO_STORE", self.store_path)
        self.patch.start()

    def tearDown(self):
        self.patch.stop()
        self.temp.cleanup()

    def run_async(self, awaitable):
        return asyncio.run(awaitable)

    def test_route_persists_mode_grant_and_isolates_profiles(self):
        updated = self.run_async(plugin_api.update_turbo_profile("alpha", {
            "mode": "autonomous",
            "grants": [{
                "service": "example",
                "account": "demo@example.com",
                "capabilities": ["read"],
                "persistent": True,
            }],
        }))
        self.assertEqual(updated["profile"], "alpha")
        self.assertEqual(updated["mode"], "autonomous")
        self.assertEqual(updated["grants"][0]["status"], "active")
        self.assertEqual(self.run_async(plugin_api.get_turbo_profile("alpha"))["mode"], "autonomous")
        other = self.run_async(plugin_api.get_turbo_profile("beta"))
        self.assertEqual(other["mode"], "planning")
        self.assertEqual(other["grants"], [])

    def test_authorize_is_decision_only_and_revoke_reads_back(self):
        state = self.run_async(plugin_api.update_turbo_profile("alpha", {
            "mode": "autonomous",
            "grants": [{
                "service": "example",
                "account": "demo@example.com",
                "capabilities": ["read"],
                "persistent": True,
            }],
        }))
        grant = state["grants"][0]
        operation = {
            "profile": "alpha", "service": "example", "account": "demo@example.com",
            "capability": "read", "tool": "fixture-browser", "evidence": "dry-run",
            "expected_result": "read_only",
        }
        decision = self.run_async(plugin_api.authorize_turbo_operation("alpha", operation))
        self.assertTrue(decision["allowed"])
        self.assertFalse(decision["executed"])
        revoked = self.run_async(plugin_api.revoke_turbo_grant("alpha", "example", "demo@example.com"))
        self.assertEqual(revoked["grants"][0]["grant_id"], grant["grant_id"])
        self.assertEqual(revoked["grants"][0]["status"], "revoked")
        after = self.run_async(plugin_api.authorize_turbo_operation("alpha", operation))
        self.assertFalse(after["allowed"])
        self.assertEqual(after["reason"], "grant_required")

    def test_route_rejects_secret_payload_and_non_literal_profile(self):
        with self.assertRaises(plugin_api.HTTPException) as secret:
            self.run_async(plugin_api.update_turbo_profile("alpha", {
                "grants": [{"service": "example", "account": "demo@example.com",
                            "capabilities": ["read"], "token": "FAKE_TOKEN"}],
            }))
        self.assertEqual(secret.exception.status_code, 400)
        with self.assertRaises(plugin_api.HTTPException):
            self.run_async(plugin_api.get_turbo_profile(" Alpha"))


if __name__ == "__main__":
    unittest.main()
