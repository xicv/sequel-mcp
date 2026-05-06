# sequel-mcp

[![npm](https://img.shields.io/npm/v/sequel-mcp.svg)](https://www.npmjs.com/package/sequel-mcp)
[![CI](https://github.com/xicv/sequel-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/xicv/sequel-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

A Model Context Protocol server for **MySQL/MariaDB** with policy-gated action sets, pre-mutation backups, an immutable audit log, macOS Keychain credential storage, and optional Touch ID. Designed so Claude (or any MCP client) can run real SQL safely enough to use every day.

> **Sequel Ace is OPTIONAL.** This is a fully standalone MCP. Sequel Ace integration is a *bootstrap convenience* (one-time import of saved favorites) and a *history augment* (read its query history alongside our audit log). If you don't have Sequel Ace installed, 23 of 25 tools still work — only `import_from_sequel_ace` and `sequel_ace_history` will fail with a clear "not found" error. Use `add_connection` instead.

> Renamed from `sequel-ace-mcp` (≤ 0.1.0) → `sequel-mcp` (0.1.1+). Migration: `npx -y sequel-mcp-migrate` (non-destructive).

## What's in 0.4.0

- **Two-layer permissions** — connection-level baseline cascades to all DBs; per-database overrides take precedence; strictest-wins for multi-DB statements (Apache Ranger semantics, fail-closed).
- **Pre-mutation backups** — UPDATE/DELETE/REPLACE/INSERT/TRUNCATE/DROP/ALTER captured into a local SQLite. Multi-table UPDATE/DELETE produce one backup per mutated table. INSERT and REPLACE rollback hints included.
- **Restore from any backup** — `restore_backup` plans + executes. Default `dryRun=true`. Subject to the same policy gate as live writes.
- **Audit log** — every tool call written to `~/.local/share/sequel-mcp/audit.sqlite` with redacted SQL, decision, outcome, duration, target databases, backup_id linkage. Optional SHA-256 prev-hash chain for tamper-evidence.
- **Per-category retention** — `read=7d / write=30d / ddl=90d / admin=180d / txCtrl=7d`. Auto-cleanup runs lazily on server boot.
- **Unified history search** — merges our audit log with Sequel Ace's `queryHistory.db` (when present) into one timeline.
- **macOS-native security** — passwords in Keychain (non-syncable, `WhenUnlockedThisDeviceOnly`); Touch ID gate via `LocalAuthentication`; SSH tunnels via `ssh2`.

## Install

### Requirements

- macOS 12+ (Apple Silicon or Intel) — Keychain + Touch ID rely on macOS APIs.
- Node.js 20+ (24 supported).
- *Optional:* Xcode Command Line Tools — for the Touch ID helper. Install with `xcode-select --install`.

### From npm (recommended)

```bash
npx -y sequel-mcp                  # ad-hoc, no global install
# or:
# npm install -g sequel-mcp
```

### From source

```bash
git clone https://github.com/xicv/sequel-mcp.git
cd sequel-mcp
npm install
npm run build
npm run build:touchid              # optional — Swift LocalAuthentication helper
```

The MCP entry point is at `<repo>/dist/index.js`.

### Wire into Claude Code

```bash
claude mcp add --scope user sequel-mcp -- npx -y sequel-mcp
```

For a local source clone, replace the command:

```bash
claude mcp add --scope user sequel-mcp -- node /absolute/path/to/sequel-mcp/dist/index.js
```

Verify:

```bash
claude mcp list   # sequel-mcp should appear with ✓ Connected
```

In a Claude Code session, `/mcp` lists every tool the server exposes (25 at v0.4.0).

### Wire into Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "sequel-mcp": {
      "command": "npx",
      "args": ["-y", "sequel-mcp"]
    }
  }
}
```

Restart Claude Desktop.

### Wire into Cursor / other MCP clients

Any client that speaks the MCP stdio transport works. Point its `command` at `npx -y sequel-mcp` (or `node` + absolute `dist/index.js` path).

### First-run quickstart

```text
"Add a sequel-mcp connection 'local' on 127.0.0.1:3306, user root, database app, read-only preset."
   → add_connection. Password elicited mid-call → macOS Keychain.

"Set the default connection to local."
"Count rows in users."
   → query({sql: 'SELECT COUNT(*) FROM users'})  — uses local default
```

If you already use Sequel Ace:

```text
"Import my Sequel Ace connections."
   → import_from_sequel_ace. macOS prompts once per favorite to allow Keychain access; click "Always Allow".
```

There are **no credentials in `claude_desktop_config.json`** or any other config file. Passwords live only in the macOS Keychain.

## Action sets — the permission model

Each connection has a policy with five categories. Each is `allow` | `confirm` | `deny`.

| Category | What it covers                                           |
|----------|----------------------------------------------------------|
| `read`   | `SELECT`, `SHOW`, `DESCRIBE`, `EXPLAIN`                  |
| `write`  | `INSERT`, `UPDATE`, `DELETE`, `REPLACE`                  |
| `ddl`    | `CREATE`, `ALTER`, `DROP`, `TRUNCATE`, `RENAME`          |
| `admin`  | `GRANT`, `REVOKE`, `SET GLOBAL`, `KILL`, `FLUSH`, `LOAD` |
| `txCtrl` | `BEGIN`, `COMMIT`, `ROLLBACK`, `SAVEPOINT`               |

`confirm` triggers an MCP **elicitation** — the client surfaces a dialog requiring you to type `CONFIRM` (uppercase, exact). The prompt is **server-issued per call** — no client allowlist can bypass it.

### Presets

| Preset      | read   | write   | ddl     | admin  | rowCap | timeout | Touch ID |
|-------------|--------|---------|---------|--------|--------|---------|----------|
| `read-only` | allow  | deny    | deny    | deny   | 1000   | 10s     | off      |
| `dev`       | allow  | confirm | confirm | deny   | 5000   | 30s     | off      |
| `admin`     | allow  | confirm | confirm | confirm| 5000   | 60s     | **on**   |

Adjust per-connection via `set_policy` or per-database via `set_database_policy` — no JSON editing.

## Tools (25)

| Tool                       | Annotation               | What it does |
|----------------------------|--------------------------|--------------|
| `query`                    | readOnly                 | Single read SELECT/SHOW/DESCRIBE/EXPLAIN. Wrapped in `START TRANSACTION READ ONLY`. |
| `execute`                  | destructive              | Single non-read statement; subject to policy. Backup captured automatically. |
| `describe_table`           | readOnly                 | `DESCRIBE table` (identifier-validated). |
| `list_databases`           | readOnly                 | `SHOW DATABASES`. |
| `list_connections`         | readOnly                 | Saved connections (no secrets). Marks `isDefault`. |
| `add_connection`           | -                        | Add/update connection. Password via elicitation → Keychain. |
| `remove_connection`        | destructive              | Forget a connection + delete Keychain entry. |
| `set_policy`               | -                        | Change a connection's baseline action set or limits. |
| `set_database_policy`      | -                        | Per-database policy override. Takes precedence over baseline. |
| `clear_database_policy`    | -                        | Revert one DB to baseline cascade. |
| `list_database_policies`   | readOnly                 | Baseline + every override for a connection. |
| `set_default_connection`   | -                        | Subsequent calls use this when `connection` arg omitted. Empty string clears. |
| `get_default_connection`   | readOnly                 | Return the current default name. |
| `select_database`          | -                        | Set a connection's default database (no password needed). |
| `audit_search`             | readOnly                 | Query the local audit log SQLite. |
| `audit_cleanup`            | destructive              | Prune entries past retention. `dryRun=true` to preview. |
| `set_retention`            | -                        | Configure per-category windows + size caps. |
| `list_backups`             | readOnly                 | Show recent pre-mutation backups. |
| `restore_backup`           | destructive              | Replay a backup back into MySQL. Default `dryRun=true`. Goes through the policy gate. |
| `history_search`           | readOnly                 | Unified timeline: MCP audit + Sequel Ace queryHistory.db (when present). |
| `import_from_sequel_ace`   | -                        | One-time import from Sequel Ace's `Favorites.plist` + Keychain. **Requires Sequel Ace installed.** |
| `sequel_ace_history`       | readOnly                 | Read Sequel Ace's GUI query history (read-only). **Requires Sequel Ace installed.** |
| `doctor`                   | readOnly                 | Sanitized JSON diagnostic. **No passwords.** |
| `setup-connection` (prompt)| -                        | Guided new-connection workflow. |
| `analyze-table` (prompt)   | -                        | Read-only schema/index/sample inspection. |

Plus one resource: `sequel-mcp://connections` (JSON listing).

---

## Security playbook — real-world use

This section is the *how-to-not-shoot-yourself* guide. The tool's defaults are conservative; this section tells you exactly what to do at each level of trust.

### Daily read-only operation (recommended baseline)

The default preset is `read-only`. Writes/DDL/admin are **denied outright** — not "confirm", but "blocked". Run as much SELECT/SHOW/DESCRIBE/EXPLAIN as you want.

```text
"On acme-prod, list databases."
"Describe the users table on acme-prod/app."
"On acme-prod, count rows in orders where status = 'pending'."
```

If Claude tries to write, it gets `Denied by policy: write statements not allowed on "acme-prod"`. No prompt, no slip — the only escape is you explicitly relaxing the policy.

**This is the level I recommend for all production connections, all the time.**

### Adding selective write capability (per-database, scoped)

You rarely need writes everywhere. Scope them down:

```text
"Set baseline on acme-prod to read-only."
"Override the policy for staging on acme-prod: write=confirm, ddl=deny."
"List database policies on acme-prod."
   → baseline read-only; staging has write=confirm; everything else read-only.
```

Now Claude can `INSERT`/`UPDATE`/`DELETE` on `staging` only — every write triggers a CONFIRM prompt — and is silently blocked on every other DB. A cross-DB `JOIN` that touches a denied DB fails closed.

### Confirming a write

When `write=confirm`:

1. Claude runs the tool. The server classifies it (AST + admin keyword fallback). Multi-statement input rejected.
2. Server fires `elicitation/create` to your client. You see:
   ```
   About to run a WRITE statement on connection "acme-prod".
   --- SQL ---
   UPDATE staging.users SET email = 'x' WHERE id = 1
   --- end ---
   Type CONFIRM (uppercase, exact) to proceed. Anything else cancels.
   ```
3. Type `CONFIRM`. Anything else (typo, "yes", empty) cancels.
4. **Backup captured** via `SELECT … FOR UPDATE` in the same tx.
5. Statement runs.
6. Audit log entry written, linked to `backup_id`.

You'd see this exact flow even if Claude is being prompt-injected — the prompt isn't bypassable from the model side.

### Reviewing the audit log (weekly habit)

```text
"Search audit log for the last 7 days, outcome=denied."
   → audit_search({sinceIso: '...', outcome: 'denied'})
   Shows what Claude tried that you blocked. Useful for: "is the model
   trying to do things I didn't expect?"

"Search audit log for the last 7 days, category=write."
   → All confirmed writes. Skim to make sure each was intentional.
```

If a denied entry surprises you, that's signal — either the model misunderstood your request, or your policy needs tightening.

### Restoring from a mistake

When something goes sideways:

```text
"List backups on acme-prod from the last day."
   → list_backups, sorted newest first.

"Show me the restore plan for backup #142, dry run."
   → restore_backup({backupId: 142, dryRun: true})
   Returns the exact SQL it would run + warnings.

"Restore backup #142."
   → restore_backup({backupId: 142, dryRun: false})
   Re-confirmation. Plays back via INSERT … ON DUPLICATE KEY UPDATE
   (for UPDATE/DELETE) or DELETE BETWEEN/IN (for INSERT-hint).
```

**Always run the dry-run first.** Look at the warnings: schema may have changed since backup; FK constraints may break the restore order.

### Touch ID for high-value DBs

For your most sensitive connection (prod, customer PII), require user-presence per session:

```text
"Set policy on acme-prod: requireTouchID=true."
```

First operation in a 15-minute idle window pops the macOS Touch ID dialog. Subsequent calls within the window skip the prompt. Trade-off: 200-500 ms latency per session unlock; vs. shoulder-surfed laptop entropy.

For *very* high-value DBs, also reduce `stmtTimeoutMs` to 5000ms and `rowCap` to 100 — caps any accidental large query.

### Multi-DB safety

Cross-DB statements are tricky:

```sql
INSERT INTO db1.audit SELECT * FROM db2.users;
```

This statement touches `db1` (write) and `db2` (read). If `db2` has `read=deny` for any reason, the whole statement is denied — **fail closed**. The audit log records `contributing_database: db2` so you know which constraint fired.

The merge rule (Apache Ranger semantics): for each category in the statement, take the strictest action across all touched DBs. `deny > confirm > allow`.

### Incident response — Claude did something unexpected

```text
1. "Show audit log entries for the last 30 minutes."
   → audit_search({sinceIso: '...'})
   Find the offending request_id.

2. "Show backup #N."
   → list_backups + the row's backup_id.

3. "Restore backup #N, dry run."
   → restore_backup({backupId: N, dryRun: true})
   Verify the plan matches what you want to undo.

4. "Restore backup #N."
   → executes; type CONFIRM.

5. (After resolution) "Tighten policy on <connection> to read-only."
   → set_policy. Prevent recurrence.
```

Every step is one tool call. The audit log is append-only — even if the SQLite file is moved, the rows stay (no UPDATE/DELETE on it from the MCP itself).

### When NOT to use this MCP

- **You need Multi-statement scripts.** Out of scope. The MCP rejects them at parse time *and* at the driver level. Use a migration tool.
- **High-write-throughput automation.** `SELECT … FOR UPDATE` for backup acquires row locks; not a good fit for >1000 mutations/min.
- **Production deploys.** Use a real migration framework (Liquibase, Flyway, Atlas). This MCP is for ad-hoc + investigative use.
- **Other tools modifying the same rows.** The MCP holds row locks during backup; concurrent writers may serialize.

### Recommended starting policy for a real workplace setup

| Connection | Baseline | Per-DB overrides |
|---|---|---|
| `prod-readonly` | read-only | none |
| `prod-admin` | read-only, `requireTouchID=true` | only on a single migration DB: `write=confirm`, `ddl=confirm` |
| `staging` | dev | `confirm` for writes, `confirm` for DDL |
| `local-dev` | dev | none — full freedom on local Docker |

Set this up once via `set_policy` + `set_database_policy`. Saved in `~/.config/sequel-mcp/config.json`. Persists across CC sessions.

### Daily-use sanity check

Before considering this MCP routine for production, run this drill once on a non-critical DB:

```text
1. doctor                                    → confirm config sane
2. set baseline read-only                    → safer default
3. override one staging DB to write=confirm  → scoped relaxation
4. INSERT a test row → CONFIRM works         → proves policy gate
5. list_backups → see the insert-hint backup → proves backup capture
6. restore_backup id=N --dry-run             → verify plan
7. restore_backup id=N                       → CONFIRM, watch row deleted
8. audit_search → see all four entries      → proves audit linkage
```

If steps 4-8 work end-to-end, you've stress-tested the safety net live. After that, daily use is sane.

---

## Two-layer permissions

Every connection has a **baseline policy** that cascades to all databases; per-database overrides take precedence. When a single SQL statement touches multiple databases, **the strictest action wins**.

```text
"Set baseline on acme-prod to read-only."
"Override staging policy: write=confirm."
"List database policies on acme-prod."
   → baseline: read-only
     overrides: staging → write=confirm
```

Strictness order: `deny > confirm > allow`.

| db1 policy | db2 policy | resolved |
|---|---|---|
| allow | confirm | confirm |
| allow | deny | deny |
| confirm | confirm | confirm |

Resolved decision recorded in audit log along with the contributing database.

## Audit log + pre-mutation backup

Every tool call writes one row to `~/.local/share/sequel-mcp/audit.sqlite`:

| Field | Notes |
|---|---|
| `ts`, `request_id`, `connection`, `databases`, `category`, `ast_type` | Identity |
| `sql_raw`, `sql_redacted` | Full + AST-redacted (literals → placeholders) |
| `decision`, `confirmed`, `outcome` | Policy + outcome |
| `affected_rows`, `duration_ms`, `error_msg` | Observability |
| `backup_id` | FK to backup row when applicable |
| `prev_hash`, `row_hash` | Optional SHA-256 chain |

Backups for these statement types:

| Statement | Backup |
|---|---|
| UPDATE | `SELECT * FROM <table> WHERE <where> FOR UPDATE` |
| DELETE | Same |
| Multi-table UPDATE/DELETE | One backup per mutated table |
| REPLACE | `SELECT * FROM <table> WHERE id IN (<keys>) FOR UPDATE` |
| INSERT | Post-mutation hint: `{kind:'range', start, end}` (auto-inc) or `{kind:'explicit', values}` |
| TRUNCATE | `SELECT *` (capped) + `SHOW CREATE TABLE` |
| DROP TABLE | Same combined |
| ALTER / RENAME | `SHOW CREATE TABLE` (schema-only) |

Caps: `maxBackupRows=10000`, `maxBackupBytes=50MB` per backup. Default behavior on overflow: **abort** the mutation (configurable).

Restore:

```text
"List backups for acme-prod."
"Show restore plan for backup 42, dry run."
"Restore backup 42."   → CONFIRM, executes
```

## Retention / cleanup

Defaults:

| Setting | Default |
|---|---|
| `retentionDaysByCategory.read` | 7 |
| `retentionDaysByCategory.write` | 30 |
| `retentionDaysByCategory.ddl` | 90 |
| `retentionDaysByCategory.admin` | 180 |
| `retentionDaysByCategory.txCtrl` | 7 |
| `backupDays` | 30 |
| `auditMaxMB` | 500 (hard cap) |
| `backupMaxMB` | 1000 (hard cap) |
| `autoCleanupHours` | 24 (lazy on boot) |
| `redactSqlInLog` | false |
| `tamperEvidentChain` | false |

```text
"Set retention: keep reads 3 days, writes 14 days."
   → set_retention({retentionDaysByCategory: {read: 3, write: 14}})

"Audit cleanup, dry run."
   → audit_cleanup({dryRun: true})
```

Auto-cleanup runs on server boot if last cleanup > `autoCleanupHours` ago.

Legacy `auditDays` from v0.2 is auto-migrated to uniform per-category on first read.

## Sequel Ace integrations (all optional)

If Sequel Ace is **not installed**, three things are unavailable; everything else works unchanged:

| Tool | If Sequel Ace missing |
|---|---|
| `import_from_sequel_ace` | "Favorites.plist not found" — use `add_connection` instead |
| `sequel_ace_history` | "queryHistory.db not found" — use `audit_search` instead |
| `history_search({source:'both'})` | Degrades silently to `source:'mcp'` (audit log only) |

If Sequel Ace IS installed, you get:

- **One-time bootstrap.** `import_from_sequel_ace` reads the Favorites.plist + macOS Keychain entries, copies them into our namespace. macOS prompts "Always Allow" once per favorite.
- **Cross-tool history search.** `history_search` merges Sequel Ace's `queryHistory.db` (deduplicated by query text) with our audit log into one timeline.

```text
"Show me my Sequel Ace history from the last 7 days containing 'users'."
   → sequel_ace_history({sinceIso, search: 'users'})
```

**Sequel Ace is never written to.** All our reads are read-only. `queryHistory.db` is opened with `readonly: true; fileMustExist: true`.

## Default connection / database

Set once, omit on every subsequent call:

```text
"Set the default connection to local."
"Set local's default database to app."
"Count rows in users."   → query({sql: 'SELECT COUNT(*) FROM users'}) — uses local/app
"On prod, count rows in audit."   → explicit override; default untouched
```

## Defence in depth

1. **AST classification** via `node-sql-parser` — closed-world: unknown statement types are denied.
2. **Multi-statement input rejected** at parse time AND at driver (`multipleStatements: false`).
3. **Server-side `START TRANSACTION READ ONLY`** for read category — MySQL itself rejects writes (error 1792).
4. **Two-layer policy gate** — per-DB override + baseline cascade; strictest wins; fail-closed.
5. **Elicitation confirmation** — typed `CONFIRM` token, server-issued, uncircumventable.
6. **Pre-mutation backup** — same-tx `SELECT … FOR UPDATE` for UPDATE/DELETE; SHOW CREATE TABLE for DDL; row + byte caps.
7. **Audit log** — append-only SQLite; optional SHA-256 chain.
8. **Row cap + statement timeout** — `MAX_EXECUTION_TIME` hint per category.
9. **Touch ID** — optional per-session unlock via macOS LocalAuthentication.

## Credentials — local-only by design

- Stored via `@napi-rs/keyring` → macOS Keychain Services API.
- Default attributes: **non-syncable**, `WhenUnlockedThisDeviceOnly`. Not iCloud Keychain.
- Service name: `sequel-mcp : <connection-name>`. Account: DB user. Visible in `Keychain Access.app` so you can revoke any time.
- We **never** read Sequel Ace's keychain at runtime. The one-time `import_from_sequel_ace` shells out to `/usr/bin/security` — macOS prompts "Always Allow / Allow / Deny" — and we copy the result into our own service namespace.

## SSH tunnels

If a connection has SSH details (auto-imported from Sequel Ace, or set via `add_connection`), `executeStatement` opens an `ssh2` local-to-remote tunnel before connecting `mysql2`. SSH passwords/passphrases live in Keychain under `<conn-name>::ssh`.

Tilde paths (`~/.ssh/id_rsa`) auto-expanded.

## Migrating from sequel-ace-mcp

If you previously installed `sequel-ace-mcp@0.1.0`:

```bash
npx -y sequel-mcp-migrate          # if installed via npm
# from a source checkout:
# node dist/migrate.js
```

Copies `~/.config/sequel-ace-mcp/config.json` → `~/.config/sequel-mcp/config.json` and re-keys macOS Keychain entries from service `sequel-ace-mcp : <name>` to `sequel-mcp : <name>`. Non-destructive by default — old entries stay until you pass `--purge`. `--force` to overwrite an existing new-name config; `--json` for machine-readable.

After migration, re-wire your MCP client:

```bash
claude mcp remove sequel-ace
claude mcp add --scope user sequel-mcp -- npx -y sequel-mcp
```

## Doctor / debugging

```bash
npm run doctor                     # text report
node dist/doctor.js --json         # machine-readable
sequel-mcp-doctor                  # if installed globally
```

Or as an MCP tool:

```text
"Run sequel-mcp doctor and show the report."
```

The report includes runtime versions, every configured connection (host, user, database, SSH key path), policy, `hasStoredPassword` boolean, retention config, Sequel Ace history availability. **No passwords or Keychain secrets.** Hostnames + DB usernames + key paths ARE included — review before pasting publicly.

## Development

```bash
npm install
npm run typecheck
npm run lint
npm test                                  # 87 tests as of v0.4.0
npm run build
npm run build:touchid                     # macOS only — Swift LocalAuthentication helper
npm run security:scan                     # local secret regex scan
./scripts/install-pre-commit-hook.sh      # optional — secret scan on every commit
```

## Security policy

See [SECURITY.md](./SECURITY.md) for the threat model and [CONTRIBUTING.md](./CONTRIBUTING.md) for contributor rules around credentials and PII.

Quick summary: **no credential, no PII, no environment-specific identifier may ever enter this repository.** Test fixtures use the IETF-reserved `example.com` domain. A regex scanner (`scripts/check-secrets.sh`) runs locally and as an optional pre-commit hook. CI re-runs `gitleaks` on every push.

## Threat model (what's NOT protected)

See [SECURITY.md](./SECURITY.md) for the full list. Highlights:

- A logged-in attacker on your Mac with shell access can read process memory and grab the cached password during the 15-min idle window. Use `requireTouchID: true` to shorten the trust window.
- The MCP runs in your user context with no extra sandboxing. Keep your `mcpServers` list to vetted servers.
- We do not pin TLS certs. If `ssl: true` and your DB is on the open internet, configure your DB to require valid certs server-side.
- Restoring a backup taken before a schema migration may fail or coerce silently. Always run `restore_backup --dry-run` first.
- Foreign-key-heavy DELETE rollback is not topology-aware — restored INSERTs may violate FKs if dependent rows were also deleted.

## License

MIT — see [LICENSE](./LICENSE).
