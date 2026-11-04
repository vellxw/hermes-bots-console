"""Profile-scoped Turbo policy and durable grant ledger.

The store is deliberately local and provider-neutral. It persists only policy metadata,
never credentials, cookies, tokens, OTPs, connection strings, or chat payloads.
"""
from __future__ import annotations

from copy import deepcopy
import json
import os
from pathlib import Path
import re
import tempfile
from threading import RLock
import time
import uuid
from typing import Any

PROFILE_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")
MODES = ("planning", "simulation", "autonomous")
EXCEPTIONS = frozenset({"ambiguous_account", "identity_required", "mfa_or_captcha", "payment", "irreversible_delete", "security_change", "legal_action", "high_risk"})
MODE_CAPABILITIES = {"planning": frozenset({"read", "plan", "explain"}), "simulation": frozenset({"read", "plan", "explain", "prepare"}), "autonomous": frozenset({"read", "plan", "explain", "prepare", "confirm", "write"})}
SECRET_KEY_RE = re.compile(r"(?:password|passwd|passphrase|token|secret|cookie|credential|authorization|api[_-]?key|private[_-]?key|connection[_-]?string|client[_-]?secret|verification[_-]?code|mfa|otp|cvc|data[_-]?url|base64|audio[_-]?bytes|file[_-]?bytes|(?:^|[_-])code$)", re.I)
SECRET_VALUE_RE = re.compile(r"(?:data:[^,;\s]+;base64,|(?:password|passwd|passphrase|token|secret|cookie|api[_-]?key|connection[_-]?string|verification[_-]?code|mfa|otp|cvc|code)\s*[:=])", re.I)
SAFE_AUDIT_KEYS = frozenset({"account", "service", "capability", "capabilities", "tool", "evidence", "expected_result", "result", "operation_id", "grant_id", "mode", "action", "status", "reason", "response_id", "dry_run", "executed"})
AUDIT_TYPES = frozenset({"profile.state.loaded", "profile.state.saved", "authorization.granted", "authorization.revoked", "authorization.pending", "authorization.cancelled", "turbo.mode.changed", "turbo.operation.blocked"})
_LOCK = RLock()
_EPHEMERAL: dict[tuple[str, str], list[dict[str, Any]]] = {}


def _now_ms() -> int:
    return int(time.time() * 1000)


def _clone(value: Any) -> Any:
    return deepcopy(value)


def assert_profile(profile: Any) -> str:
    value = str(profile or "")
    if not PROFILE_RE.fullmatch(value):
        raise ValueError("Perfil inválido")
    return value


def _assert_safe(value: Any, path: str = "") -> None:
    if isinstance(value, str):
        if SECRET_VALUE_RE.search(value):
            raise ValueError(f"Valor secreto no permitido: {path}")
        return
    if isinstance(value, list):
        for index, item in enumerate(value):
            _assert_safe(item, f"{path}[{index}]")
        return
    if not isinstance(value, dict):
        return
    for key, child in value.items():
        if SECRET_KEY_RE.search(str(key)):
            raise ValueError(f"Campo secreto no permitido: {path}{key}")
        if isinstance(child, str) and SECRET_VALUE_RE.search(child):
            raise ValueError(f"Valor secreto no permitido: {path}{key}")
        _assert_safe(child, f"{path}{key}.")


def redact(value: Any) -> Any:
    if isinstance(value, list):
        return [redact(item) for item in value]
    if isinstance(value, dict):
        return {str(key): "[REDACTED]" if SECRET_KEY_RE.search(str(key)) or (isinstance(child, str) and SECRET_VALUE_RE.search(child)) else redact(child) for key, child in value.items()}
    if isinstance(value, str) and SECRET_VALUE_RE.search(value):
        return "[REDACTED]"
    return value


def mode_allows(mode: str, capability: str) -> bool:
    return capability in MODE_CAPABILITIES.get(mode, ())


def requires_confirmation(mode: str, operation: dict[str, Any]) -> bool:
    if mode not in MODES:
        raise ValueError("Modo Turbo inválido")
    exceptions = list(operation.get("exceptions") or [])
    if operation.get("exception"):
        exceptions.append(operation["exception"])
    if operation.get("risk"):
        exceptions.append(operation["risk"])
    return bool(exceptions) or operation.get("capability") in {"confirm", "write"} and not mode_allows(mode, str(operation.get("capability")))


def _audit(profile: str, event_type: str, *, outcome: str, now: int, operation: dict[str, Any] | None = None, grant_id: str | None = None, reason: str | None = None) -> dict[str, Any]:
    operation = operation or {}
    metadata: dict[str, Any] = {}
    for key in ("account", "service", "capability", "capabilities", "tool", "evidence", "expected_result", "result", "operation_id", "mode", "dry_run", "executed"):
        if operation.get(key) is not None:
            metadata[key] = str(operation[key])[:240] if key not in {"capabilities", "dry_run", "executed"} else operation[key]
    if grant_id:
        metadata["grant_id"] = grant_id
    if reason:
        metadata["reason"] = reason
    _assert_safe(metadata)
    if any(key not in SAFE_AUDIT_KEYS for key in metadata):
        raise ValueError("Metadata de auditoría no permitida")
    event_id = f"audit-{profile}-{now}-{uuid.uuid4().hex[:12]}"
    return {"contract_version": "1", "event_id": event_id, "at": now, "profile": profile, "type": event_type, "actor": "turbo-policy", "outcome": outcome, "metadata": metadata}


def _normalize_grant(profile: str, raw: dict[str, Any], now: int) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise ValueError("Grant inválido")
    _assert_safe(raw)
    if raw.get("profile") is not None and assert_profile(raw["profile"]) != profile:
        raise ValueError("Grant pertenece a otro perfil")
    service = str(raw.get("service") or "").strip()
    account = str(raw.get("account") or "").strip()
    raw_capabilities = raw.get("capabilities") or []
    if not isinstance(raw_capabilities, list):
        raise ValueError("Capabilities inválidas")
    capabilities = list(dict.fromkeys(str(item).strip() for item in raw_capabilities if str(item).strip()))
    if len(service) > 80 or len(account) > 160 or len(capabilities) > 32 or any(len(item) > 80 for item in capabilities):
        raise ValueError("Grant fuera de límites")
    status = str(raw.get("status") or "active")
    if not service or not account or (not capabilities and status != "revoked") or status not in {"active", "revoked", "pending"}:
        raise ValueError("Grant incompleto o con estado inválido")
    persistent = bool(raw.get("persistent"))
    grant_id = str(raw.get("grant_id") or f"grant-{profile}-{service}-{account}-{uuid.uuid4().hex[:12]}")
    if not grant_id or len(grant_id) > 160:
        raise ValueError("Grant fuera de límites")
    expires_at = raw.get("expires_at")
    if expires_at is not None:
        expires_at = int(expires_at)
    result = {"grant_id": grant_id, "contract_version": "1", "profile": profile, "service": service, "account": account, "capabilities": capabilities, "persistent": persistent, "scope": "profile" if persistent else "once", "owner": {"type": "profile", "profile": profile}, "status": status, "granted_at": int(raw.get("granted_at", now)), "expires_at": expires_at}
    if raw.get("revoked_at") is not None:
        result["revoked_at"] = int(raw["revoked_at"])
    return result


class TurboStore:
    def __init__(self, root: str | Path, *, clock: Any = _now_ms):
        self.root = Path(root)
        self.clock = clock
        self.root.mkdir(parents=True, exist_ok=True)
        if self.root.is_symlink():
            raise ValueError("Store Turbo no puede ser un symlink")

    def _path(self, profile: Any) -> tuple[str, Path]:
        profile = assert_profile(profile)
        path = self.root / f"{profile}.json"
        if path.exists() and path.is_symlink():
            raise ValueError("Store Turbo no puede apuntar a otro perfil")
        return profile, path

    def _default(self, profile: str, now: int) -> dict[str, Any]:
        return {"contract_version": "1", "profile": profile, "mode": "planning", "grants": [], "audit": [], "updated_at": now}

    def _read_durable(self, profile: str, path: Path) -> dict[str, Any]:
        if not path.exists():
            return self._default(profile, self.clock())
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise ValueError(f"Estado Turbo corrupto: {exc}") from exc
        if not isinstance(raw, dict) or raw.get("profile") != profile or raw.get("mode") not in MODES:
            raise ValueError("Estado Turbo inválido")
        now = self.clock()
        grants = [_normalize_grant(profile, grant, now) for grant in raw.get("grants", []) if grant.get("persistent") or grant.get("status") in {"pending", "revoked"}]
        audit = raw.get("audit", [])
        if not isinstance(audit, list):
            raise ValueError("Auditoría Turbo inválida")
        _assert_safe(audit)
        return {"contract_version": "1", "profile": profile, "mode": raw["mode"], "grants": grants, "audit": _clone(audit)[-200:], "updated_at": int(raw.get("updated_at", now))}

    def _merged(self, profile: str, durable: dict[str, Any]) -> dict[str, Any]:
        ephemeral = _EPHEMERAL.get((str(self.root.resolve()), profile), [])
        return {**durable, "grants": [*durable["grants"], *[_clone(item) for item in ephemeral]]}

    def _write(self, state: dict[str, Any], path: Path) -> None:
        durable = {**state, "grants": [grant for grant in state.get("grants", []) if grant.get("persistent") or grant.get("status") in {"pending", "revoked"}]}
        durable["audit"] = list(state.get("audit", []))[-200:]
        state["audit"] = durable["audit"]
        _assert_safe(durable)
        self.root.mkdir(parents=True, exist_ok=True)
        fd, temp_name = tempfile.mkstemp(prefix=f".{state['profile']}.", suffix=".tmp", dir=self.root)
        try:
            if hasattr(os, 'fchmod'):
                os.fchmod(fd, 0o600)
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                json.dump(durable, handle, ensure_ascii=False, indent=2)
                handle.write("\n")
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temp_name, path)
            os.chmod(path, 0o600)
        finally:
            try:
                os.unlink(temp_name)
            except FileNotFoundError:
                pass

    def get(self, profile: Any) -> dict[str, Any]:
        profile, path = self._path(profile)
        with _LOCK:
            return self._merged(profile, self._read_durable(profile, path))

    def set_mode(self, profile: Any, mode: str) -> dict[str, Any]:
        profile, path = self._path(profile)
        if mode not in MODES:
            raise ValueError("Modo Turbo inválido")
        with _LOCK:
            state = self._read_durable(profile, path)
            state["mode"] = mode
            now = self.clock()
            state["updated_at"] = now
            state["audit"].append(_audit(profile, "turbo.mode.changed", outcome="ok", now=now, operation={"mode": mode}))
            self._write(state, path)
            return self._merged(profile, state)

    def grant(self, profile: Any, raw: dict[str, Any]) -> dict[str, Any]:
        profile, path = self._path(profile)
        now = self.clock()
        item = _normalize_grant(profile, raw, now)
        with _LOCK:
            state = self._read_durable(profile, path)
            state["grants"] = [grant for grant in state["grants"] if not (grant["service"] == item["service"] and grant["account"] == item["account"])]
            key = (str(self.root.resolve()), profile)
            _EPHEMERAL[key] = [grant for grant in _EPHEMERAL.get(key, []) if not (grant["service"] == item["service"] and grant["account"] == item["account"])]
            state["audit"].append(_audit(profile, "authorization.pending" if item["status"] == "pending" else "authorization.granted", outcome=item["status"], now=now, operation=item, grant_id=item["grant_id"]))
            if item["persistent"] or item["status"] in {"pending", "revoked"}: state["grants"].append(item)
            else: _EPHEMERAL[key].append(item)
            state["updated_at"] = now
            self._write(state, path)
            return self._merged(profile, state)

    def respond(self, profile: Any, grant_id: str, decision: str) -> dict[str, Any]:
        profile, path = self._path(profile)
        if decision not in {"once", "always", "cancel"}:
            raise ValueError("Decisión de grant inválida")
        with _LOCK:
            state = self._read_durable(profile, path)
            key = (str(self.root.resolve()), profile)
            rows = [*state["grants"], *_EPHEMERAL.get(key, [])]
            selected = next((grant for grant in rows if grant["grant_id"] == str(grant_id)), None)
            if selected is None:
                raise ValueError("Grant pendiente no encontrado")
            if selected.get("status") == "revoked" and decision != "cancel":
                raise ValueError("Grant revocado; se requiere una nueva solicitud")
            if decision == "cancel":
                selected = {**selected, "status": "revoked", "capabilities": [], "revoked_at": self.clock()}
            else:
                selected = {**selected, "status": "active", "persistent": decision == "always", "scope": "profile" if decision == "always" else "once"}
            state["grants"] = [grant for grant in state["grants"] if grant["grant_id"] != str(grant_id)]
            _EPHEMERAL[key] = [grant for grant in _EPHEMERAL.get(key, []) if grant["grant_id"] != str(grant_id)]
            event_type = "authorization.cancelled" if decision == "cancel" else "authorization.granted"
            state["audit"].append(_audit(profile, event_type, outcome=decision, now=self.clock(), operation=selected, grant_id=str(grant_id)))
            if selected["persistent"] or selected["status"] == "revoked": state["grants"].append(selected)
            else: _EPHEMERAL[key].append(selected)
            state["updated_at"] = self.clock()
            self._write(state, path)
            return self._merged(profile, state)

    def revoke(self, profile: Any, grant_id: str) -> dict[str, Any]:
        profile, path = self._path(profile)
        with _LOCK:
            state = self._read_durable(profile, path)
            key = (str(self.root.resolve()), profile)
            rows = [*state["grants"], *_EPHEMERAL.get(key, [])]
            selected = next((grant for grant in rows if grant["grant_id"] == str(grant_id)), None)
            if selected is None:
                raise ValueError("Grant no encontrado")
            revoked = {**selected, "status": "revoked", "capabilities": [], "revoked_at": self.clock(), "persistent": True, "scope": "profile"}
            state["grants"] = [grant for grant in state["grants"] if grant["grant_id"] != str(grant_id)] + [revoked]
            _EPHEMERAL[key] = [grant for grant in _EPHEMERAL.get(key, []) if grant["grant_id"] != str(grant_id)]
            state["audit"].append(_audit(profile, "authorization.revoked", outcome="revoked", now=self.clock(), operation=revoked, grant_id=str(grant_id)))
            state["updated_at"] = self.clock()
            self._write(state, path)
            return self._merged(profile, state)

    def authorize(self, profile: Any, operation: dict[str, Any]) -> dict[str, Any]:
        profile, path = self._path(profile)
        _assert_safe(operation)
        with _LOCK:
            state = self._read_durable(profile, path)
            now = self.clock()
            capability = str(operation.get("capability") or "")
            exceptions = list(operation.get("exceptions") or [])
            if operation.get("exception"): exceptions.append(operation["exception"])
            if operation.get("risk"): exceptions.append(operation["risk"])
            reason = None
            selected = None
            allowed = False
            requires = False
            required = ("profile", "service", "account", "capability", "tool")
            scope_ok = all(str(operation.get(key) or "").strip() for key in required)
            if not scope_ok or str(operation.get("profile") or "") != profile or not mode_allows(state["mode"], capability):
                reason = "scope_mismatch" if not scope_ok or str(operation.get("profile") or "") != profile else "mode_restriction"
            elif exceptions:
                reason, requires = (next((item for item in exceptions if item in EXCEPTIONS), "protected_operation"), True)
            elif state["mode"] != "autonomous":
                allowed = True
                reason = state["mode"]
            else:
                selected = next((grant for grant in [*state["grants"], *_EPHEMERAL.get((str(self.root.resolve()), profile), [])] if grant["status"] == "active" and grant["service"] == operation.get("service") and grant["account"] == operation.get("account") and capability in grant["capabilities"] and (grant.get("expires_at") is None or int(grant["expires_at"]) > now)), None)
                if selected:
                    allowed, reason = True, "active_grant"
                    if not selected.get("persistent") and not operation.get("dry_run"):
                        _EPHEMERAL[(str(self.root.resolve()), profile)] = [grant for grant in _EPHEMERAL.get((str(self.root.resolve()), profile), []) if grant["grant_id"] != selected["grant_id"]]
                else:
                    reason, requires = "grant_required", True
            # Authorization is a decision point, never evidence that an external action ran.
            result = {"allowed": allowed, "requires_confirmation": requires, "reason": reason, "executed": False}
            audit_operation = {**operation, "result": result["reason"], "executed": result["executed"]}
            state["audit"].append(_audit(profile, "turbo.operation.blocked" if not allowed else "profile.state.saved", outcome=result["reason"], now=now, operation=audit_operation, reason=reason))
            state["updated_at"] = now
            self._write(state, path)
            result["state"] = self._merged(profile, state)
            return result
