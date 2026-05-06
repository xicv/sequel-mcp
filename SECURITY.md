# Security Policy

## Supported Versions

| Version | Supported          |
|---------|--------------------|
| 0.1.x   | :white_check_mark: |

## Reporting a Vulnerability

If you find a security issue, **do not open a public GitHub issue**. Instead, open a private security advisory on the repository or email the maintainers directly. We aim to acknowledge within 72 hours.

## Threat Model

This MCP server runs locally on the user's Mac as a child process of an MCP client (Claude Code, Claude Desktop, Cursor, etc.). It connects to MySQL/MariaDB databases the user has configured.

### What we protect

| Asset                              | Storage                                                                | Protection                                                                                                                |
|------------------------------------|------------------------------------------------------------------------|---------------------------------------------------------------------------------------------------------------------------|
| Database passwords                 | macOS Keychain via `@napi-rs/keyring`                                  | `WhenUnlockedThisDeviceOnly`, non-syncable. Never written to disk in plaintext. Never sent to any cloud service.          |
| SSH tunnel passphrases             | macOS Keychain (`<conn-name>::ssh` service)                            | Same as above.                                                                                                            |
| Connection metadata (host/user/db) | `~/.config/sequel-ace-mcp/config.json`, `0o600` permissions            | Local file only. No passwords stored here.                                                                                |
| Per-statement intent               | In-memory only                                                         | Confirmation tokens never persisted.                                                                                      |

### Boundaries enforced by this server

- **No outbound network calls** other than the MySQL/MariaDB target host (via direct TCP or SSH tunnel) configured by the user. No telemetry. No update checks. No external lookups.
- **Read-only category SQL** runs inside `START TRANSACTION READ ONLY`. MySQL rejects writes with error 1792 even if the DB user holds write privileges — server-side belt-and-braces over our parser-side suspenders.
- **Multi-statement input rejected** at parse time **and** at the driver level (`multipleStatements: false`). `SELECT 1; DROP TABLE x` cannot be smuggled.
- **Closed-world classification**: any AST type the parser doesn't recognise is treated as `unknown` → denied. Admin keywords the parser can't parse (e.g. `REVOKE`) are caught by a regex fallback and classified as `admin` (default `deny`).
- **Confirmation gate is server-issued**, not client allowlist–bypassable. A user-typed `CONFIRM` token is required for every gated statement; it never short-circuits.
- **Touch ID** is optional per connection; uses macOS `LocalAuthentication`, not the network.

### What is NOT protected

- A logged-in attacker on the same Mac with shell access can read the MCP process memory and may extract a cached password during the configured idle window. Use `requireTouchID: true` to shorten that window.
- This server is not sandboxed. Run it under your normal user account; do not run it as root.
- We do not pin TLS certificates. If you set `ssl: true` against a public-internet database, configure the database's TLS policy server-side.
- We do not encrypt the local config file beyond default `0o600` filesystem permissions. Anyone with `cat` access to your home directory can read it (host/user/db only — no passwords).
- We do not protect against malicious MCP clients. The client decides which tools to call; this server enforces what each tool is *allowed* to do once called.

### Defence-in-depth layers

1. AST classification (`node-sql-parser` + admin-keyword regex fallback).
2. Multi-statement rejection (parser + driver flag).
3. Server-side `START TRANSACTION READ ONLY` for read-category statements.
4. Per-connection policy (`allow` | `confirm` | `deny`) per category.
5. MCP elicitation prompt with typed `CONFIRM` token for `confirm` actions.
6. Row cap + `MAX_EXECUTION_TIME` hint per connection.
7. Optional Touch ID gate per session.
8. Recommended: a dedicated read-only DB user with `GRANT SELECT` only.

## Credentials and the Repository

This repository must never contain credentials, even in test fixtures. To enforce:

- `.gitignore` excludes common credential file patterns and any `.env*` file other than `.env.example`.
- Test fixtures use the IETF-reserved domain `example.com` and obviously-fake names like `prod-tunnel`.
- `scripts/check-secrets.sh` performs a regex scan; run before each commit.
- See `CONTRIBUTING.md` for the full contributor checklist.

If you suspect a credential has been committed historically, consider the credential compromised, rotate it immediately, and run `git filter-repo` to scrub history before any push.
