from __future__ import annotations

import asyncio
import tempfile
import unittest
from pathlib import Path

from dashboard import plugin_api


class Upload:
    def __init__(self, filename: str, mime: str, data: bytes):
        self.filename = filename
        self.content_type = mime
        self.data = data

    async def read(self, _limit: int) -> bytes:
        return self.data


class MockTranscriber:
    def __init__(self):
        self.calls = []

    async def transcribe(self, audio_path: Path, *, profile: str, mime_type: str) -> str:
        self.calls.append((audio_path, profile, mime_type, audio_path.read_bytes()))
        return "texto de fixture"


class MockSynthesizer:
    def __init__(self, path: Path):
        self.path = path

    async def synthesize(self, text: str, *, profile: str, voice: str | None = None):
        return {"path": self.path, "mime_type": "audio/webm", "duration_ms": 120}


class MultimodalBackendTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        root = Path(self.temp_dir.name)
        self.attach_root = root / "attachments"
        self.voice_source = root / "mock.webm"
        self.voice_source.write_bytes(b"RIFF fixture")
        self.old_attach_root = plugin_api._ATTACH_ROOT
        plugin_api._ATTACH_ROOT = self.attach_root
        plugin_api.configure_audio_adapters()

    async def asyncTearDown(self):
        plugin_api.configure_audio_adapters()
        plugin_api._ATTACH_ROOT = self.old_attach_root
        self.temp_dir.cleanup()

    async def test_image_and_document_are_profile_scoped_and_cleanable(self):
        image = await plugin_api.upload_attachment("researcher", Upload("capture.png", "image/png", b"png-fixture"))
        document = await plugin_api.upload_attachment("researcher", Upload("notes.md", "text/markdown", b"# local fixture"))
        self.assertEqual(image["kind"], "image")
        self.assertEqual(document["kind"], "document")
        self.assertIn("researcher", image["storage_key"])
        self.assertFalse((self.attach_root / "writer" / image["id"]).exists())
        metadata = await plugin_api.get_attachment_descriptor("researcher", image["id"])
        self.assertEqual(metadata["name"], "capture.png")
        self.assertNotIn("/home/", str(metadata))
        removed = await plugin_api.delete_attachment("researcher", image["id"])
        self.assertIn(image["id"], removed["removed"])
        self.assertFalse((self.attach_root / "researcher" / image["id"]).exists())
        self.assertTrue((self.attach_root / "researcher" / document["id"]).exists())

    async def test_mime_extension_and_traversal_are_rejected(self):
        with self.assertRaises(plugin_api.HTTPException) as traversal:
            await plugin_api.upload_attachment("researcher", Upload("../secret.md", "text/markdown", b"x"))
        self.assertEqual(traversal.exception.status_code, 400)
        with self.assertRaises(plugin_api.HTTPException) as windows_traversal:
            await plugin_api.upload_attachment("researcher", Upload(r"..\secret.md", "text/markdown", b"x"))
        self.assertEqual(windows_traversal.exception.status_code, 400)
        with self.assertRaises(plugin_api.HTTPException) as mismatch:
            await plugin_api.upload_attachment("researcher", Upload("photo.png", "text/plain", b"x"))
        self.assertEqual(mismatch.exception.status_code, 415)

    async def test_symlinked_profile_storage_is_rejected(self):
        outside = Path(self.temp_dir.name) / "outside"
        outside.mkdir()
        profile_dir = self.attach_root / "researcher"
        self.attach_root.mkdir(parents=True, exist_ok=True)
        profile_dir.symlink_to(outside, target_is_directory=True)
        with self.assertRaises(plugin_api.HTTPException) as error:
            await plugin_api.upload_attachment("researcher", Upload("notes.md", "text/markdown", b"x"))
        self.assertEqual(error.exception.status_code, 500)
        self.assertEqual(list(outside.iterdir()), [])

    async def test_transcription_adapter_is_mockable_and_temp_audio_is_deleted(self):
        adapter = MockTranscriber()
        plugin_api.configure_audio_adapters(transcriber=adapter)
        result = await plugin_api.transcribe_audio("researcher", Upload("voice.webm", "audio/webm", b"audio-fixture"))
        self.assertEqual(result["status"], "ready")
        self.assertEqual(result["transcript"], "texto de fixture")
        self.assertEqual(adapter.calls[0][1:], ("researcher", "audio/webm", b"audio-fixture"))
        self.assertFalse(adapter.calls[0][0].exists())

    async def test_missing_audio_provider_is_explicit(self):
        with self.assertRaises(plugin_api.HTTPException) as error:
            await plugin_api.transcribe_audio("researcher", Upload("voice.webm", "audio/webm", b"audio"))
        self.assertEqual(error.exception.status_code, 503)
        self.assertIn("adapter contract pending", error.exception.detail)

    async def test_synthesis_returns_descriptor_without_inline_audio(self):
        plugin_api.configure_audio_adapters(synthesizer=MockSynthesizer(self.voice_source))
        result = await plugin_api.synthesize_audio("researcher", {"text": "respuesta"})
        self.assertEqual(result["profile"], "researcher")
        self.assertEqual(result["mime_type"], "audio/webm")
        self.assertIn("researcher", result["storage_key"])
        self.assertNotIn("base64", str(result))
        self.assertNotIn("audio_bytes", str(result))


if __name__ == "__main__":
    unittest.main()
