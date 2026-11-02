#!/usr/bin/env python3
"""Reproducible, non-sensitive Bot Screen memory snapshot.

The probe only reports aggregate RSS/PSS by coarse process family, host/cgroup
memory and the selected profile's display markers. It deliberately omits PIDs,
command lines, paths, environment variables, cookies and tickets.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import time
from pathlib import Path

MIB = 1024 * 1024
KB = 1024
PROCESS_FAMILIES = (
    "hermes_desktop",
    "dashboard",
    "gateway",
    "chromium",
    "firefox",
    "xvnc",
    "desktop_session",
)


def meminfo() -> dict[str, int]:
    values: dict[str, int] = {}
    try:
        lines = Path("/proc/meminfo").read_text(encoding="utf-8").splitlines()
    except OSError:
        return values
    for line in lines:
        key, _, rest = line.partition(":")
        match = re.search(r"(\d+)", rest)
        if match:
            values[key] = int(match.group(1)) * KB
    return values


def read_number(path: Path) -> int | None:
    try:
        value = path.read_text(encoding="utf-8").strip()
    except OSError:
        return None
    if value.isdigit():
        return int(value)
    return None


def process_memory(pid_dir: Path) -> tuple[int, int]:
    rss = 0
    statm = pid_dir / "statm"
    try:
        fields = statm.read_text(encoding="utf-8").split()
        if len(fields) > 1:
            rss = int(fields[1]) * os.sysconf("SC_PAGE_SIZE")
    except (OSError, ValueError):
        pass
    pss = rss
    try:
        for line in (pid_dir / "smaps_rollup").read_text(encoding="utf-8").splitlines():
            key, _, rest = line.partition(":")
            if key == "Pss":
                pss = int(rest.strip().split()[0]) * KB
                break
    except (OSError, ValueError, IndexError):
        pass
    return rss, pss


def family(text: str) -> str | None:
    value = text.lower()
    if "xvnc" in value or "xwayland" in value:
        return "xvnc"
    if "chromium" in value or "chrome" in value:
        return "chromium"
    if "firefox" in value:
        return "firefox"
    if "dashboard" in value:
        return "dashboard"
    if "gateway" in value or "tui_gateway" in value:
        return "gateway"
    if "hermes" in value and ("desktop" in value or "electron" in value):
        return "hermes_desktop"
    if any(token in value for token in ("xfce", "xfwm", "xfdesktop", "xfsettings", "dbus-run-session")):
        return "desktop_session"
    return None


def processes() -> dict[str, dict[str, int | float]]:
    result: dict[str, dict[str, int | float]] = {name: {"count": 0, "rss_mb": 0, "pss_mb": 0} for name in PROCESS_FAMILIES}
    for pid_dir in Path("/proc").glob("[0-9]*"):
        try:
            command = (pid_dir / "cmdline").read_bytes().replace(b"\x00", b" ").decode("utf-8", "replace")
            command = command or (pid_dir / "comm").read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        name = family(command)
        if not name:
            continue
        rss, pss = process_memory(pid_dir)
        row = result[name]
        row["count"] += 1
        row["rss_mb"] += round(rss / MIB, 1)
        row["pss_mb"] += round(pss / MIB, 1)
    return result


def cgroup_memory() -> dict[str, int | float | str | None]:
    current = read_number(Path("/sys/fs/cgroup/memory.current"))
    maximum_path = Path("/sys/fs/cgroup/memory.max")
    try:
        maximum_raw = maximum_path.read_text(encoding="utf-8").strip()
    except OSError:
        maximum_raw = "unavailable"
    maximum: int | float | str | None = maximum_raw
    if maximum_raw.isdigit():
        maximum = round(int(maximum_raw) / MIB, 1)
    return {"current_mb": None if current is None else round(current / MIB, 1), "max_mb": maximum}


def display_roots(profile: str) -> list[Path]:
    """Resolve the selected Hermes home without crossing profiles."""
    roots: list[Path] = []
    configured = os.environ.get("HERMES_HOME")
    if configured:
        roots.append(Path(configured).expanduser())
    base = Path.home() / ".hermes"
    roots.append(base if profile == "default" else base / "profiles" / profile)
    # Keep a read-only fallback for callers that inspect a named profile from the
    # default launch environment; never mix two existing homes into one result.
    return list(dict.fromkeys(root / "bot-desktop" for root in roots))


def display_markers(profile: str) -> dict[str, bool]:
    names: set[str] = set()
    for root in display_roots(profile):
        try:
            names.update(path.name for path in root.iterdir())
            break
        except OSError:
            continue
    return {key: key in names for key in ("rfb.sock", "launcher.pid", "env", "Xauthority")}


def snapshot(phase: str, profile: str) -> dict[str, object]:
    info = meminfo()
    total = info.get("MemTotal")
    available = info.get("MemAvailable")
    swap_total = info.get("SwapTotal")
    swap_free = info.get("SwapFree")
    return {
        "schema": "hermes-bot-screen-memory-v1",
        "phase": phase,
        "profile": profile,
        "captured_unix": int(time.time()),
        "host_memory_mb": {
            "total": None if total is None else round(total / MIB, 1),
            "available": None if available is None else round(available / MIB, 1),
            "swap_used": None if swap_total is None or swap_free is None else round((swap_total - swap_free) / MIB, 1),
        },
        "cgroup_memory": cgroup_memory(),
        "process_families": processes(),
        "display_markers": display_markers(profile),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--phase", required=True, choices=("baseline", "starting", "viewer_live", "switch_profile", "chat_exit", "idle_recovery", "error_recovery"))
    parser.add_argument("--profile", default="default")
    parser.add_argument("--out", type=Path)
    args = parser.parse_args()
    result = snapshot(args.phase, args.profile)
    encoded = json.dumps(result, ensure_ascii=False, sort_keys=True, indent=2) + "\n"
    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(encoded, encoding="utf-8")
    print(encoded, end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
