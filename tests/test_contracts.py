import unittest

from dashboard import contracts


class ContractMirrorTests(unittest.TestCase):
    def test_profile_state_is_scoped_and_stable(self):
        state = contracts.create_profile_state("researcher", {"session": {"stored_id": "s1"}}, now=1700000000000)
        self.assertEqual(state["profile"], "researcher")
        self.assertEqual(state["session"], {"stored_id": "s1", "runtime_id": ""})
        self.assertEqual(contracts.create_profile_state("writer", now=1700000000000)["session"]["stored_id"], "")
        with self.assertRaises(ValueError):
            contracts.create_profile_state("researcher", {"token": "not allowed"})

    def test_isolation_binding_rejects_cross_profile_socket(self):
        binding = contracts.create_isolation_binding("researcher")
        self.assertEqual(binding["desktop_name"], "hermes:researcher")
        binding["gateway_socket"] = "/run/hermes/writer/gateway.sock"
        with self.assertRaisesRegex(ValueError, "aislamiento"):
            contracts.validate_isolation_binding(binding, "researcher")

    def test_authorization_ledger_is_revocable_and_secret_free(self):
        ledger = contracts.create_authorization_ledger("researcher", now=1700000000000)
        ledger = contracts.grant_authorization(ledger, {"grant_id": "g1", "service": "gmail", "account": "demo@example.com", "capabilities": ["read"], "persistent": True}, now=1700000000000)
        self.assertTrue(contracts.is_authorization_active(ledger, "g1", "read"))
        self.assertEqual(ledger["grants"][0]["owner"]["profile"], "researcher")
        with self.assertRaisesRegex(ValueError, "secreto|secreta"):
            contracts.grant_authorization(ledger, {"service": "gmail", "account": "demo@example.com", "capabilities": ["read"], "token": "secret"})
        revoked = contracts.revoke_authorization(ledger, "g1", now=1700000000001)
        self.assertFalse(contracts.is_authorization_active(revoked, "g1", "read"))

    def test_audit_event_has_operational_metadata_only(self):
        event = contracts.create_audit_event(event_id="a1", profile="researcher", type="response.normalized", metadata={"response_id": "r1"}, at=1700000000000)
        self.assertEqual(event["contract_version"], contracts.CONTRACT_VERSION)
        with self.assertRaises(ValueError):
            contracts.create_audit_event(event_id="a2", profile="researcher", type="message.received", metadata={"text": "no"})

    def test_multimodal_response_uses_descriptors_and_safe_markdown(self):
        response = contracts.normalize_multimodal_response({"profile": "researcher", "text": "# Hola\n\n<script>x</script>", "attachments": [{"id": "a1", "name": "x.md", "type": "text/markdown", "size": 2, "storage_key": "hermes-bots-console://researcher/a1"}], "voice": {"mime_type": "audio/webm", "duration_ms": 4, "source": "microphone"}})
        self.assertEqual(response["markdown"]["format"], "gfm-safe")
        self.assertFalse("<script>" in response["markdown"]["source"])
        with self.assertRaises(ValueError):
            contracts.normalize_multimodal_response({"profile": "researcher", "text": "x", "data_url": "data:audio/webm;base64,secret"})
        with self.assertRaisesRegex(ValueError, "contrato|profile"):
            contracts.normalize_attachment_descriptor({"name": "x.md", "type": "text/markdown", "size": 2, "storage_key": "hermes-bots-console://researcherish/a1"}, "researcher")
        with self.assertRaisesRegex(ValueError, "contrato|profile"):
            contracts.normalize_attachment_descriptor({"name": "x.md", "type": "text/markdown", "size": 2, "storage_key": "https://researcher/a1"}, "researcher")

    def test_dry_run_fixture_contains_all_surfaces(self):
        fixture = contracts.create_dry_run_fixture("researcher", now=1700000000000)
        self.assertEqual(fixture["isolation"]["lease"]["profile"], "researcher")
        self.assertEqual(fixture["authorization"]["grants"][0]["owner"]["profile"], "researcher")
        self.assertEqual(fixture["screen"]["rfb"]["protocol"], "003.008")
        self.assertEqual(len(fixture["group"]["room"]["members"]), 2)
        self.assertIn("groups.send", fixture["group"]["capabilities"]["methods"])
        self.assertEqual(fixture["response"]["voice"]["status"], "ready")


if __name__ == "__main__":
    unittest.main()
