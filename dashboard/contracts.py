"""Pure-Python mirror of contracts/bot-console-contracts.json.

This module deliberately has no FastAPI, Gateway or filesystem dependency. Backend
routers can validate payloads with it, while tests and dry-run tooling use the same
profile-scoped shapes as dashboard/contracts.mjs.
"""
from __future__ import annotations

from copy import deepcopy
import re
import time
from typing import Any

CONTRACT_VERSION = "1"
PROFILE_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")
SECRET_KEY_RE = re.compile(
    r"(?:password|passwd|passphrase|token|secret|cookie|credential|authorization|api[_-]?key|private[_-]?key|connection[_-]?string|client[_-]?secret|verification[_-]?code|mfa|otp|cvc|data[_-]?url|base64|audio[_-]?bytes|file[_-]?bytes)",
    re.I,
)
SECRET_VALUE_RE = re.compile(r"(?:data:[^,;\s]+;base64,|(?:password|passwd|passphrase|token|secret|cookie|api[_-]?key|connection[_-]?string|verification[_-]?code|mfa|otp|cvc)\s*[:=])", re.I)
STORAGE_KEY_RE = re.compile(r"^hermes-bots-console://([a-z0-9][a-z0-9_-]{0,63})/([A-Za-z0-9][A-Za-z0-9_.-]{0,159})$")
PATH_TRAVERSAL_RE = re.compile(r"(?:^|[/\\])\.{1,2}(?:$|[/\\])")
SAFE_VOICE_MIME = {"audio/mpeg", "audio/mp4", "audio/ogg", "audio/wav", "audio/webm"}
AUDIT_TYPES = {
    "profile.state.loaded", "profile.state.saved", "screen.binding.created",
    "screen.lease.acquired", "screen.lease.released", "authorization.granted",
    "authorization.revoked", "authorization.pending", "authorization.cancelled",
    "turbo.mode.changed", "turbo.operation.blocked", "message.received", "message.sent",
    "response.normalized", "voice.transcribed",
}
AUDIT_METADATA_RE = re.compile(r"(?:text|content|markdown|transcript|audio|payload|data|body|html)", re.I)
TURBO_MODES = ("planning", "simulation", "autonomous")
TURBO_EXCEPTIONS = frozenset({"ambiguous_account", "identity_required", "mfa_or_captcha", "payment", "irreversible_delete", "security_change", "legal_action", "high_risk"})


def mode_allows(mode: str, capability: str) -> bool:
    matrix = {"planning": {"read", "plan", "explain"}, "simulation": {"read", "plan", "explain", "prepare"}, "autonomous": {"read", "plan", "explain", "prepare", "confirm", "write"}}
    return capability in matrix.get(mode, set())


def requires_confirmation(mode: str, *, capability: str = "", exception: str | None = None) -> bool:
    if mode not in TURBO_MODES:
        raise ValueError("Modo Turbo inválido")
    if exception and exception in TURBO_EXCEPTIONS:
        return True
    return capability in {"confirm", "write"} and not mode_allows(mode, capability)


def now_ms() -> int:
    return int(time.time() * 1000)


def assert_profile(profile: Any) -> str:
    value = str(profile or "")
    if not PROFILE_RE.fullmatch(value):
        raise ValueError("Perfil inválido")
    return value


def _assert_no_secrets(value: Any, path: str = "") -> None:
    if isinstance(value, list):
        for index, item in enumerate(value):
            if isinstance(item, str) and SECRET_VALUE_RE.search(item):
                raise ValueError(f"Valor secreto no permitido: {path}[{index}]")
            _assert_no_secrets(item, f"{path}[{index}]")
        return
    if isinstance(value, str):
        if SECRET_VALUE_RE.search(value):
            raise ValueError(f"Valor secreto no permitido: {path}")
        return
    if not isinstance(value, dict):
        return
    for key, child in value.items():
        if SECRET_KEY_RE.search(str(key)):
            raise ValueError(f"Campo secreto no permitido: {path}{key}")
        if isinstance(child, str) and SECRET_VALUE_RE.search(child):
            raise ValueError(f"Valor secreto no permitido: {path}{key}")
        _assert_no_secrets(child, f"{path}{key}.")


def _assert_no_inline(value: Any) -> None:
    if isinstance(value, list):
        for item in value:
            _assert_no_inline(item)
    elif isinstance(value, str):
        if SECRET_VALUE_RE.search(value):
            raise ValueError("Contenido secreto no permitido")
    elif isinstance(value, dict):
        for key, child in value.items():
            if re.fullmatch(r"(?:data[_-]?url|base64|audio[_-]?bytes|file[_-]?bytes|blob|file)", str(key), re.I):
                raise ValueError(f"Contenido inline no permitido: {key}")
            if isinstance(child, str) and SECRET_VALUE_RE.search(child):
                raise ValueError(f"Contenido secreto no permitido: {key}")
            _assert_no_inline(child)


def _storage_key(value: Any, profile: str, *, field: str = "storage_key") -> str:
    key = str(value or "")
    match = STORAGE_KEY_RE.fullmatch(key)
    if not match or match.group(1) != profile:
        raise ValueError(f"{field} sin contrato profile-scoped")
    return key


def profile_state_key(profile: Any) -> str:
    return f"hermes-bots-console.profile-state.{assert_profile(profile)}"


def create_profile_state(profile: Any, patch: dict[str, Any] | None = None, *, now: int | None = None) -> dict[str, Any]:
    profile = assert_profile(profile)
    patch = deepcopy(patch or {})
    if not isinstance(patch, dict):
        raise ValueError("Estado de perfil inválido")
    _assert_no_secrets(patch)
    allowed = {"session": {"stored_id", "runtime_id"}, "turbo": {"mode", "grants"}, "ui": {"route", "draft"}}
    top_level = {"contract_version", "profile", "updated_at", "session", "turbo", "audit", "ui"}
    unknown = set(patch) - top_level
    if unknown:
        raise ValueError(f"Campo de estado no permitido: {sorted(unknown)[0]}")
    for section, keys in allowed.items():
        value = patch.get(section)
        if value is None:
            continue
        if not isinstance(value, dict):
            raise ValueError(f"Sección de estado inválida: {section}")
        unknown = set(value) - keys
        if unknown:
            raise ValueError(f"Campo de estado no permitido: {section}.{sorted(unknown)[0]}")
    if patch.get("profile") and assert_profile(patch["profile"]) != profile:
        raise ValueError("El estado pertenece a otro perfil")
    timestamp = now_ms() if now is None else int(now)
    state = {
        "contract_version": CONTRACT_VERSION,
        "profile": profile,
        "updated_at": timestamp,
        "session": {"stored_id": "", "runtime_id": ""},
        "turbo": {"mode": "planning", "grants": []},
        "audit": [],
        "ui": {"route": "roster", "draft": ""},
    }
    for key, value in patch.items():
        if key not in {"session", "turbo", "ui"}:
            state[key] = value
    for key in ("session", "turbo", "ui"):
        if isinstance(patch.get(key), dict):
            state[key].update(patch[key])
    state["contract_version"] = CONTRACT_VERSION
    state["profile"] = profile
    state["updated_at"] = int(patch.get("updated_at", timestamp))
    if state["turbo"].get("mode") not in {"planning", "simulation", "autonomous"}:
        raise ValueError("Modo Turbo inválido")
    grants = []
    for raw in state["turbo"].get("grants", []):
        if not isinstance(raw, dict):
            raise ValueError("Grant inválido")
        service = str(raw.get("service") or "").strip()[:80]
        account = str(raw.get("account") or "").strip()[:160]
        capabilities = list(dict.fromkeys(str(item).strip() for item in (raw.get("capabilities") or []) if str(item).strip()))[:32]
        status = str(raw.get("status") or "active")
        if not service or not account or (not capabilities and status != "revoked") or status not in {"active", "revoked", "pending"}:
            raise ValueError("Grant inválido")
        persistent = bool(raw.get("persistent"))
        grants.append({"grant_id": str(raw.get("grant_id") or f"{profile}-{service}-{account}")[:160], "contract_version": CONTRACT_VERSION, "profile": profile, "service": service, "account": account, "capabilities": capabilities, "persistent": persistent, "scope": "profile" if persistent else "once", "owner": {"type": "profile", "profile": profile}, "status": status, "granted_at": int(raw.get("granted_at", timestamp)), "expires_at": raw.get("expires_at"), **({"revoked_at": raw["revoked_at"]} if raw.get("revoked_at") is not None else {})})
    state["turbo"]["grants"] = grants
    state["audit"] = [create_audit_event(**{**event, "profile": profile}) for event in state.get("audit", [])][-200:]
    if state["ui"].get("route") not in {"roster", "chat", "groups", "group"}:
        raise ValueError("Ruta de UI inválida")
    _assert_no_secrets(state)
    return state


def create_isolation_binding(profile: Any, values: dict[str, Any] | None = None) -> dict[str, Any]:
    profile = assert_profile(profile)
    values = deepcopy(values or {})
    display = values.get("display") or {}
    lease = values.get("lease") or {}
    binding = {
        "contract_version": CONTRACT_VERSION,
        "profile": profile,
        "browser_profile": values.get("browser_profile", f"/profiles/{profile}/bot-desktop/browser-profile"),
        "desktop_name": values.get("desktop_name", f"hermes:{profile}"),
        "display": {"number": int(display.get("number", 0)), "socket": display.get("socket", f"/run/hermes/{profile}/display.sock")},
        "gateway_socket": values.get("gateway_socket", f"/run/hermes/{profile}/gateway.sock"),
        "lease": {
            "profile": lease.get("profile", profile),
            "holder": lease.get("holder", "agent"),
            "viewer_id": lease.get("viewer_id", f"dry-run-{profile}"),
            "status": lease.get("status", "held"),
            "expires_at": lease.get("expires_at"),
        },
    }
    return validate_isolation_binding(binding, profile)


def _scoped(value: Any, field: str, profile: str) -> str:
    text = str(value or "").strip()
    marker = re.compile(rf"(?:^|[/\\:]){re.escape(profile)}(?:$|[/\\:])", re.I)
    if not text or PATH_TRAVERSAL_RE.search(text) or not marker.search(text):
        raise ValueError(f"Recurso sin aislamiento por perfil: {field}")
    return text


def validate_isolation_binding(binding: dict[str, Any], expected_profile: Any | None = None) -> dict[str, Any]:
    if not isinstance(binding, dict):
        raise ValueError("Binding de aislamiento inválido")
    profile = assert_profile(expected_profile or binding.get("profile"))
    if assert_profile(binding.get("profile")) != profile:
        raise ValueError("Binding de otro perfil")
    if binding.get("desktop_name") != f"hermes:{profile}":
        raise ValueError("desktop_name no coincide con el perfil")
    _scoped(binding.get("browser_profile"), "browser_profile", profile)
    _scoped(binding.get("gateway_socket"), "gateway_socket", profile)
    display = binding.get("display") or {}
    if not isinstance(display.get("number"), int) or display["number"] < 0:
        raise ValueError("display inválido")
    _scoped(display.get("socket"), "display.socket", profile)
    lease = binding.get("lease") or {}
    if assert_profile(lease.get("profile")) != profile:
        raise ValueError("lease sin aislamiento por perfil")
    if lease.get("holder") not in {"agent", "human", "none"} or lease.get("status") not in {"held", "released"}:
        raise ValueError("lease inválido")
    if not str(lease.get("viewer_id") or "").strip():
        raise ValueError("viewer_id inválido")
    return {**deepcopy(binding), "contract_version": CONTRACT_VERSION, "profile": profile}


def create_authorization_ledger(profile: Any, *, now: int | None = None) -> dict[str, Any]:
    return {"contract_version": CONTRACT_VERSION, "profile": assert_profile(profile), "grants": [], "updated_at": now_ms() if now is None else int(now)}


def grant_authorization(ledger: dict[str, Any], grant: dict[str, Any], *, now: int | None = None) -> dict[str, Any]:
    if not isinstance(ledger, dict) or not isinstance(ledger.get("grants"), list):
        raise ValueError("Ledger inválido")
    _assert_no_secrets(grant)
    profile = assert_profile(ledger.get("profile"))
    service = str(grant.get("service") or "").strip()[:80]
    account = str(grant.get("account") or "").strip()[:160]
    capabilities = list(dict.fromkeys(str(item).strip() for item in (grant.get("capabilities") or []) if str(item).strip()))[:32]
    if not service or not account or not capabilities or any(SECRET_VALUE_RE.search(item) for item in [service, account, *capabilities]):
        raise ValueError("Grant incompleto o secreto")
    grant_id = str(grant.get("grant_id") or f"{profile}-{service}-{account}")[:160]
    persistent = bool(grant.get("persistent"))
    status = str(grant.get("status") or "active")
    if status not in {"active", "revoked", "pending"}:
        raise ValueError("Estado de grant inválido")
    timestamp = now_ms() if now is None else int(now)
    item = {
        "grant_id": grant_id, "contract_version": CONTRACT_VERSION, "profile": profile,
        "service": service, "account": account, "capabilities": capabilities,
        "persistent": persistent, "scope": "profile" if persistent else "once",
        "owner": {"type": "profile", "profile": profile}, "status": status,
        "granted_at": int(grant.get("granted_at", timestamp)), "expires_at": grant.get("expires_at"),
        **({"revoked_at": grant["revoked_at"]} if grant.get("revoked_at") is not None else {}),
    }
    rows = [row for row in ledger["grants"] if row.get("grant_id") != grant_id and not (row.get("service") == service and row.get("account") == account)]
    return {**deepcopy(ledger), "contract_version": CONTRACT_VERSION, "grants": [*rows, item], "updated_at": timestamp}


def revoke_authorization(ledger: dict[str, Any], grant_id: Any, *, now: int | None = None) -> dict[str, Any]:
    if not isinstance(ledger, dict) or not isinstance(ledger.get("grants"), list):
        raise ValueError("Ledger inválido")
    timestamp = now_ms() if now is None else int(now)
    rows = [{**row, "status": "revoked", "capabilities": [], "revoked_at": timestamp} if row.get("grant_id") == str(grant_id) else row for row in ledger["grants"]]
    return {**deepcopy(ledger), "grants": rows, "updated_at": timestamp}


def is_authorization_active(ledger: dict[str, Any], grant_id: Any, capability: str, *, now: int | None = None) -> bool:
    timestamp = now_ms() if now is None else int(now)
    profile = (ledger or {}).get("profile")
    return any(row.get("grant_id") == str(grant_id) and row.get("profile") == profile and row.get("owner", {}).get("profile") == profile and row.get("status") == "active" and capability in row.get("capabilities", []) and (row.get("expires_at") is None or int(row["expires_at"]) > timestamp) for row in (ledger or {}).get("grants", []))


def create_audit_event(*, event_id: Any, profile: Any, type: str, actor: str = "system", outcome: str = "ok", metadata: dict[str, Any] | None = None, account: Any = None, tool: Any = None, evidence: Any = None, expected_result: Any = None, result: Any = None, at: int | None = None) -> dict[str, Any]:
    profile = assert_profile(profile)
    if type not in AUDIT_TYPES:
        raise ValueError(f"Evento de auditoría no permitido: {type}")
    operational = deepcopy(metadata or {})
    if not event_id or not isinstance(operational, dict):
        raise ValueError("Evento de auditoría inválido")
    for key, value in {"account": account, "tool": tool, "evidence": evidence, "expected_result": expected_result, "result": result}.items():
        if value is not None:
            operational[key] = str(value)[:240]
    _assert_no_secrets(operational)
    if any(AUDIT_METADATA_RE.search(str(key)) for key in operational):
        raise ValueError("Contenido no permitido en auditoría")
    return {"contract_version": CONTRACT_VERSION, "event_id": str(event_id)[:160], "at": now_ms() if at is None else int(at), "profile": profile, "type": type, "actor": str(actor or "system")[:80], "outcome": str(outcome or "ok")[:80], "metadata": operational}


def normalize_attachment_descriptor(value: dict[str, Any], profile: Any) -> dict[str, Any]:
    profile = assert_profile(profile)
    if value.get("profile") is not None and assert_profile(value["profile"]) != profile:
        raise ValueError("Adjunto de otro perfil")
    _assert_no_inline(value)
    name = str(value.get("name") or "").strip()
    if not name or len(name) > 240 or "/" in name or "\\" in name or any(ord(char) < 32 for char in name):
        raise ValueError("Nombre de adjunto inválido")
    mime = str(value.get("type") or "application/octet-stream").lower().split(";", 1)[0]
    size = float(value.get("size", 0))
    if not size.is_integer() or size < 0 or size > 25 * 1024 * 1024:
        raise ValueError("Adjunto demasiado grande")
    if not (mime.startswith(("image/", "audio/", "video/")) or mime in {"application/pdf", "application/msword", "application/vnd.ms-excel", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "application/rtf", "text/plain", "text/markdown", "text/csv", "application/octet-stream"}):
        raise ValueError("Tipo MIME de adjunto no permitido")
    storage_key = value.get("storage_key")
    if storage_key is not None:
        storage_key = _storage_key(storage_key, profile)
    kind = value.get("kind") or ("image" if mime.startswith("image/") else "audio" if mime.startswith("audio/") else "video" if mime.startswith("video/") else "document")
    result = {"id": str(value.get("id") or f"attachment-{profile}-{now_ms()}")[:160], "profile": profile, "name": name, "type": mime, "size": int(size), "kind": str(kind)[:32], "source": str(value.get("source") or "file")[:32], "status": "ready"}
    if storage_key:
        result["storage_key"] = str(storage_key)
    return result


def normalize_voice_descriptor(value: dict[str, Any]) -> dict[str, Any]:
    _assert_no_inline(value)
    profile = assert_profile(value.get("profile"))
    mime = str(value.get("mime_type") or "").lower().split(";", 1)[0]
    if mime not in SAFE_VOICE_MIME:
        raise ValueError("MIME de voz no permitido")
    duration = float(value.get("duration_ms", 0))
    if not duration.is_integer() or duration < 0 or duration > 60 * 60 * 1000:
        raise ValueError("Duración de voz inválida")
    voice_id = str(value.get("voice_id") or f"voice-{profile}-{now_ms()}")[:160]
    storage_key = _storage_key(value.get("storage_key") or f"hermes-bots-console://{profile}/{voice_id}", profile, field="Voz")
    return {"voice_id": voice_id, "profile": profile, "mime_type": mime, "duration_ms": int(duration), "source": value.get("source") if value.get("source") in {"microphone", "remote", "upload"} else "microphone", "transcript": str(value.get("transcript") or "")[:10000], "storage_key": storage_key, "status": "ready"}


def _markdown_source(value: Any) -> str:
    return re.sub(r"\b(?:javascript|vbscript)\s*:", "", re.sub(r"<[^>]*>", "", str(value or "")))[:200000]


def _markdown_blocks(source: str) -> list[dict[str, Any]]:
    blocks = []
    for line in source.splitlines():
        if not line.strip():
            continue
        heading = re.match(r"^\s*(#{1,6})\s+", line)
        if heading:
            blocks.append({"type": "heading", "level": len(heading.group(1))})
        elif re.match(r"^\s*(?:[-*+]\s+|\d+[.)]\s+)", line):
            blocks.append({"type": "list"})
        elif line.lstrip().startswith(">"):
            blocks.append({"type": "quote"})
        elif line.lstrip().startswith("```"):
            blocks.append({"type": "code"})
        else:
            blocks.append({"type": "paragraph"})
    return blocks


def normalize_markdown_document(source: Any) -> dict[str, Any]:
    clean = _markdown_source(source)
    return {"format": "gfm-safe", "source": clean, "blocks": _markdown_blocks(clean)}


def normalize_multimodal_response(value: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError("Respuesta multimodal inválida")
    _assert_no_inline(value)
    profile = assert_profile(value.get("profile"))
    text = str(value.get("text") or "")[:200000]
    voice = value.get("voice")
    if voice and voice.get("profile") is not None and assert_profile(voice["profile"]) != profile:
        raise ValueError("Voz de otro perfil")
    if voice and voice.get("profile") is None:
        voice = {**voice, "profile": profile}
    return {
        "contract_version": CONTRACT_VERSION,
        "response_id": str(value.get("response_id") or f"response-{profile}-{now_ms()}")[:160],
        "profile": profile,
        "role": "user" if value.get("role") == "user" else "assistant",
        "text": text,
        "markdown": normalize_markdown_document(text),
        "attachments": [normalize_attachment_descriptor(item, profile) for item in (value.get("attachments") or [])],
        "voice": normalize_voice_descriptor(voice) if voice else None,
        "created_at": int(value.get("created_at", now_ms())),
    }


def create_dry_run_rpc_responses(profile: Any = "researcher") -> dict[str, Any]:
    profile = assert_profile(profile)
    second_profile = "researcher" if profile == "writer" else "writer"
    room = {"room_id": f"hermes-bots-dry-run-{profile}", "name": "Dry run", "members": [{"member_id": member, "profile": member, "handle": member, "display_name": member} for member in (profile, second_profile)]}
    return {
        "display.status": {"profile": profile, "running": True, "display": 0, "desktop_name": f"hermes:{profile}"},
        "display.start": {"profile": profile, "running": True, "display": 0, "desktop_name": f"hermes:{profile}"},
        "display.observe": {"profile": profile, "viewer_id": f"viewer-{profile}", "ticket": f"dry-run-ticket-{profile}", "desktop_name": f"hermes:{profile}", "lease": {"profile": profile, "holder": "agent", "status": "held"}},
        "display.lease.acquire": {"profile": profile, "lease": {"profile": profile, "holder": "human", "status": "held", "viewer_id": f"viewer-{profile}"}},
        "display.lease.release": {"profile": profile, "lease": {"profile": profile, "holder": "agent", "status": "released", "viewer_id": f"viewer-{profile}"}},
        "groups.capabilities": {"driver": "hermes.native.groups", "methods": ["groups.list", "groups.create", "groups.log", "groups.send", "groups.state", "groups.stop"], "max_log_limit": 200},
        "groups.list": {"rooms": [room]}, "groups.create": {"room": room},
        "groups.log": {"events": [{"event_id": f"event-{profile}-1", "seq": 1, "room_id": room["room_id"], "thread_id": f"thread-{room['room_id']}", "kind": "message.member", "actor": {"profile": profile, "display_name": profile}, "payload": {"text": "Dry run"}}], "latest_seq": 1, "has_more": False},
        "groups.state": {"room": room, "driver_status": {"working": False, "pending_actions": []}},
        "groups.send": {"accepted": True}, "groups.stop": {"accepted": True},
    }


def create_dry_run_fixture(profile: Any = "researcher", *, now: int | None = None) -> dict[str, Any]:
    timestamp = now_ms() if now is None else int(now)
    profile = assert_profile(profile)
    auth = grant_authorization(create_authorization_ledger(profile, now=timestamp), {"grant_id": f"grant-{profile}-dry-run", "service": "gmail", "account": "demo@example.com", "capabilities": ["read"], "persistent": True}, now=timestamp)
    response = normalize_multimodal_response({"response_id": f"response-{profile}-dry-run", "profile": profile, "text": "# Dry run\n\n**Contrato listo**.", "created_at": timestamp, "attachments": [{"id": f"attachment-{profile}-1", "name": "resultado.md", "type": "text/markdown", "size": 64, "kind": "document", "source": "fixture", "storage_key": f"hermes-bots-console://{profile}/attachment-1"}], "voice": {"voice_id": f"voice-{profile}-1", "mime_type": "audio/webm", "duration_ms": 400, "source": "microphone", "transcript": "Contrato listo", "storage_key": f"hermes-bots-console://{profile}/voice-1"}})
    rpc_responses = create_dry_run_rpc_responses(profile)
    return {"contract_version": CONTRACT_VERSION, "profile": profile, "state": create_profile_state(profile, {"session": {"stored_id": f"stored-{profile}", "runtime_id": f"runtime-{profile}"}}, now=timestamp), "isolation": create_isolation_binding(profile, {"browser_profile": f"/profiles/{profile}/bot-desktop/browser-profile", "desktop_name": f"hermes:{profile}", "display": {"number": 0, "socket": f"/run/hermes/{profile}/display.sock"}, "gateway_socket": f"/run/hermes/{profile}/gateway.sock", "lease": {"profile": profile, "holder": "agent", "viewer_id": f"viewer-{profile}", "status": "held"}}), "authorization": auth, "audit": [create_audit_event(event_id=f"audit-{profile}-dry-run", profile=profile, type="response.normalized", metadata={"response_id": response["response_id"]}, at=timestamp)], "screen": {"profile": profile, "status": rpc_responses["display.status"], "observe": rpc_responses["display.observe"], "rfb": {"protocol": "003.008", "width": 1440, "height": 900, "desktop_name": f"hermes:{profile}"}}, "group": {"room": rpc_responses["groups.state"]["room"], "capabilities": rpc_responses["groups.capabilities"], "events": rpc_responses["groups.log"]["events"], "thread_id": f"thread-{rpc_responses['groups.state']['room']['room_id']}"}, "rpc_responses": rpc_responses, "response": response}
