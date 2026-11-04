from __future__ import annotations

import asyncio
import inspect
import json
import os
import re
import sys
import tempfile
import time
import uuid
from pathlib import Path
from threading import RLock
from typing import Any, Protocol

# Hermes loads dashboard APIs from their file path rather than as a Python
# package. Keep sibling imports working in both modes: package imports are used
# by tests, while the file-path loader needs the dashboard directory on the
# import path for the fallback imports below.
_PLUGIN_DASHBOARD_DIR = Path(__file__).resolve().parent
if str(_PLUGIN_DASHBOARD_DIR) not in sys.path:
    sys.path.insert(0, str(_PLUGIN_DASHBOARD_DIR))

try:
    from fastapi import APIRouter, File, HTTPException, UploadFile
    from fastapi.responses import FileResponse
except ModuleNotFoundError:  # pragma: no cover - keeps pure unit tests usable without FastAPI
    class HTTPException(Exception):
        def __init__(self, status_code: int, detail: str):
            self.status_code = status_code
            self.detail = detail
            super().__init__(detail)

    class _Router:
        def __getattr__(self, _name):
            return lambda *args, **kwargs: (lambda fn: fn)

    class UploadFile:  # type: ignore[no-redef]
        filename: str | None = None
        content_type: str | None = None

    def File(default=None, **_kwargs):  # type: ignore[misc]
        return default

    def FileResponse(path, media_type=None, filename=None):  # type: ignore[misc]
        return {"path": str(path), "media_type": media_type, "filename": filename}

    APIRouter = _Router  # type: ignore[misc,assignment]

try:
    from .turbo_policy import TurboStore, _normalize_grant
except ImportError:  # pragma: no cover - direct plugin loading fallback
    from turbo_policy import TurboStore, _normalize_grant

try:
    from .storage import _mkdir_private, _reject_symlink, migrate_legacy, profile_storage_root, write_json_atomic
except ImportError:  # pragma: no cover - direct plugin loading fallback
    from storage import _mkdir_private, _reject_symlink, migrate_legacy, profile_storage_root, write_json_atomic

router = APIRouter()
_LOCK = RLock()
_LEGACY_ROOT = Path(__file__).resolve().parent.parent
_STORE = _LEGACY_ROOT / "groups.json"  # legacy location kept for migration/tests
_TURBO_STORE = _LEGACY_ROOT / "turbo.json"  # legacy location kept for migration/tests
_ATTACH_ROOT = _LEGACY_ROOT / "attachments"  # legacy location kept for migration/tests
_VOICE_ROOT = _LEGACY_ROOT / "voice"  # legacy location kept for migration/tests
_MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024
_ATTACHMENT_TTL_SECONDS = 24 * 60 * 60
_NAME_RE = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9 _.-]{0,79}$")
_DISPLAY_NAME_RE = re.compile(r"^[^\x00-\x1f\x7f]+$")
_PROFILE_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")
_SKILL_RE = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$")
_ROUTE_ACTIONS = {"steer_active", "queue_next", "new_turn"}
_TURBO_MODES = {"planning", "simulation", "autonomous"}
_ATTACHMENT_TYPES = {"application/pdf", "application/msword", "application/vnd.ms-excel", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "application/rtf", "text/plain", "text/markdown", "text/csv", "image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp", "audio/mpeg", "audio/mp4", "audio/ogg", "audio/wav", "audio/webm", "video/mp4", "video/webm", "video/quicktime", "application/octet-stream"}
_AUDIO_TYPES = {"audio/mpeg", "audio/mp4", "audio/ogg", "audio/wav", "audio/webm"}
_EXTENSION_TYPES = {"pdf": "application/pdf", "doc": "application/msword", "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "xls": "application/vnd.ms-excel", "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "rtf": "application/rtf", "txt": "text/plain", "md": "text/markdown", "markdown": "text/markdown", "csv": "text/csv", "png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "gif": "image/gif", "webp": "image/webp", "bmp": "image/bmp", "mp3": "audio/mpeg", "m4a": "audio/mp4", "ogg": "audio/ogg", "wav": "audio/wav", "webm": "video/webm", "mp4": "video/mp4", "mov": "video/quicktime"}
_MAX_ROUTE_TEXT = 4000


class TranscriptionAdapter(Protocol):
    """Gateway-independent transcription contract.

    Implementations receive a temporary profile-scoped path and must not persist
    credentials or return audio bytes in the chat payload.
    """

    async def transcribe(self, audio_path: Path, *, profile: str, mime_type: str) -> str: ...


class SynthesisAdapter(Protocol):
    """Optional voice-response contract; the plugin remains usable without it."""

    async def synthesize(self, text: str, *, profile: str, voice: str | None = None) -> dict[str, Any] | Path: ...


_TRANSCRIPTION_ADAPTER: TranscriptionAdapter | None = None
_SYNTHESIS_ADAPTER: SynthesisAdapter | None = None


def configure_audio_adapters(*, transcriber: TranscriptionAdapter | None = None, synthesizer: SynthesisAdapter | None = None) -> None:
    """Inject mock/provider adapters without changing Hermes core or this router's contract."""
    global _TRANSCRIPTION_ADAPTER, _SYNTHESIS_ADAPTER
    _TRANSCRIPTION_ADAPTER = transcriber
    _SYNTHESIS_ADAPTER = synthesizer


def _route_text(value: Any, limit: int = 1200) -> str:
    """Bound and redact routing context before it reaches an auxiliary model."""
    text = str(value or "").strip()[:limit]
    try:
        from agent.redact import redact_sensitive_text
        return redact_sensitive_text(text, force=True)
    except Exception:
        return "[REDACTED]"


def _fallback_route(text: str, *, busy: bool) -> dict[str, Any]:
    if not busy:
        return {"action": "new_turn", "source": "local-policy", "confidence": 1.0}
    value = text.lower()
    active = re.search(
        r"\b(correg|cambia|cambiá|ajusta|ajustá|prioriza|priorizá|detené|pará|cancelá|"
        r"no hagas|te confund|en realidad|mejor hac|urgente|importante|esto no)\b", value)
    if active:
        return {"action": "steer_active", "source": "local-policy", "confidence": 0.72}
    return {"action": "queue_next", "source": "local-policy", "confidence": 0.86}


def _parse_route_answer(content: str, fallback: dict[str, Any]) -> dict[str, Any]:
    try:
        match = re.search(r"\{[^{}]{1,400}\}", content or "")
        value = json.loads(match.group(0)) if match else {}
        action = str(value.get("action") or "").strip()
        if action not in _ROUTE_ACTIONS or action == "new_turn":
            return fallback
        confidence = float(value.get("confidence") or 0.5)
        return {"action": action, "source": "subagent", "confidence": max(0.0, min(1.0, confidence))}
    except (TypeError, ValueError, json.JSONDecodeError):
        return fallback


def _call_route_subagent(text: str, status: str, active_task: str) -> dict[str, Any]:
    fallback = _fallback_route(text, busy=True)
    try:
        from agent.auxiliary_client import call_llm
        response = call_llm(
            task="message_routing",
            temperature=0,
            max_tokens=48,
            timeout=2.5,
            messages=[
                {"role": "system", "content": (
                    "Sos un subagente interno de enrutamiento de mensajes de Hermes. "
                    "No ejecutes herramientas ni acciones. Analizá la tarea activa y el mensaje nuevo. "
                    "Usá steer_active SOLO si el mensaje corrige explícitamente, detiene, cambia la prioridad "
                    "o indica urgencia sobre el trabajo actual. Usá queue_next para una tarea nueva, un agregado, "
                    "una pregunta casual o algo que puede esperar. Ante duda, elegí queue_next. "
                    "Respondé únicamente JSON: {\"action\":\"steer_active\"|\"queue_next\",\"confidence\":0..1}."
                )},
                {"role": "user", "content": (
                    f"<active_status>{_route_text(status, 400)}</active_status>\n"
                    f"<active_task>{_route_text(active_task, 1200)}</active_task>\n"
                    f"<new_message>{_route_text(text, _MAX_ROUTE_TEXT)}</new_message>"
                )},
            ],
        )
        content = response.choices[0].message.content if getattr(response, "choices", None) else ""
        return _parse_route_answer(str(content or ""), fallback)
    except Exception:
        return fallback


async def _route_message(body: dict[str, Any]) -> dict[str, Any]:
    profile = str(body.get("profile") or "").strip().lower()
    if not _PROFILE_RE.fullmatch(profile):
        raise HTTPException(status_code=400, detail="Invalid profile name")
    text = str(body.get("text") or "").strip()
    if not text or len(text) > _MAX_ROUTE_TEXT:
        raise HTTPException(status_code=400, detail="Message is empty or too long")
    busy = bool(body.get("busy"))
    fallback = _fallback_route(text, busy=busy)
    if not busy:
        return fallback
    # The auxiliary call is deliberately bounded; a routing failure never blocks the real chat.
    try:
        decision = await asyncio.wait_for(asyncio.to_thread(
            _call_route_subagent, text, str(body.get("status") or ""), str(body.get("active_task") or "")
        ), timeout=3.4)
    except Exception:
        # Classification is advisory. A failed/slow auxiliary model must not
        # turn a valid chat message into a 500 or block the actual agent.
        return fallback
    return decision if isinstance(decision, dict) and decision.get("action") in _ROUTE_ACTIONS else fallback


def _clean_name(value: Any) -> str:
    name = str(value or "").strip()
    if not name or not _NAME_RE.fullmatch(name):
        raise HTTPException(status_code=400, detail="Invalid group name")
    return name


def _slug(value: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")
    return slug[:64] or "group"


def _clean_profiles(value: Any) -> list[str]:
    if value is None:
        return []
    if not isinstance(value, list):
        raise HTTPException(status_code=400, detail="members must be a list")
    out: list[str] = []
    for item in value:
        name = str(item or "").strip().lower()
        if not _PROFILE_RE.fullmatch(name):
            raise HTTPException(status_code=400, detail=f"Invalid profile name: {name}")
        if name not in out:
            out.append(name)
    return out


def _clean_skills(value: Any) -> list[str]:
    if value is None:
        return []
    if not isinstance(value, list):
        raise HTTPException(status_code=400, detail="skills must be a list")
    out: list[str] = []
    for item in value:
        name = str(item or "").strip()
        if not _SKILL_RE.fullmatch(name):
            raise HTTPException(status_code=400, detail=f"Invalid skill name: {name}")
        if name not in out:
            out.append(name)
    return out


def _clean_turbo_profile(value: Any) -> str:
    # Profile ids are opaque isolation boundaries: reject rather than normalize them.
    profile = str(value or "")
    if not _PROFILE_RE.fullmatch(profile):
        raise HTTPException(status_code=400, detail="Invalid profile name")
    return profile


def _clean_turbo_grants(value: Any, profile: str) -> list[dict[str, Any]]:
    if value is None:
        return []
    if not isinstance(value, list):
        raise HTTPException(status_code=400, detail="grants must be a list")
    grants: list[dict[str, Any]] = []
    for raw in value:
        if not isinstance(raw, dict):
            raise HTTPException(status_code=400, detail="Invalid grant")
        if any(re.search(r"password|token|secret|cookie|connection|string", str(key), re.I) for key in raw):
            raise HTTPException(status_code=400, detail="Secrets cannot be stored in a grant")
        service = str(raw.get("service") or "").strip()[:80]
        account = str(raw.get("account") or "").strip()[:160]
        capabilities = raw.get("capabilities", [])
        if not service or not account or not isinstance(capabilities, list) or not capabilities:
            raise HTTPException(status_code=400, detail="Grant requires service, account and capabilities")
        clean_capabilities = []
        for capability in capabilities[:32]:
            item = str(capability or "").strip()[:80]
            if not item or re.search(r"password|token|secret|cookie|connection|string", item, re.I):
                raise HTTPException(status_code=400, detail="Secrets cannot be stored in a grant")
            if item not in clean_capabilities:
                clean_capabilities.append(item)
        grants.append({"profile": profile, "service": service, "account": account, "capabilities": clean_capabilities,
                       "persistent": bool(raw.get("persistent")), "status": "active", "granted_at": raw.get("granted_at") or 0})
    return grants


def _profile_storage(profile: str) -> Path:
    root = profile_storage_root(profile)
    migrate_legacy(_LEGACY_ROOT, profile, root)
    return root


def _groups_path(profile: str) -> Path:
    configured = Path(_STORE)
    if configured != _LEGACY_ROOT / "groups.json":
        return configured
    return _profile_storage(profile) / "groups.json"


def _read(profile: str = "default") -> list[dict[str, Any]]:
    path = _groups_path(profile)
    try:
        _reject_symlink(path)
        data = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return []
    except ValueError as exc:
        raise HTTPException(status_code=500, detail="Groups storage is not safe") from exc
    except (OSError, json.JSONDecodeError) as exc:
        raise HTTPException(status_code=500, detail=f"Cannot read groups: {exc}") from exc
    if not isinstance(data, list):
        return []
    return [row for row in data if isinstance(row, dict) and row.get("id")]


def _write(groups: list[dict[str, Any]], profile: str = "default") -> None:
    path = _groups_path(profile)
    try:
        write_json_atomic(path, groups)
    except OSError as exc:
        raise HTTPException(status_code=500, detail="Cannot write groups") from exc


@router.put("/profiles/{profile}/display-name")
async def update_profile_display_name(profile: str, body: dict[str, Any]) -> dict[str, Any]:
    profile = _clean_turbo_profile(profile)
    display_name = str(body.get("display_name") or "").strip()
    if not display_name or len(display_name) > 64 or not _DISPLAY_NAME_RE.fullmatch(display_name):
        raise HTTPException(status_code=400, detail="Invalid display name")
    try:
        from hermes_cli import profiles as profiles_mod
        stored = profiles_mod.set_profile_display_name(profile, display_name)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"ok": True, "profile": profile, "display_name": stored}


@router.post("/route")
async def route_message(body: dict[str, Any]) -> dict[str, Any]:
    try:
        return await _route_message(body)
    except asyncio.TimeoutError:
        text = str(body.get("text") or "")
        return _fallback_route(text, busy=bool(body.get("busy")))


def _manifest_path(profile: str) -> Path:
    return _attachment_folder(profile) / "manifest.json"


def _attachment_folder(profile: str, *, create: bool = True) -> Path:
    """Return the profile-owned staging directory without following symlinks.

    Attachments are temporary, but their descriptors can outlive a request.  A
    symlinked profile directory would otherwise let a later upload, cleanup or
    download cross the profile boundary.  Reject the condition rather than
    silently normalising it, including when a test/deployment overrides the
    attachment root.
    """
    root = Path(_ATTACH_ROOT)
    if root == _LEGACY_ROOT / "attachments":
        root = _profile_storage(profile) / "attachments"
    try:
        _reject_symlink(root)
    except ValueError as exc:
        raise HTTPException(status_code=500, detail="Attachment storage root is not safe") from exc
    if create:
        _mkdir_private(root)
    folder = root / profile
    try:
        _reject_symlink(folder)
    except ValueError as exc:
        raise HTTPException(status_code=500, detail="Attachment profile storage is not safe") from exc
    if create:
        _mkdir_private(folder)
    try:
        if folder.resolve().parent != root.resolve():
            raise HTTPException(status_code=500, detail="Attachment profile storage is not safe")
    except OSError as exc:
        raise HTTPException(status_code=500, detail="Attachment storage is unavailable") from exc
    return folder


def _read_manifest(profile: str) -> dict[str, dict[str, Any]]:
    try:
        _reject_symlink(_manifest_path(profile))
        value = json.loads(_manifest_path(profile).read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}
    except ValueError as exc:
        raise HTTPException(status_code=500, detail="Attachment storage is not safe") from exc
    except (OSError, json.JSONDecodeError) as exc:
        raise HTTPException(status_code=500, detail=f"Cannot read attachment manifest: {exc}") from exc
    return value if isinstance(value, dict) else {}


def _write_manifest(profile: str, value: dict[str, dict[str, Any]]) -> None:
    folder = _attachment_folder(profile)
    fd, tmp_name = tempfile.mkstemp(prefix="manifest.", suffix=".tmp", dir=folder)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(value, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp_name, _manifest_path(profile))
    finally:
        try:
            os.unlink(tmp_name)
        except FileNotFoundError:
            pass


def _attachment_id(value: Any) -> str:
    identifier = str(value or "").strip().lower()
    if not re.fullmatch(r"[a-f0-9]{32}", identifier):
        raise HTTPException(status_code=400, detail="Invalid attachment id")
    return identifier


def _validate_attachment_name_and_type(original: str, mime: str) -> str:
    name = Path(original).name
    if not original or name != original or "\\" in original or not name or name in {".", ".."} or len(name) > 240 or re.search(r"[\x00-\x1f]", name):
        raise HTTPException(status_code=400, detail="Invalid attachment name")
    if mime not in _ATTACHMENT_TYPES and not (mime.startswith("image/") or mime.startswith("audio/") or mime.startswith("video/")):
        raise HTTPException(status_code=415, detail="Attachment MIME type is not allowed")
    extension = name.rsplit(".", 1)[-1].lower() if "." in name else ""
    expected = _EXTENSION_TYPES.get(extension)
    if expected and mime not in {expected, "application/octet-stream"}:
        raise HTTPException(status_code=415, detail="Attachment MIME type does not match its extension")
    return name


def _descriptor(profile: str, name: str, mime: str, size: int, attachment_id: str, source: str = "upload") -> dict[str, Any]:
    kind = "image" if mime.startswith("image/") else "audio" if mime.startswith("audio/") else "video" if mime.startswith("video/") else "document"
    return {"id": attachment_id, "name": name, "type": mime, "size": size, "kind": kind, "source": source,
            "profile": profile, "storage_key": f"hermes-bots-console://{profile}/{attachment_id}", "status": "ready"}


def _store_bytes(profile: str, name: str, mime: str, data: bytes, source: str = "upload") -> dict[str, Any]:
    if len(data) > _MAX_ATTACHMENT_BYTES:
        raise HTTPException(status_code=413, detail="Attachment is too large")
    attachment_id = uuid.uuid4().hex
    folder = _attachment_folder(profile)
    destination = folder / attachment_id
    fd, tmp_name = tempfile.mkstemp(prefix="upload.", suffix=".tmp", dir=folder)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp_name, destination)
    finally:
        try:
            os.unlink(tmp_name)
        except FileNotFoundError:
            pass
    descriptor = _descriptor(profile, name, mime, len(data), attachment_id, source)
    manifest = _read_manifest(profile)
    manifest[attachment_id] = {**descriptor, "stored_at": time.time()}
    _write_manifest(profile, manifest)
    return descriptor


def cleanup_attachments(profile: str, *, max_age_seconds: int = _ATTACHMENT_TTL_SECONDS, attachment_ids: set[str] | None = None) -> dict[str, Any]:
    """Remove only expired/profile-owned temporary files; never follows user paths."""
    profile = _clean_turbo_profile(profile)
    if max_age_seconds < 0:
        raise HTTPException(status_code=400, detail="Invalid attachment cleanup age")
    with _LOCK:
        manifest = _read_manifest(profile)
        now = time.time()
        removed: list[str] = []
        retained: dict[str, dict[str, Any]] = {}
        for identifier, metadata in manifest.items():
            if not re.fullmatch(r"[a-f0-9]{32}", identifier) or not isinstance(metadata, dict):
                continue
            try:
                stored_at = float(metadata.get("stored_at") or now)
            except (TypeError, ValueError):
                stored_at = 0
            expired = now - stored_at >= max_age_seconds
            selected = attachment_ids is not None and identifier in attachment_ids
            if expired or selected:
                try:
                    path = _attachment_folder(profile) / identifier
                    _reject_symlink(path)
                    path.unlink()
                except FileNotFoundError:
                    pass
                removed.append(identifier)
            else:
                retained[identifier] = metadata
        _write_manifest(profile, retained)
        return {"profile": profile, "removed": removed, "remaining": len(retained)}


@router.post("/attachments")
async def upload_attachment(profile: str, file: UploadFile = File(...)) -> dict[str, Any]:
    profile = _clean_turbo_profile(profile)
    original = str(file.filename or "").strip()
    mime = str(file.content_type or "application/octet-stream").lower().split(";", 1)[0]
    name = _validate_attachment_name_and_type(original, mime)
    data = await file.read(_MAX_ATTACHMENT_BYTES + 1)
    if len(data) > _MAX_ATTACHMENT_BYTES:
        raise HTTPException(status_code=413, detail="Attachment is too large")
    cleanup_attachments(profile)
    with _LOCK:
        return _store_bytes(profile, name, mime, data)


@router.get("/attachments/{attachment_id}")
async def get_attachment_descriptor(profile: str, attachment_id: str) -> dict[str, Any]:
    profile = _clean_turbo_profile(profile)
    attachment_id = _attachment_id(attachment_id)
    with _LOCK:
        descriptor = _read_manifest(profile).get(attachment_id)
    path = _attachment_folder(profile) / attachment_id
    try:
        _reject_symlink(path)
    except ValueError as exc:
        raise HTTPException(status_code=500, detail="Attachment storage is not safe") from exc
    if not isinstance(descriptor, dict) or not path.is_file():
        raise HTTPException(status_code=404, detail="Attachment not found")
    return {key: value for key, value in descriptor.items() if key != "stored_at"}


@router.get("/audio/{voice_id}")
async def download_voice(profile: str, voice_id: str):
    profile = _clean_turbo_profile(profile)
    voice_id = _attachment_id(voice_id)
    with _LOCK:
        descriptor = _read_manifest(profile).get(voice_id)
    path = _attachment_folder(profile) / voice_id
    try:
        _reject_symlink(path)
    except ValueError as exc:
        raise HTTPException(status_code=500, detail="Voice storage is not safe") from exc
    if not isinstance(descriptor, dict) or not descriptor.get("type", "").startswith("audio/") or not path.is_file():
        raise HTTPException(status_code=404, detail="Voice response not found")
    return FileResponse(path, media_type=descriptor["type"], filename=descriptor.get("name", "response.audio"))


@router.delete("/attachments/{attachment_id}")
async def delete_attachment(profile: str, attachment_id: str) -> dict[str, Any]:
    profile = _clean_turbo_profile(profile)
    identifier = _attachment_id(attachment_id)
    return cleanup_attachments(profile, max_age_seconds=10**18, attachment_ids={identifier})


@router.post("/attachments/cleanup")
async def cleanup_attachment_endpoint(profile: str, body: dict[str, Any] | None = None) -> dict[str, Any]:
    body = body if isinstance(body, dict) else {}
    max_age = body.get("max_age_seconds", _ATTACHMENT_TTL_SECONDS)
    try:
        max_age = int(max_age)
    except (TypeError, ValueError) as exc:
        raise HTTPException(status_code=400, detail="Invalid attachment cleanup age") from exc
    return cleanup_attachments(profile, max_age_seconds=max_age)


async def _maybe_await(value: Any) -> Any:
    return await value if inspect.isawaitable(value) else value


@router.post("/audio/transcribe")
async def transcribe_audio(profile: str, file: UploadFile = File(...)) -> dict[str, Any]:
    profile = _clean_turbo_profile(profile)
    mime = str(file.content_type or "").lower().split(";", 1)[0]
    if mime not in _AUDIO_TYPES:
        raise HTTPException(status_code=415, detail="Audio MIME type is not supported")
    if _TRANSCRIPTION_ADAPTER is None:
        raise HTTPException(status_code=503, detail="Voice transcription provider is not configured; adapter contract pending")
    data = await file.read(_MAX_ATTACHMENT_BYTES + 1)
    if len(data) > _MAX_ATTACHMENT_BYTES:
        raise HTTPException(status_code=413, detail="Audio is too large")
    suffix = "." + (mime.split("/", 1)[1].split(";", 1)[0] or "webm")
    folder = _attachment_folder(profile)
    fd, temp_name = tempfile.mkstemp(prefix="transcribe.", suffix=suffix, dir=folder)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        transcript = str(await _maybe_await(_TRANSCRIPTION_ADAPTER.transcribe(Path(temp_name), profile=profile, mime_type=mime)) or "").strip()[:10000]
    except HTTPException as exc:
        raise HTTPException(status_code=502, detail="Voice transcription provider failed") from exc
    except Exception as exc:
        raise HTTPException(status_code=502, detail="Voice transcription provider failed") from exc
    finally:
        try:
            os.unlink(temp_name)
        except FileNotFoundError:
            pass
    if not transcript:
        raise HTTPException(status_code=422, detail="No transcript was returned by the voice adapter")
    return {"status": "ready", "profile": profile, "transcript": transcript, "mime_type": mime}


@router.post("/audio/synthesize")
async def synthesize_audio(profile: str, body: dict[str, Any]) -> dict[str, Any]:
    profile = _clean_turbo_profile(profile)
    if _SYNTHESIS_ADAPTER is None:
        raise HTTPException(status_code=503, detail="Voice response provider is not configured; adapter contract pending")
    if not isinstance(body, dict) or not str(body.get("text") or "").strip():
        raise HTTPException(status_code=400, detail="Voice synthesis requires text")
    text = str(body["text"]).strip()[:20000]
    try:
        result = await _maybe_await(_SYNTHESIS_ADAPTER.synthesize(text, profile=profile, voice=str(body.get("voice") or "") or None))
        if not isinstance(result, (dict, Path)):
            raise ValueError("Voice adapter returned an invalid result")
        if isinstance(result, Path):
            path, mime, duration = result, "audio/webm", 0
        else:
            path = Path(str(result.get("path") or ""))
            mime = str(result.get("mime_type") or "audio/webm").lower().split(";", 1)[0]
            duration = int(result.get("duration_ms") or 0)
        if mime not in _AUDIO_TYPES or not path.is_file():
            raise ValueError("Voice adapter did not return a supported audio file")
        data = path.read_bytes()
        descriptor = _store_bytes(profile, f"response-{uuid.uuid4().hex[:8]}.audio", mime, data, "synthesis")
        return {"voice_id": descriptor["id"], "profile": profile, "mime_type": mime, "duration_ms": max(0, min(duration, 60 * 60 * 1000)), "source": "upload", "transcript": "", "storage_key": descriptor["storage_key"], "status": "ready"}
    except HTTPException as exc:
        raise HTTPException(status_code=502, detail="Voice synthesis provider failed") from exc
    except Exception as exc:
        raise HTTPException(status_code=502, detail="Voice synthesis provider failed") from exc


def _turbo_store(profile: str = "default") -> TurboStore:
    # Test/deployment overrides retain the old injection point. The default
    # runtime uses Hermes profile storage and never writes into the installed plugin.
    configured = Path(_TURBO_STORE)
    root = configured.parent if configured != _LEGACY_ROOT / "turbo.json" else _profile_storage(profile)
    return TurboStore(root)


def _turbo_http_error(error: Exception) -> HTTPException:
    return HTTPException(status_code=400, detail=str(error))


@router.get("/turbo/{profile}")
async def get_turbo_profile(profile: str) -> dict[str, Any]:
    profile = _clean_turbo_profile(profile)
    try:
        return _turbo_store(profile).get(profile)
    except ValueError as error:
        raise _turbo_http_error(error) from error


@router.put("/turbo/{profile}")
async def update_turbo_profile(profile: str, body: dict[str, Any]) -> dict[str, Any]:
    profile = _clean_turbo_profile(profile)
    if not isinstance(body, dict):
        raise HTTPException(status_code=400, detail="Invalid Turbo state")
    store = _turbo_store(profile)
    try:
        requested_mode = str(body["mode"]) if "mode" in body else None
        if requested_mode is not None and requested_mode not in _TURBO_MODES:
            raise ValueError("Modo Turbo inválido")
        has_grants = "grants" in body
        requested: list[Any] = []
        if has_grants:
            raw_grants = body.get("grants")
            if not isinstance(raw_grants, list):
                raise ValueError("grants must be a list")
            requested = raw_grants
            # Validate every requested grant before revoking or writing any state.
            now = store.clock()
            for grant in requested:
                if not isinstance(grant, dict):
                    raise ValueError("Invalid grant")
                _normalize_grant(profile, grant, now)
        if requested_mode is not None:
            store.set_mode(profile, requested_mode)
        if has_grants:
            current = store.get(profile)
            wanted = {(str(item.get("service")), str(item.get("account"))) for item in requested if isinstance(item, dict)}
            for grant in current["grants"]:
                if grant.get("status") == "active" and (grant.get("service"), grant.get("account")) not in wanted:
                    store.revoke(profile, grant["grant_id"])
            for grant in requested:
                if not isinstance(grant, dict):
                    raise ValueError("Invalid grant")
                store.grant(profile, grant)
        return store.get(profile)
    except (ValueError, TypeError) as error:
        raise _turbo_http_error(error) from error


@router.post("/turbo/{profile}/grants")
async def add_turbo_grant(profile: str, body: dict[str, Any]) -> dict[str, Any]:
    profile = _clean_turbo_profile(profile)
    if not isinstance(body, dict):
        raise HTTPException(status_code=400, detail="Invalid grant")
    store = _turbo_store(profile)
    try:
        decision = str(body.get("decision") or body.get("action") or "").strip().lower()
        if decision in {"once", "allow_once", "permit_once", "always", "enable_always", "cancel"}:
            grant_id = str(body.get("grant_id") or "")
            if not grant_id:
                raise ValueError("grant_id is required for a grant decision")
            decision = "once" if decision in {"once", "allow_once", "permit_once"} else "always" if decision in {"always", "enable_always"} else "cancel"
            return store.respond(profile, grant_id, decision)
        return store.grant(profile, body)
    except (ValueError, TypeError) as error:
        raise _turbo_http_error(error) from error


@router.delete("/turbo/{profile}/grants/{service}/{account}")
async def revoke_turbo_grant(profile: str, service: str, account: str) -> dict[str, Any]:
    profile = _clean_turbo_profile(profile)
    store = _turbo_store(profile)
    try:
        state = store.get(profile)
        selected = next((grant for grant in state["grants"] if grant.get("service") == service and grant.get("account") == account), None)
        if selected is None:
            raise HTTPException(status_code=404, detail="Grant not found")
        return store.revoke(profile, selected["grant_id"])
    except HTTPException:
        raise
    except (ValueError, TypeError) as error:
        raise _turbo_http_error(error) from error


@router.get("/turbo/{profile}/audit")
async def get_turbo_audit(profile: str) -> dict[str, Any]:
    profile = _clean_turbo_profile(profile)
    try:
        return {"profile": profile, "audit": _turbo_store(profile).get(profile).get("audit", [])}
    except ValueError as error:
        raise _turbo_http_error(error) from error


@router.post("/turbo/{profile}/authorize")
async def authorize_turbo_operation(profile: str, body: dict[str, Any]) -> dict[str, Any]:
    profile = _clean_turbo_profile(profile)
    if not isinstance(body, dict):
        raise HTTPException(status_code=400, detail="Invalid Turbo operation")
    try:
        return _turbo_store(profile).authorize(profile, body)
    except ValueError as error:
        raise _turbo_http_error(error) from error


@router.get("/diagnostics")
async def get_diagnostics(profile: str = "default") -> dict[str, Any]:
    profile = _clean_turbo_profile(profile)
    checks: list[dict[str, Any]] = [
        {"id": "plugin_backend", "label": "Backend del plugin", "required": True, "status": "ok", "detail": "La API del plugin respondió correctamente.", "action": "hermes plugins validate"},
        {"id": "hermes_runtime", "label": "Hermes Gateway", "required": False, "status": "manual", "detail": "Esta API no comprueba la conexión WebSocket ni la versión del Gateway.", "action": "hermes doctor"},
        {"id": "dashboard_auth", "label": "Dashboard autenticado", "required": False, "status": "manual", "detail": "La autenticación la controla Hermes; el plugin no valida sesiones por este endpoint.", "action": "Abrir el Dashboard autenticado"},
        {"id": "native_groups", "label": "Grupos nativos", "required": False, "status": "manual", "detail": "Comprobá groups.capabilities desde el perfil del Gateway antes de crear una sala.", "action": "Abrir Grupos y comprobar el driver nativo"},
        {"id": "profile_discovery", "label": "Perfiles Hermes", "required": False, "status": "manual", "detail": "Este endpoint no consulta la lista de perfiles del SDK.", "action": "Abrir Bots y comprobar los perfiles disponibles"},
    ]
    try:
        _profile_storage(profile)
        checks.append({"id": "profile_storage", "label": "Almacenamiento del perfil", "required": True, "status": "ok", "detail": "Los datos mutables se guardan fuera del bundle instalado.", "action": "Revisar HERMES_HOME y el perfil seleccionado"})
    except (OSError, ValueError) as exc:
        checks.append({"id": "profile_storage", "label": "Almacenamiento del perfil", "required": True, "status": "error", "detail": "No se pudo preparar el almacenamiento profile-scoped.", "action": "Revisar permisos y HERMES_HOME", "error": str(exc)[:160]})
    checks.append({"id": "desktop_viewer", "label": "Visor de escritorio aislado", "required": False, "status": "manual", "detail": "Requiere Bot Desktop y dependencias gráficas del gateway; se valida al abrir el monitor.", "action": "hermes computer-use screen status"})
    return {"profile": profile, "checks": checks, "ok": all(item["status"] == "ok" for item in checks if item["required"])}


@router.get("/groups")
async def list_groups(profile: str = "default") -> dict[str, Any]:
    profile = _clean_turbo_profile(profile)
    with _LOCK:
        return {"groups": _read(profile)}


@router.post("/groups")
async def create_group(body: dict[str, Any], profile: str = "default") -> dict[str, Any]:
    profile = _clean_turbo_profile(profile)
    name = _clean_name(body.get("name"))
    row = {
        "id": _slug(name),
        "name": name,
        "members": _clean_profiles(body.get("members", [])),
        "skills": _clean_skills(body.get("skills", [])),
    }
    with _LOCK:
        groups = _read(profile)
        if any(existing.get("id") == row["id"] for existing in groups):
            raise HTTPException(status_code=409, detail="A group with that name already exists")
        groups.append(row)
        _write(groups, profile)
    return row


@router.put("/groups/{group_id}")
async def update_group(group_id: str, body: dict[str, Any], profile: str = "default") -> dict[str, Any]:
    profile = _clean_turbo_profile(profile)
    with _LOCK:
        groups = _read(profile)
        for index, existing in enumerate(groups):
            if existing.get("id") != group_id:
                continue
            name = _clean_name(body.get("name", existing.get("name")))
            row = {
                "id": group_id,
                "name": name,
                "members": _clean_profiles(body.get("members", existing.get("members", []))),
                "skills": _clean_skills(body.get("skills", existing.get("skills", []))),
            }
            groups[index] = row
            _write(groups, profile)
            return row
    raise HTTPException(status_code=404, detail="Group not found")


@router.delete("/groups/{group_id}")
async def delete_group(group_id: str, profile: str = "default") -> dict[str, bool]:
    profile = _clean_turbo_profile(profile)
    with _LOCK:
        groups = _read(profile)
        next_groups = [row for row in groups if row.get("id") != group_id]
        if len(next_groups) == len(groups):
            raise HTTPException(status_code=404, detail="Group not found")
        _write(next_groups, profile)
    return {"ok": True}
