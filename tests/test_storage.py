import json
import os
import stat
from pathlib import Path

import pytest

from dashboard.storage import (
    migrate_legacy,
    profile_storage_root,
    write_json_atomic,
)


def test_profile_storage_is_hermes_home_scoped_and_not_installed_plugin(tmp_path):
    hermes_home = tmp_path / "hermes-home"
    root = profile_storage_root("researcher", hermes_home=hermes_home)

    assert root == hermes_home / "profiles" / "researcher" / "plugin-data" / "hermes-bots-console"
    assert "/plugins/" not in root.as_posix()
    assert root.is_dir()
    if os.name != 'nt':  # Windows reports synthetic permission bits, not POSIX modes
        assert stat.S_IMODE(root.stat().st_mode) == 0o700
        assert stat.S_IMODE((hermes_home / "profiles").stat().st_mode) == 0o700
        assert stat.S_IMODE((hermes_home / "profiles" / "researcher" / "plugin-data").stat().st_mode) == 0o700


def test_atomic_json_write_is_private_and_replaces_existing_data(tmp_path):
    destination = tmp_path / "profile" / "state.json"

    write_json_atomic(destination, {"version": 1})
    assert json.loads(destination.read_text()) == {"version": 1}
    if os.name != 'nt':
        assert stat.S_IMODE(destination.stat().st_mode) == 0o600

    write_json_atomic(destination, {"version": 2, "items": ["safe"]})
    assert json.loads(destination.read_text()) == {"version": 2, "items": ["safe"]}
    assert not list(destination.parent.glob("*.tmp"))


def test_legacy_migration_is_profile_scoped_safe_and_idempotent(tmp_path):
    legacy = tmp_path / "installed-plugin"
    target = tmp_path / "persistent" / "researcher"
    (legacy / "attachments" / "researcher").mkdir(parents=True)
    (legacy / "attachments" / "researcher" / "attachment-id").write_bytes(b"fixture")
    (legacy / "groups.json").write_text(json.dumps([{"id": "research", "name": "Research", "members": []}]))
    (legacy / "turbo.json").write_text(json.dumps({"researcher": {"mode": "planning", "grants": []}}))

    first = migrate_legacy(legacy, "researcher", target)
    second = migrate_legacy(legacy, "researcher", target)

    assert first["migrated"]
    assert not second["migrated"]
    assert (target / "attachments" / "attachment-id").read_bytes() == b"fixture"
    assert not (target / "groups.json").exists()
    assert json.loads((target / "researcher.json").read_text())["mode"] == "planning"
    assert (legacy / "groups.json").exists()
    assert (legacy / "turbo.json").exists()


def test_legacy_symlink_is_rejected_without_following_it(tmp_path):
    legacy = tmp_path / "installed-plugin"
    target = tmp_path / "persistent" / "researcher"
    legacy.mkdir()
    outside = tmp_path / "outside.json"
    outside.write_text("{}")
    (legacy / "groups.json").symlink_to(outside)

    with pytest.raises(ValueError, match="symlink"):
        migrate_legacy(legacy, "researcher", target)

    assert not (target / "groups.json").exists()
    assert os.path.realpath(outside) == str(outside)
