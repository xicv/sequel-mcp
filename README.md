# sequel-ace-mcp

A Model Context Protocol server that lets Claude (or any MCP client) talk to MySQL/MariaDB databases using the connections you've already saved in [Sequel Ace](https://sequel-ace.com), with **policy-gated action sets** (allow / confirm / deny per category) and **macOS Keychain credential storage** that never leaves your Mac.

## Why

- Claude Desktop / Claude Code can run real SQL against your DB without round-tripping you to a GUI.
- Your existing Sequel Ace favorites can be imported one-time so you don't re-enter host/port/SSH config.
- Every write/DDL/admin statement runs through a configurable approval gate. Read-only is the default; nothing destructive happens silently.
- Passwords live in the macOS Keychain (`security` + `@napi-rs/keyring`), not in `claude_desktop_config.json` or any cloud sync.

## Install

```bash
npm install -g sequel-ace-mcp
# or run via npx without installing:
# npx -y sequel-ace-mcp
```

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "sequel-ace": {
      "command": "npx",
      "args": ["-y", "sequel-ace-mcp"]
    }
  }
}
```

There are **no credentials** in this config. Passwords go through the `add_connection` tool's elicitation flow into the macOS Keychain.

## Action sets (the permission model)

Each connection has a policy with five categories. Each category is `allow` | `confirm` | `deny`.

| Category | What it covers                                           |
|----------|----------------------------------------------------------|
| `read`   | `SELECT`, `SHOW`, `DESCRIBE`, `EXPLAIN`                  |
| `write`  | `INSERT`, `UPDATE`, `DELETE`, `REPLACE`                  |
| `ddl`    | `CREATE`, `ALTER`, `DROP`, `TRUNCATE`, `RENAME`          |
| `admin`  | `GRANT`, `REVOKE`, `SET GLOBAL`, `KILL`, `FLUSH`, `LOAD` |
| `txCtrl` | `BEGIN`, `COMMIT`, `ROLLBACK`, `SAVEPOINT`               |

`confirm` triggers an MCP **elicitation**: the client surfaces a dialog requiring you to type `CONFIRM` (uppercase, exact). No "always allow" can bypass it because the prompt is server-issued per call.

### Presets

| Preset      | read   | write   | ddl     | admin  | rowCap | timeout |
|-------------|--------|---------|---------|--------|--------|---------|
| `read-only` | allow  | deny    | deny    | deny   | 1000   | 10s     |
| `dev`       | allow  | confirm | confirm | deny   | 5000   | 30s     |
| `admin`     | allow  | confirm | confirm | confirm| 5000   | 60s     |

Tweak via the `set_policy` tool — no need to edit JSON.

## Tools

| Tool                       | Annotation               | What it does |
|----------------------------|--------------------------|--------------|
| `list_connections`         | readOnly                 | Show saved connections (no secrets). Marks the default with `isDefault`. |
| `query`                    | readOnly                 | Run a single read SELECT/SHOW/DESCRIBE/EXPLAIN. Wrapped in `START TRANSACTION READ ONLY`. |
| `execute`                  | destructive              | Run a single non-read statement; subject to the connection policy. |
| `describe_table`           | readOnly                 | `DESCRIBE table` (identifier-validated). |
| `list_databases`           | readOnly                 | `SHOW DATABASES`. |
| `add_connection`           | -                        | Add/update connection. Password captured via elicitation; stored in Keychain. |
| `remove_connection`        | destructive              | Forget a connection and delete its Keychain entry. |
| `set_policy`               | -                        | Change a connection's action set or limits. |
| `set_default_connection`   | -                        | Make a connection the default; subsequent calls without a `connection` arg use it. Pass empty string to clear. |
| `get_default_connection`   | readOnly                 | Return the current default connection name. |
| `select_database`          | -                        | Set a connection's default database (no password needed). |
| `import_from_sequel_ace`   | -                        | One-time import from Sequel Ace's `Favorites.plist` + Keychain. |
| `doctor`                   | readOnly                 | Sanitized JSON diagnostic: runtime, paths, connections, policy, password presence. **No secrets.** |

## Default connection / database

Set once, omit `connection` (and optionally `database`) on every subsequent call:

```text
"set the default connection to local"
"set local's default database to app"
"count rows in users"        → query({sql:"SELECT COUNT(*) FROM users"}) — picks local/app
"on prod, count rows in audit"  → explicit override; default untouched
```

## Prompts

- `setup-connection` — guided new-connection workflow.
- `analyze-table` — read-only investigation: schema, indexes, row count, sample.

## Resources

- `sequel-ace-mcp://connections` — JSON listing of saved connections (no secrets).

## Defence in depth

1. **AST classification** via `node-sql-parser` (closed-world: unknown statement types are denied).
2. **Multi-statement input rejected** at parse time.
3. **Driver-level**: `multipleStatements: false`.
4. **Server-side enforcement**: read-only category runs inside `START TRANSACTION READ ONLY`.
5. **Policy gate**: every category passes through `allow` / `confirm` / `deny`.
6. **Elicitation confirmation**: typed `CONFIRM` token, not a checkbox; uncircumventable by client allowlist.
7. **Row cap + timeout**: per-connection `rowCap` and `MAX_EXECUTION_TIME` hint.
8. **Touch ID**: optional per-session unlock via macOS LocalAuthentication.

## Credentials — local-only by design

- Stored via `@napi-rs/keyring` → macOS Keychain Services API.
- Default attributes: non-syncable, `WhenUnlockedThisDeviceOnly`. Not iCloud Keychain.
- Service name: `sequel-ace-mcp : <connection-name>`. Account: DB user. Visible in `Keychain Access.app` so you can revoke any time.
- We **never** read Sequel Ace's keychain at runtime (its items belong to its sandboxed bundle ID and would prompt every time). The one-time `import_from_sequel_ace` tool calls `/usr/bin/security` once per item — macOS prompts you "Always Allow / Allow / Deny", and we copy the result into our own service namespace.

## Touch ID

Set `requireTouchID: true` on a connection's policy. The first SQL operation after a 15-minute idle window prompts you via macOS LocalAuthentication; subsequent calls within the window skip the prompt. Built from `scripts/touchid-helper.swift` (compiled with `swiftc` on first use; falls back gracefully if Xcode CLI tools are missing).

## SSH tunnels

If a connection has SSH details (auto-imported from Sequel Ace), `executeStatement` opens an `ssh2` local-to-remote tunnel before connecting `mysql2`. SSH passwords/passphrases live in Keychain under `<conn-name>::ssh`.

## Doctor / debugging

```bash
npm run doctor                        # text report (after npm run build)
node dist/doctor.js --json            # machine-readable
sequel-ace-mcp-doctor                 # if installed globally
```

Or call the `doctor` MCP tool from Claude:

> "Run sequel-ace doctor and show the report."

The report includes runtime versions, every configured connection (host, user, database, SSH key path), policy, and `hasStoredPassword` boolean. **It includes no passwords or other Keychain secrets.** It does include hostnames, DB usernames, and key paths from your local config — review and redact before pasting into a public bug report.

## Development

```bash
npm install
npm run typecheck
npm run lint
npm test
npm run build
npm run build:touchid     # macOS only — Swift LocalAuthentication helper
npm run security:scan     # local secret regex scan
./scripts/install-pre-commit-hook.sh   # optional — run secret scan on every commit
```

## Security

See [SECURITY.md](./SECURITY.md) for the threat model and [CONTRIBUTING.md](./CONTRIBUTING.md) for contributor rules around credentials and PII.

Quick summary: **no credential, no PII, no environment-specific identifier may ever enter this repository.** Test fixtures use the IETF-reserved `example.com` domain. A regex scanner (`scripts/check-secrets.sh`) runs locally and as an optional pre-commit hook.

## Threat model (what's NOT protected)

See [SECURITY.md](./SECURITY.md) for the full threat model. Highlights:

- A logged-in attacker on your Mac with shell access can read process memory and grab the cached password during the 15-min idle window. Use `requireTouchID: true` to shorten the trust window.
- The MCP itself runs in your user context with no extra sandboxing. Keep your `claude_desktop_config.json` mcpServers list to vetted servers.
- We do not pin TLS certs. If `ssl: true` and your DB is on the open internet, configure your DB to require valid certs server-side.

## License

MIT — see [LICENSE](./LICENSE).
