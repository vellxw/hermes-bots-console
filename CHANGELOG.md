# Changelog

## Unreleased — public launch hardening (draft PR)

- Fix auxiliary routing so model timeouts and exceptions use local queue/steer fallback.
- Make first-run diagnostics honest about what the backend can and cannot verify.
- Fail closed on membership changes to an existing native Hermes room (upstream currently exposes no public membership edit RPC), paginate `groups.list` using `next_offset`, and verify the actual room roster before sending messages.
- Verify catalog integrity against its pinned release tag rather than unreleased development assets.
- Restore portability of storage and test tooling across Linux, macOS and Windows.
- Package only active versioned assets and their readable sources, omit development-only tests/scripts from installation archives, and correct catalog SRI metadata and invalid artifact digest.
- Clarify that the SVG demonstration is illustrative, not a validated authenticated recording.
- Keep releases as candidates until real Hermes installation and desktop-viewer acceptance testing is performed.

## 0.5.0-rc.1

- Added a profile-scoped contextual desktop monitor in the PC chat inspector with explicit lifecycle states, fresh observe tickets, conservative memory gating, human-lease protection, and on-demand cleanup. Mobile keeps its separate fullscreen/touch viewer.
- Added `scripts/measure-bot-screen.py` and `docs/bot-screen-lifecycle.md` for aggregate RSS/PSS measurements, RAM policy, and rollback. No Hermes profile configuration or human-owned display was changed.
- Prepared the Dashboard plugin for independent distribution.
- Moved groups, Turbo state, attachments and voice staging to Hermes profile-scoped data storage with safe legacy migration.
- Added portable repository metadata, CI, security guidance and reproducible manifest/SRI checks.
- Added a deterministic release packer with a catalog SHA-256 gate.
- Removed workstation-specific paths from distributed contracts and browser-flow fixtures.
- Documented the Linux gateway limit for the isolated desktop viewer.

## 0.4.8

- Historical local release. See the internal development history outside the public package for prior work.
