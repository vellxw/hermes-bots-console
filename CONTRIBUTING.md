# Contributing to Hermes Bot Command

Thank you for your interest in contributing! This document provides guidelines and instructions for contributing to the project.

## Code of Conduct

This project adheres to a code of conduct. By participating, you are expected to uphold this code. Please report unacceptable behavior to the maintainers.

## How to Contribute

### Reporting Bugs

Before creating a bug report, please check the [existing issues](https://github.com/vellxw/hermes-bots-console/issues) to avoid duplicates.

When creating a bug report, include:
- A clear, descriptive title
- Steps to reproduce the issue
- Expected vs. actual behavior
- Environment details (OS, Hermes version, plugin version)
- Relevant logs (redact any credentials)

### Suggesting Features

Feature requests are welcome! Please:
- Check existing issues first
- Describe the use case and expected behavior
- Consider security implications (profile isolation, secret handling)

### Pull Requests

1. **Fork** the repository
2. **Create a branch** from `main` (`git checkout -b feature/my-feature`)
3. **Make your changes** following the guidelines below
4. **Add tests** for new functionality
5. **Run the full test suite** (`npm run test:all`)
6. **Commit** with a clear message
7. **Push** to your fork
8. **Open a Pull Request** against `main`

## Development Setup

### Prerequisites

- Python 3.10+
- Node.js 18+
- Hermes (for manual authenticated checks)

### Setup

```bash
git clone https://github.com/vellxw/hermes-bots-console.git
cd hermes-bots-console
```

### Running Tests

```bash
# Full test suite (verify + build + JS + Python)
npm run test:all

# Individual suites
npm run verify          # manifest/SRI/public tree checks
npm run build           # rebuild cache-busted bundles
npm test                # JavaScript tests
npm run test:python     # Python tests

# Focused tests
node --test tests/core.test.mjs
python -m pytest tests/test_plugin_api.py -q
```

## Guidelines

### Profile Isolation

Every feature must respect profile boundaries:
- Never share browser profiles, displays, sockets or leases between profiles
- Validate profile IDs with `^[a-z0-9][a-z0-9_-]{0,63}$`
- Store mutable data in `$HERMES_HOME/profiles/<profile>/plugin-data/`

### Security

- Never commit credentials, tokens, cookies, OTPs or connection strings
- Use `[REDACTED]` in reports and logs
- Attachments must be size/MIME-checked and stored outside chat
- Grants store labels and capabilities, never secrets

### Testing

- Add a focused regression test before changing behavior
- Run the focused test as RED, implement the smallest fix, then run GREEN
- Execute the full suite before submitting a PR
- Authenticated desktop/browser probes are excluded from CI

### Documentation

- Update README.md for user-visible changes
- Update docs/ for architecture or lifecycle changes
- Keep SECURITY.md current for new capabilities

## Change rules (from original)

- Keep profile IDs isolated and reject malformed identifiers instead of normalizing them silently.
- Store mutable data through Hermes profile storage, never beside installed plugin files.
- Do not add credentials, cookies, tokens, OTPs, transcripts, screenshots with PII or workstation paths.
- Add a focused regression test before changing behavior. Run the focused test as RED, implement the smallest fix, then run the full suite.
- Do not change Hermes core to compensate for a missing public hook. Document the missing hook instead.
- Keep authenticated desktop/browser smoke probes out of the public test suite. Portable tests must use fixtures and dry-run adapters.

## Pull requests

Describe the user-visible behavior, supported client and gateway operating systems, security implications and the commands you ran. Do not claim visual certification without an authenticated Dashboard session and a real profile-scoped desktop lease.

## Release Process

1. Update version in `package.json`, `plugin.json`, `manifest.json`, `catalog-entry.yaml`
2. Run `npm run pack` and record the SHA-256
3. Update `CHANGELOG.md`
4. Create a git tag (`v0.5.0-rc.1`)
5. Create a GitHub release
6. Update `catalog-entry.yaml` with the real commit SHA

## Getting Help

- Open an issue for bugs or feature requests
- Check [docs/](docs/) for architecture details
- Read [SECURITY.md](SECURITY.md) for security policies

---

Thank you for contributing!