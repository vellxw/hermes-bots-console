# Public launch acceptance and remaining manual gates

This document tracks what the portable repository suite can prove and what still requires a real installed Hermes environment. It must not be used to claim that the live viewer is certified.

## Automated CI gates

- `npm run verify`: manifests, SHA-384 entry integrity, required notices, secret/path markers and JavaScript syntax
- `npm run verify:catalog`: compare the catalog's pinned tag with the actual tagged frontend bytes, using the local Git tags (`git fetch --tags` when necessary)
- `npm run build`: reproduce versioned assets from readable sources
- `npm run pack`: produce a deterministic tarball with active frontend assets, including the native group policy module, and no CI/tests/scripts
- `npm test`: portable JavaScript contracts (serialized because packaging tests rebuild shared assets)
- `python -m pytest -q`: Python backend, profile safety, routing and persistence

CI is a cross-platform portability gate, **not** an authenticated browser smoke test.

## Known capability limits

1. An existing hosted Hermes room cannot have its members edited through the currently documented public Group Chat API. The UI refuses such edits instead of persisting a different local roster. Create a new group to change members.
2. Live Bot Screen is Linux-gateway-only until additional gateway platforms have been validated. Mobile and desktop clients can connect to a suitable remote gateway.
3. Audio transcription/synthesis requires a configured Hermes/provider adapter.
4. The animated `docs/demo.svg` is a concept illustration, not an authenticated browser capture.
5. A fresh plugin install, `hermes plugins validate`, `hermes doctor`, chat exchange and remote viewer control remain **manual acceptance gates**.

## Manual acceptance checklist (non-production profiles)

- [ ] Install the current reviewed commit of Hermes and confirm `hermes --version`
- [ ] Install the plugin from the review branch or candidate release and run `hermes plugins validate`
- [ ] Open the authenticated Dashboard and confirm the Bots tab appears
- [ ] Select two harmless test profiles and verify their chats remain isolated
- [ ] Create a group with 2 test bots, send a harmless message and verify `groups.log` events
- [ ] After room creation, attempt to edit members: the UI must refuse the change without modifying local configuration
- [ ] Switch from a busy/high-sequence group to a second room and verify the first room's events do not appear in the second
- [ ] Force a failed `groups.send` operation and confirm the unsent draft is restored without overwriting newer typing
- [ ] On a Linux gateway with Bot Desktop, observe one profile's display, explicitly acquire and release a human lease
- [ ] Verify the mobile viewer, disconnect/reconnect, bot switching, timeout and memory-blocked states
- [ ] Record redacted real screenshots/video only after actual authenticated validation
- [ ] Confirm archive SHA-256 and frontend SRI against the GitHub candidate artifacts before a release

## Rollback

Keep `main` unchanged until the PR is reviewed. To revert a reviewed installation, stop the Dashboard and reinstall the previous known-good plugin version. Preserve profile-scoped data and audit records; uninstalling or rolling back must not silently delete them. Verify plugin registration, chat, group logs and display leases after rollback.

## Release checklist

- [ ] All CI jobs pass on Linux, macOS and Windows
- [ ] Authenticated gateway tests complete
- [ ] Screenshots and demo from real Hermes session
- [ ] Version bump and correctly flagged GitHub prerelease
- [ ] Attach deterministic archive with SHA-256 matching the documented release
- [ ] Configure a private vulnerability reporting channel and confirm it is reachable
