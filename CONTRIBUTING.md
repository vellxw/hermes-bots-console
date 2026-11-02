# Contributing

## Development setup

1. Install Hermes using its official documentation for your operating system.
2. Clone this repository and enter it.
3. Use Python 3.10+ and Node.js 18+ for the portable test suite.
4. Run `npm run test:all`.
5. Run `npm run pack` when preparing a release candidate. It rebuilds the versioned bundles, verifies the public tree and emits a deterministic archive under `dist/`.

The checked-in Dashboard bundles are the installable artifacts. Node is needed to run repository checks and rebuild metadata, not by an end user installing a release bundle.

## Change rules

- Keep profile IDs isolated and reject malformed identifiers instead of normalizing them silently.
- Store mutable data through Hermes profile storage, never beside installed plugin files.
- Do not add credentials, cookies, tokens, OTPs, transcripts, screenshots with PII or workstation paths.
- Add a focused regression test before changing behavior. Run the focused test as RED, implement the smallest fix, then run the full suite.
- Do not change Hermes core to compensate for a missing public hook. Document the missing hook instead.
- Keep authenticated desktop/browser smoke probes out of the public test suite. Portable tests must use fixtures and dry-run adapters.

## Pull requests

Describe the user-visible behavior, supported client and gateway operating systems, security implications and the commands you ran. Do not claim visual certification without an authenticated Dashboard session and a real profile-scoped desktop lease.
