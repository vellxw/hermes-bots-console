import json
import os
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from dashboard.turbo_policy import EXCEPTIONS, TurboStore, redact


class TurboPolicyTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parents[1] / "tests")
        self.root = Path(self.temp.name)
        self.store = TurboStore(self.root, clock=lambda: 1700000000000)
        self.grant = {"service": "web", "account": "demo@example.com", "capabilities": ["read", "write"], "persistent": True}
        self.op = {"profile": "alpha", "service": "web", "account": "demo@example.com", "capability": "read", "tool": "browser_snapshot", "evidence": "fixture-1", "expected_result": "read_only"}

    def tearDown(self):
        self.temp.cleanup()

    def test_persistence_mode_revoke_and_isolation(self):
        self.store.set_mode("alpha", "autonomous")
        state = self.store.grant("alpha", self.grant)
        self.assertEqual(state["grants"][0]["owner"]["profile"], "alpha")
        restarted = TurboStore(self.root)
        self.assertEqual(restarted.get("alpha")["mode"], "autonomous")
        self.assertTrue(restarted.authorize("alpha", self.op)["allowed"])
        restarted.revoke("alpha", state["grants"][0]["grant_id"])
        self.assertEqual(TurboStore(self.root).get("alpha")["grants"][0]["status"], "revoked")
        self.assertFalse(restarted.authorize("alpha", self.op)["allowed"])
        self.assertEqual(restarted.get("beta")["grants"], [])
        self.assertEqual(restarted.get("beta")["audit"], [])
        if os.name != "nt":  # Windows does not expose POSIX permission bits
            self.assertEqual((self.root / "alpha.json").stat().st_mode & 0o777, 0o600)

    def test_pending_cancel_and_single_use(self):
        self.store.set_mode("alpha", "autonomous")
        pending = self.store.grant("alpha", {**self.grant, "status": "pending", "persistent": False})
        grant_id = pending["grants"][0]["grant_id"]
        self.assertFalse(self.store.authorize("alpha", self.op)["allowed"])
        self.store.respond("alpha", grant_id, "cancel")
        self.assertEqual(self.store.get("alpha")["grants"][0]["status"], "revoked")
        pending = self.store.grant("alpha", {**self.grant, "status": "pending", "persistent": False})
        self.store.respond("alpha", pending["grants"][-1]["grant_id"], "once")
        self.assertTrue(self.store.authorize("alpha", self.op)["allowed"])
        self.assertFalse(self.store.authorize("alpha", self.op)["allowed"])

    def test_once_consumed_atomically(self):
        self.store.set_mode("alpha", "autonomous")
        self.store.grant("alpha", {**self.grant, "persistent": False})
        with ThreadPoolExecutor(max_workers=4) as pool:
            results = list(pool.map(lambda _: TurboStore(self.root).authorize("alpha", self.op), range(4)))
        self.assertEqual(sum(result["allowed"] for result in results), 1)

    def test_modes_dry_run_and_exceptions_never_execute(self):
        for mode in ("planning", "simulation"):
            self.store.set_mode("alpha", mode)
            for capability in ("write", "confirm"):
                self.assertEqual(self.store.authorize("alpha", {**self.op, "capability": capability})["reason"], "mode_restriction")
        self.store.set_mode("alpha", "autonomous")
        self.store.grant("alpha", self.grant)
        for exception in EXCEPTIONS:
            self.assertTrue(self.store.authorize("alpha", {**self.op, "exceptions": [exception]})["requires_confirmation"])
        result = self.store.authorize("alpha", {**self.op, "dry_run": True})
        self.assertEqual(result["executed"], False)
        self.assertTrue(result["allowed"])

    def test_scope_mismatch_and_expiry(self):
        self.store.set_mode("alpha", "autonomous")
        self.store.grant("alpha", self.grant)
        for patch in ({"profile": "beta"}, {"account": "other@example.com"}, {"service": "gmail"}, {"capability": "confirm"}):
            self.assertFalse(self.store.authorize("alpha", {**self.op, **patch})["allowed"])
        with self.assertRaises(ValueError):
            self.store.grant("alpha", {**self.grant, "profile": "beta"})
        self.store.grant("alpha", {**self.grant, "expires_at": 1})
        self.assertFalse(self.store.authorize("alpha", self.op)["allowed"])

    def test_audit_has_operational_evidence_and_no_secrets(self):
        self.store.set_mode("alpha", "autonomous")
        self.store.grant("alpha", self.grant)
        self.store.authorize("alpha", self.op)
        audit = TurboStore(self.root).get("alpha")["audit"][-1]
        self.assertEqual(audit["profile"], "alpha")
        for field in ("account", "tool", "evidence", "expected_result"):
            self.assertEqual(audit["metadata"][field], self.op[field])
        for secret in ({"token": "FAKE_SECRET"}, {"nested": {"cookie": "FAKE_COOKIE"}}, {"account": "password=FAKE_PASSWORD"}, {"connection_string": "FAKE_CONNECTION"}, {"code": "123456"}):
            with self.assertRaises(ValueError):
                self.store.grant("alpha", {**self.grant, **secret})
        output = redact({"token": "FAKE_SECRET", "nested": {"cookie": "FAKE_COOKIE"}, "detail": "password=FAKE_PASSWORD"})
        self.assertNotIn("FAKE_", json.dumps(output))
        self.assertIn("[REDACTED]", json.dumps(output))
        self.assertNotIn("FAKE_", (self.root / "alpha.json").read_text())

    def test_secret_values_inside_arrays_are_rejected(self):
        for secret in ({"capabilities": ["token=FAKE_SECRET"]}, {"evidence": ["password=FAKE_SECRET"]}):
            with self.assertRaises(ValueError):
                self.store.grant("alpha", {**self.grant, **secret})

    def test_authorization_never_claims_execution(self):
        self.store.set_mode("alpha", "autonomous")
        self.store.grant("alpha", self.grant)
        self.assertFalse(self.store.authorize("alpha", self.op)["executed"])

    def test_risk_aliases_and_mixed_exceptions_fail_closed(self):
        self.store.set_mode("alpha", "autonomous")
        self.store.grant("alpha", self.grant)
        for patch in ({"risk": "high_risk"}, {"exceptions": [], "exception": "payment"}, {"exception": "mass_delete"}):
            decision = self.store.authorize("alpha", {**self.op, **patch})
            self.assertFalse(decision["allowed"])
            self.assertTrue(decision["requires_confirmation"])

    def test_incomplete_operations_are_not_authorized(self):
        for mode in ("planning", "simulation", "autonomous"):
            self.store.set_mode("alpha", mode)
            for field in ("profile", "service", "account", "tool", "capability"):
                operation = {k: v for k, v in self.op.items() if k != field}
                self.assertFalse(self.store.authorize("alpha", operation)["allowed"], field)

    def test_stale_consent_cannot_reactivate_a_revoked_grant(self):
        pending = self.store.grant("alpha", {**self.grant, "status": "pending"})
        grant_id = pending["grants"][0]["grant_id"]
        self.store.respond("alpha", grant_id, "always")
        self.store.revoke("alpha", grant_id)
        with self.assertRaises(ValueError):
            self.store.respond("alpha", grant_id, "always")
        new_pending = self.store.grant("alpha", {**self.grant, "status": "pending"})
        self.assertNotEqual(new_pending["grants"][0]["grant_id"], grant_id)

    def test_pending_survives_restart_and_dry_run_does_not_consume_once(self):
        self.store.set_mode("alpha", "autonomous")
        pending = self.store.grant("alpha", {**self.grant, "status": "pending", "persistent": False})
        grant_id = pending["grants"][0]["grant_id"]
        self.assertEqual(TurboStore(self.root).get("alpha")["grants"][0]["status"], "pending")
        self.store.respond("alpha", grant_id, "once")
        self.assertTrue(self.store.authorize("alpha", {**self.op, "dry_run": True})["allowed"])
        self.assertTrue(self.store.authorize("alpha", self.op)["allowed"])
        self.assertFalse(self.store.authorize("alpha", self.op)["allowed"])

    def test_identifiers_are_never_silently_normalized(self):
        for invalid in ("Alpha", " alpha", "alpha ", "../beta"):
            with self.assertRaises(ValueError):
                self.store.get(invalid)
        with self.assertRaises(ValueError):
            self.store.grant("alpha", {**self.grant, "account": "a" * 161})

    def test_audit_is_bounded_unique_and_records_mode(self):
        for _ in range(205):
            self.store.set_mode("alpha", "simulation")
        audit = json.loads((self.root / "alpha.json").read_text())["audit"]
        self.assertEqual(len(audit), 200)
        self.assertEqual(len({row["event_id"] for row in audit}), 200)
        self.assertEqual(audit[-1]["metadata"]["mode"], "simulation")

    def test_invalid_state_corruption_fails_closed(self):
        (self.root / "alpha.json").write_text("{broken")
        with self.assertRaises(ValueError):
            self.store.get("alpha")

    def test_no_symlink_or_profile_traversal(self):
        with self.assertRaises(ValueError):
            self.store.get("../beta")
        target = self.root / "other.json"
        target.write_text("{}")
        (self.root / "alpha.json").symlink_to(target)
        with self.assertRaises(ValueError):
            self.store.get("alpha")


if __name__ == "__main__":
    unittest.main()
