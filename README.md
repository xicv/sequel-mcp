# sequel-mcp

[![npm](https://img.shields.io/npm/v/sequel-mcp.svg)](https://www.npmjs.com/package/sequel-mcp)
[![CI](https://github.com/xicv/sequel-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/xicv/sequel-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

A Model Context Protocol server for MySQL/MariaDB with **policy-gated action sets** (allow / confirm / deny per category) and **macOS Keychain credential storage** that never leaves your Mac. Optional one-time import of [Sequel Ace](https://sequel-ace.com) favorites.

> Renamed from `sequel-ace-mcp` (≤ 0.1.0) → `sequel-mcp` (0.1.1+). The package was renamed because it's a fully standalone MySQL/MariaDB MCP — Sequel Ace is supported via an optional importer, not required. Migration: `npx -y sequel-mcp sequel-mcp-migrate` (copies config + Keychain entries from the old name; non-destructive).

## Why

- Claude Desktop / Claude Code can run real SQL against your DB without round-tripping you to a GUI.
- Your existing Sequel Ace favorites can be imported one-time so you don't re-enter host/port/SSH config.
- Every write/DDL/admin statement runs through a configurable approval gate. Read-only is the default; nothing destructive happens silently.
- Passwords live in the macOS Keychain (`security` + `@napi-rs/keyring`), not in `claude_desktop_config.json` or any cloud sync.

## Install

### Requirements

- macOS 12+ (Apple Silicon or Intel) — Keychain + Touch ID rely on macOS APIs.
- Node.js 20+
- (optional) Xcode Command Line Tools — for the Touch ID helper. Install with `xcode-select --install`.

### Option A — From npm (recommended)

No install needed — npx fetches and runs the latest release on demand:

```bash
npx -y sequel-mcp
# or, install globally if you prefer:
# npm install -g sequel-mcp
```

### Option B — From source

```bash
git clone https://github.com/xicv/sequel-mcp.git
cd sequel-mcp
npm install
npm run build
npm run build:touchid     # optional — Swift LocalAuthentication helper
```

The MCP entry point is then at `<repo>/dist/index.js`.

### Wire into Claude Code

```bash
# npx (recommended):
claude mcp add --scope user sequel-ace -- npx -y sequel-mcp

# Or pointing at a local source clone:
# claude mcp add --scope user sequel-ace -- node /absolute/path/to/sequel-mcp/dist/index.js
```

Verify:

```bash
claude mcp list   # sequel-ace should appear with ✓ Connected
```

In a CC session, `/mcp` lists every tool the server exposes (13 at v0.1.0).

### Wire into Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "sequel-ace": {
      "command": "npx",
      "args": ["-y", "sequel-mcp"]
    }
  }
}
```

Or, for a local source clone, replace with:

```json
{ "command": "node", "args": ["/absolute/path/to/sequel-mcp/dist/index.js"] }
```

Restart Claude Desktop.

### Wire into Cursor / other MCP clients

Any client that speaks the MCP stdio transport works. Point its `command` at `node` and `args` at the absolute path of `dist/index.js`.

### First-run quickstart

Either of:

- **"Use sequel-ace MCP. Import my Sequel Ace connections."** — calls `import_from_sequel_ace`. macOS will prompt once per favorite to allow Keychain access; click "Always Allow". Imported connections default to the read-only preset.
- **"Use sequel-ace MCP. Add a connection 'local' on 127.0.0.1:3306, user root, database app, read-only preset."** — calls `add_connection`. The MCP elicits the password mid-call; it goes straight to the macOS Keychain. No password ever appears in your chat or any config file.

Then:

> "Set the default connection to local."
>
> "Count rows in users."

There are **no credentials in `claude_desktop_config.json`** or any other config file. Passwords live only in the macOS Keychain.

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

- `sequel-mcp://connections` — JSON listing of saved connections (no secrets).

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
- Service name: `sequel-mcp : <connection-name>`. Account: DB user. Visible in `Keychain Access.app` so you can revoke any time.
- We **never** read Sequel Ace's keychain at runtime (its items belong to its sandboxed bundle ID and would prompt every time). The one-time `import_from_sequel_ace` tool calls `/usr/bin/security` once per item — macOS prompts you "Always Allow / Allow / Deny", and we copy the result into our own service namespace.

## Touch ID

Set `requireTouchID: true` on a connection's policy. The first SQL operation after a 15-minute idle window prompts you via macOS LocalAuthentication; subsequent calls within the window skip the prompt. Built from `scripts/touchid-helper.swift` (compiled with `swiftc` on first use; falls back gracefully if Xcode CLI tools are missing).

## SSH tunnels

If a connection has SSH details (auto-imported from Sequel Ace), `executeStatement` opens an `ssh2` local-to-remote tunnel before connecting `mysql2`. SSH passwords/passphrases live in Keychain under `<conn-name>::ssh`.

## Migrating from sequel-ace-mcp

If you previously installed `sequel-ace-mcp@0.1.0`, run:

```bash
npx -y sequel-mcp-migrate          # if installed via npm
# or from a source checkout:
# node dist/migrate.js
```

Copies `~/.config/sequel-ace-mcp/config.json` → `~/.config/sequel-mcp/config.json` and re-keys macOS Keychain entries from service `sequel-ace-mcp : <name>` to `sequel-mcp : <name>`. Non-destructive by default — old entries stay until you pass `--purge`. Add `--force` to overwrite an existing new-name config. Add `--json` for machine-readable output.

After migration, update your MCP client config:

```bash
claude mcp remove sequel-ace
claude mcp add --scope user sequel-mcp -- npx -y sequel-mcp
```

## Doctor / debugging

```bash
npm run doctor                        # text report (after npm run build)
node dist/doctor.js --json            # machine-readable
sequel-mcp-doctor                 # if installed globally
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
