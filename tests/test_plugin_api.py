import importlib.util
from pathlib import Path
import json
import sys

import pytest

pytest.importorskip("fastapi")
pytest.importorskip("httpx")
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from dashboard import plugin_api


def test_dashboard_file_loader_imports_sibling_modules():
    """Match Hermes' file-path loader, which does not provide a package parent."""
    path = Path(plugin_api.__file__).resolve()
    module_name = "hermes_dashboard_plugin_loader_regression"
    spec = importlib.util.spec_from_file_location(module_name, path)
    assert spec is not None and spec.loader is not None
    loaded = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = loaded
    try:
        spec.loader.exec_module(loaded)
        paths = {getattr(route, "path", "") for route in loaded.router.routes}
        assert "/diagnostics" in paths
    finally:
        sys.modules.pop(module_name, None)


@pytest.mark.asyncio
async def test_turbo_profile_and_persistent_grant_are_profile_scoped(tmp_path, monkeypatch):
    monkeypatch.setattr(plugin_api, "_TURBO_STORE", tmp_path / "turbo.json")
    initial = await plugin_api.get_turbo_profile("researcher")
    assert initial["profile"] == "researcher"
    assert initial["mode"] == "planning"
    updated = await plugin_api.update_turbo_profile("researcher", {
        "mode": "autonomous",
        "grants": [{"service": "gmail", "account": "demo@example.com", "capabilities": ["read"], "persistent": True}],
    })
    assert updated["mode"] == "autonomous"
    assert updated["grants"][0]["profile"] == "researcher"
    assert "password" not in str(updated).lower()
    assert "token" not in str(updated).lower()
    other = await plugin_api.get_turbo_profile("writer")
    assert other["mode"] == "planning"
    assert other["grants"] == []


@pytest.mark.asyncio
async def test_turbo_rejects_invalid_modes_and_secrets(tmp_path, monkeypatch):
    monkeypatch.setattr(plugin_api, "_TURBO_STORE", tmp_path / "turbo.json")
    with pytest.raises(plugin_api.HTTPException) as invalid:
        await plugin_api.update_turbo_profile("default", {"mode": "write-anything"})
    assert invalid.value.status_code == 400
    with pytest.raises(plugin_api.HTTPException) as secret:
        await plugin_api.update_turbo_profile("default", {"grants": [{"service": "x", "account": "a", "capabilities": ["token=abc"], "token": "abc"}]})
    assert secret.value.status_code == 400


@pytest.mark.asyncio
async def test_invalid_grant_does_not_persist_a_valid_mode_change(tmp_path, monkeypatch):
    monkeypatch.setattr(plugin_api, "_TURBO_STORE", tmp_path / "turbo.json")
    await plugin_api.update_turbo_profile("default", {"mode": "autonomous"})
    with pytest.raises(plugin_api.HTTPException) as error:
        await plugin_api.update_turbo_profile("default", {"mode": "planning", "grants": [{"service": "x", "account": "a", "capabilities": ["token=bad"]}]})
    assert error.value.status_code == 400
    assert (await plugin_api.get_turbo_profile("default"))["mode"] == "autonomous"


@pytest.mark.asyncio
async def test_upload_attachment_uses_profile_scoped_store_and_rejects_traversal(tmp_path, monkeypatch):
    from io import BytesIO
    from starlette.datastructures import Headers, UploadFile
    monkeypatch.setattr(plugin_api, "_ATTACH_ROOT", tmp_path / "attachments")
    file = UploadFile(filename="screen.png", file=BytesIO(b"safe-fixture"), headers=Headers({"content-type": "image/png"}))
    uploaded = await plugin_api.upload_attachment("researcher", file)
    assert uploaded["profile"] == "researcher"
    assert uploaded["kind"] == "image"
    assert uploaded["size"] == 12
    assert (tmp_path / "attachments" / "researcher" / uploaded["id"]).read_bytes() == b"safe-fixture"
    invalid = UploadFile(filename="../../secret.env", file=BytesIO(b"safe"), headers=Headers({"content-type": "text/plain"}))
    with pytest.raises(plugin_api.HTTPException) as error:
        await plugin_api.upload_attachment("researcher", invalid)
    assert error.value.status_code == 400


@pytest.mark.asyncio
async def test_group_symlink_is_rejected_instead_of_reading_outside_profile(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_PLUGIN_DATA_DIR", str(tmp_path / "plugin-data"))
    root = tmp_path / "plugin-data" / "researcher"
    root.mkdir(parents=True)
    outside = tmp_path / "outside.json"
    outside.write_text(json.dumps([{"id": "outside"}]))
    (root / "groups.json").symlink_to(outside)
    with pytest.raises(plugin_api.HTTPException) as error:
        await plugin_api.list_groups(profile="researcher")
    assert error.value.status_code == 500


@pytest.mark.asyncio
async def test_attachments_are_exposed_through_the_real_fastapi_router(tmp_path, monkeypatch):
    monkeypatch.setattr(plugin_api, "_ATTACH_ROOT", tmp_path / "attachments")
    app = FastAPI()
    app.include_router(plugin_api.router, prefix="/api/plugins/hermes-bots-console")

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://testserver") as client:
        created_response = await client.post(
            "/api/plugins/hermes-bots-console/attachments?profile=researcher",
            files={"file": ("capture.png", b"fixture-bytes", "image/png")},
        )
        assert created_response.status_code == 200
        descriptor = created_response.json()
        assert descriptor["profile"] == "researcher"
        assert descriptor["kind"] == "image"
        assert descriptor["size"] == len(b"fixture-bytes")
        assert descriptor["storage_key"] == f"hermes-bots-console://researcher/{descriptor['id']}"

        readback_response = await client.get(
            f"/api/plugins/hermes-bots-console/attachments/{descriptor['id']}?profile=researcher"
        )
        assert readback_response.status_code == 200
        assert readback_response.json() == descriptor

        delete_response = await client.delete(
            f"/api/plugins/hermes-bots-console/attachments/{descriptor['id']}?profile=researcher"
        )
        assert delete_response.status_code == 200
        assert descriptor["id"] in delete_response.json()["removed"]

        missing_response = await client.get(
            f"/api/plugins/hermes-bots-console/attachments/{descriptor['id']}?profile=researcher"
        )
        assert missing_response.status_code == 404

        bad_mime_response = await client.post(
            "/api/plugins/hermes-bots-console/attachments?profile=researcher",
            files={"file": ("capture.png", b"x", "text/plain")},
        )
        assert bad_mime_response.status_code == 415

        traversal_response = await client.post(
            "/api/plugins/hermes-bots-console/attachments?profile=researcher",
            files={"file": ("../secret.txt", b"x", "text/plain")},
        )
        assert traversal_response.status_code == 400

        oversize_response = await client.post(
            "/api/plugins/hermes-bots-console/attachments?profile=researcher",
            files={"file": ("large.bin", b"x" * (25 * 1024 * 1024 + 1), "application/octet-stream")},
        )
        assert oversize_response.status_code == 413


@pytest.mark.asyncio
async def test_display_name_route_preserves_case_and_spaces(monkeypatch):
    hermes_root = Path.home() / ".hermes" / "hermes-agent"
    if hermes_root.is_dir():
        sys.path.insert(0, str(hermes_root))
    import hermes_cli.profiles as profiles_mod

    monkeypatch.setattr(profiles_mod, "set_profile_display_name", lambda profile, value: value)
    result = await plugin_api.update_profile_display_name("xmanager", {"display_name": "X Manager"})
    assert result == {"ok": True, "profile": "xmanager", "display_name": "X Manager"}
    with pytest.raises(plugin_api.HTTPException) as invalid:
        await plugin_api.update_profile_display_name("xmanager", {"display_name": "line\nbreak"})
    assert invalid.value.status_code == 400


@pytest.mark.asyncio
async def test_groups_are_persisted_under_profile_storage(monkeypatch, tmp_path):
    monkeypatch.setenv("HERMES_PLUGIN_DATA_DIR", str(tmp_path / "plugin-data"))
    created = await plugin_api.create_group({"name": "Portable", "members": [], "skills": []}, profile="researcher")
    assert created["id"] == "portable"
    listed = await plugin_api.list_groups(profile="researcher")
    assert listed["groups"] == [created]
    assert (tmp_path / "plugin-data" / "researcher" / "groups.json").is_file()
    assert not (Path(plugin_api.__file__).resolve().parent.parent / "groups.json").exists()


@pytest.mark.asyncio
async def test_diagnostics_separates_required_storage_from_optional_viewer(monkeypatch, tmp_path):
    monkeypatch.setenv("HERMES_PLUGIN_DATA_DIR", str(tmp_path / "plugin-data"))
    result = await plugin_api.get_diagnostics("researcher")
    checks = {item["id"]: item for item in result["checks"]}
    assert checks["profile_storage"]["required"] is True
    assert checks["profile_storage"]["status"] == "ok"
    assert checks["hermes_runtime"]["required"] is True
    assert checks["desktop_viewer"]["required"] is False
    assert checks["desktop_viewer"]["status"] == "manual"

