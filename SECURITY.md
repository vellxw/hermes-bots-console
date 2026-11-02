# Security policy

## Scope

Report security issues in Hermes Bot Command, especially profile isolation, file handling, authorization gates, browser/display boundaries and secret handling.

Do not include passwords, tokens, cookies, MFA codes, private URLs, screenshots with personal data or chat transcripts in a report. Replace values with `[REDACTED]`.

## Supported versions

The current release candidate is `0.5.0-rc.1`. Older local builds are not security-supported.

## Reporting

Use the private security contact configured by the repository owner or the hosting provider's private vulnerability workflow. Do not open a public issue for an exploitable vulnerability. If no private channel is configured yet, keep the report local and ask the maintainer for the current contact.

The project will acknowledge receipt, reproduce the report with a redacted fixture, and publish a fix or mitigation when the issue is resolved.

## Safe defaults

- Keep the Hermes Dashboard behind its authentication and network controls.
- Never expose RFB, VNC, websockify, RDP or SSH directly to the public internet.
- Treat `account` labels as metadata, not credentials.
- Turbo never auto-approves login, MFA/CAPTCHA, payment, irreversible, legal or security-changing actions.
