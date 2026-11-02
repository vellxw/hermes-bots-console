# Changelog

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
