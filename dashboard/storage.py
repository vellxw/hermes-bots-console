"""Safe, profile-scoped persistence for the Hermes Bot Command plugin.

The plugin is installed below Hermes' plugin directory, but mutable state must
live in the profile data area. This module keeps that boundary explicit and
provides a conservative one-way migration for old installations.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import shutil
import tempfile
from typing import Any

PROFILE_RE = __import__("re").compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")
PLUGIN_DATA_NAME = "hermes-bots-console"


def assert_profile(profile: Any) -> str:
    value = str(profile or "")
    if not PROFILE_RE.fullmatch(value):
        raise ValueError("Perfil inválido")
    return value


def _reject_symlink(path: Path) -> None:
    """Reject an existing symlink anywhere in a storage path."""
    current = path
    while current != current.parent:
        if current.is_symlink():
            raise ValueError(f"Storage path cannot contain a symlink: {current}")
        current = current.parent


def _mkdir_private(path: Path) -> None:
    missing: list[Path] = []
    current = path
    while not current.exists():
        missing.append(current)
        current = current.parent
    _reject_symlink(current)
    if not current.is_dir():
        raise NotADirectoryError(current)
    for directory in reversed(missing):
        _reject_symlink(directory)
        directory.mkdir(mode=0o700)
        os.chmod(directory, 0o700)
    _reject_symlink(path)
    os.chmod(path, 0o700)


def profile_storage_root(
    profile: Any,
    *,
    hermes_home: str | Path | None = None,
    data_dir: str | Path | None = None,
) -> Path:
    """Return and create the persistent directory owned by one Hermes profile.

    ``HERMES_PLUGIN_DATA_DIR`` is an explicit integration hook for test and
    packaged deployments. Without it, the public Hermes profile layout is used:
    ``$HERMES_HOME/profiles/<profile>/plugin-data/hermes-bots-console``.
    """
    profile = assert_profile(profile)
    configured_data_dir = data_dir if data_dir is not None else os.environ.get("HERMES_PLUGIN_DATA_DIR")
    if configured_data_dir:
        root = Path(configured_data_dir).expanduser() / profile
    else:
        configured_home = hermes_home if hermes_home is not None else os.environ.get("HERMES_HOME")
        home = Path(configured_home).expanduser() if configured_home else Path.home() / ".hermes"
        root = home / "profiles" / profile / "plugin-data" / PLUGIN_DATA_NAME
    _mkdir_private(root)
    return root


def write_json_atomic(path: str | Path, value: Any) -> None:
    """Write JSON with a private mode and atomic replacement."""
    destination = Path(path).expanduser()
    _mkdir_private(destination.parent)
    _reject_symlink(destination)
    descriptor, temp_name = tempfile.mkstemp(prefix=f".{destination.name}.", suffix=".tmp", dir=destination.parent)
    try:
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(value, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp_name, destination)
        os.chmod(destination, 0o600)
    finally:
        try:
            os.unlink(temp_name)
        except FileNotFoundError:
            pass


def _read_json(path: Path) -> Any:
    _reject_symlink(path)
    return json.loads(path.read_text(encoding="utf-8"))


def _copy_tree_without_symlinks(source: Path, destination: Path) -> None:
    _reject_symlink(source)
    for current, directories, files in os.walk(source, followlinks=False):
        for name in (*directories, *files):
            candidate = Path(current) / name
            if candidate.is_symlink():
                raise ValueError(f"Legacy storage contains a symlink: {candidate}")
    if destination.exists():
        _reject_symlink(destination)
        return
    destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    shutil.copytree(source, destination, symlinks=False)
    for path in destination.rglob("*"):
        if path.is_symlink():
            raise ValueError(f"Legacy storage contains a symlink: {path}")
        if path.is_file():
            os.chmod(path, 0o600)
        elif path.is_dir():
            os.chmod(path, 0o700)
    os.chmod(destination, 0o700)


def migrate_legacy(legacy_root: str | Path, profile: Any, target_root: str | Path) -> dict[str, Any]:
    """Copy old installed-directory state into profile storage, once.

    Migration never deletes the legacy data, never follows symlinks, and only
    copies groups for the historical default profile. A later invocation is a
    no-op once each destination exists.
    """
    profile = assert_profile(profile)
    legacy = Path(legacy_root).expanduser()
    target = Path(target_root).expanduser()
    _reject_symlink(legacy)
    for candidate in (legacy / "groups.json", legacy / "turbo.json", legacy / "attachments" / profile, legacy / "voice" / profile):
        if candidate.is_symlink():
            raise ValueError(f"Legacy storage contains a symlink: {candidate}")
    _mkdir_private(target)
    migrated: list[str] = []

    if profile == "default":
        source = legacy / "groups.json"
        destination = target / "groups.json"
        if source.exists() and not destination.exists():
            value = _read_json(source)
            if not isinstance(value, list):
                raise ValueError("Legacy groups state is not a list")
            write_json_atomic(destination, value)
            migrated.append("groups.json")

    source = legacy / "turbo.json"
    destination = target / f"{profile}.json"
    if source.exists() and not destination.exists():
        value = _read_json(source)
        row: Any = None
        if isinstance(value, dict) and value.get("profile") == profile:
            row = value
        elif isinstance(value, dict) and isinstance(value.get(profile), dict):
            row = value[profile]
        if row is not None:
            if not isinstance(row, dict):
                raise ValueError("Legacy Turbo state is invalid")
            write_json_atomic(destination, row)
            migrated.append(f"{profile}.json")

    legacy_attachments = legacy / "attachments" / profile
    target_attachments = target / "attachments"
    if legacy_attachments.exists() and not target_attachments.exists():
        _copy_tree_without_symlinks(legacy_attachments, target_attachments)
        migrated.append("attachments")

    legacy_voice = legacy / "voice" / profile
    target_voice = target / "voice"
    if legacy_voice.exists() and not target_voice.exists():
        _copy_tree_without_symlinks(legacy_voice, target_voice)
        migrated.append("voice")

    return {"profile": profile, "migrated": migrated, "legacy_root": str(legacy), "target_root": str(target)}
