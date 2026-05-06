# Changelog

All notable changes to **sequel-mcp** are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.0] — 2026-05-06

### Added

- **Multi-table UPDATE/DELETE backup.** `UPDATE a JOIN b ON … SET a.x = 1, b.y = 2 WHERE …` now produces one `backup` row per mutated table (detected from the `SET` clause). `DELETE a, b FROM a JOIN b …` produces one backup per deleted target. Each backup gets its own `backup_id`; `restore_backup` replays each independently.
- **REPLACE PK rollback.** `REPLACE INTO t (id, …) VALUES (…)` triggers a pre-mutation `SELECT * FROM t WHERE id IN (…) FOR UPDATE` against pre-existing rows. Restorable via `INSERT … ON DUPLICATE KEY UPDATE`. Identifies PK column by name (`id` / `uuid` / `pk`).
- **INSERT auto-rollback hint** (`backup_kind = 'insert-hint'`). Captured *after* execution; no pre-mutation cost. For auto-increment tables, stores `{kind: 'range', column: 'id', start, end}` from `mysql.insertId` + `affectedRows`. For explicit-PK INSERTs, stores `{kind: 'explicit', columns, values}`. Restore generates `DELETE FROM t WHERE id BETWEEN start AND end` or `DELETE FROM t WHERE (cols) IN ((…), …)`.
- **`history_search` tool.** Unified timeline merging the local audit log with Sequel Ace's `queryHistory.db` (when present). Sorted by `ts` DESC; each row carries `source: 'mcp' | 'sequel-ace'`. Filter via `source=mcp` / `source=sequel-ace` / `source=both` (default).

### Changed

- `isBackupRequired()` now returns `true` for `replace` and `insert` (was `false` in 0.2/0.3).
- README restructured around real-world workflows + a Security Playbook section.

### Tests

- Extractor: 27 (was 19) — multi-table UPDATE/DELETE, REPLACE, INSERT hint cases.
- History merge: 3 new tests.
- **Total: 87** (was 76).

## [0.3.0] — 2026-05-06

### Added

- **Per-category audit retention.** New `RetentionConfig.retentionDaysByCategory: { read, write, ddl, admin, txCtrl }`. Defaults: `read=7`, `write=30`, `ddl=90`, `admin=180`, `txCtrl=7`. Cleanup runs `DELETE … WHERE category = ?` per category with its own cutoff.
- **`sequel_ace_history` tool.** Reads Sequel Ace's `queryHistory.db` in `better-sqlite3` read-only mode. Filters: `sinceIso`, `search` (`LIKE %text%`), `limit` (default 200, max 5000). Read-only — no lock or modification of Sequel Ace's file.
- `doctor` tool now reports `sequelAceHistory: { available, path, entryCount, sizeBytes }` and the resolved `retention` block.

### Changed

- `set_retention` now accepts `retentionDaysByCategory` partial map (deep-merged over current).
- Legacy `auditDays: number` from 0.2 configs auto-migrated uniformly to all five categories on first read (via `z.preprocess`). Non-breaking.

### Tests

- Retention: 7 (was 5) — per-category cleanup + legacy migration.
- Sequel Ace history reader: 7 new tests.
- **Total: 76** (was 67).

## [0.2.0] — 2026-05-06

### Added

- **Two-layer permission system.** `Connection.databasePolicies?: Record<string, Partial<Policy>>` — per-database overrides cascade off the connection baseline. Multi-DB statements take the **strictest** action (`deny > confirm > allow`) — fail closed (Apache Ranger semantics).
  - New tools: `set_database_policy`, `clear_database_policy`, `list_database_policies`.
  - Classifier extracts `targetDatabases` from AST `tableList`.
- **Audit log** (`better-sqlite3` at `~/.local/share/sequel-mcp/audit.sqlite`). Every tool call writes one row: request UUID, target databases, category, AST type, raw + redacted SQL, decision, confirmed bool, outcome (`success`/`error`/`denied`/`declined`), `affected_rows`, `duration_ms`, `error_msg`, `backup_id`. Optional SHA-256 prev-hash chain (off by default).
  - AST-walk literal redaction stores `sql_redacted` with literals replaced by placeholders (`<str>`, `0`, `false`).
  - Raw SQL kept by default for local debugging; opt-in `redactSqlInLog` flag drops it.
  - New tools: `audit_search`, `audit_cleanup`.
- **Pre-mutation backup.** Every UPDATE/DELETE runs `SELECT … FOR UPDATE` for row backup; TRUNCATE/DROP/ALTER/RENAME run `SHOW CREATE TABLE`; combined kinds for TRUNCATE/DROP capture both.
  - Caps: `maxBackupRows=10000`, `maxBackupBytes=50MB`. Default abort on overflow (configurable per connection via `Policy.onBackupOverflow`).
  - New tools: `list_backups`, `restore_backup` (default `dryRun=true`; goes through the same policy gate; `INSERT … ON DUPLICATE KEY UPDATE`).
  - **Multi-table UPDATE/DELETE** explicitly rejected for 0.2 (will cause statement to be denied with a clear reason). Landed in 0.4.
- **Retention / cleanup.** `RetentionConfig`: `auditDays=90`, `backupDays=30`, `auditMaxMB=500`, `backupMaxMB=1000`, `autoCleanupHours=24`. `maybeAutoCleanup` runs lazily on server boot if last cleanup > N hours.
  - New tools: `set_retention`. `audit_cleanup` doubles as manual purge.
  - VACUUM after each cleanup; soft cap triggers extra 20% trim.
- New deps: `better-sqlite3@^12`, `drizzle-orm`/`drizzle-kit`, `uuid`.

### Changed

- Stderr breadcrumb log gains backup-capture progress: `[sequel-mcp] acme-prod/write capturing backup … backup #42: 47 rows, 8200B`.

### Tests

- Resolver: 6 new tests.
- Audit logger: 3 new tests.
- Extractor: 19 new tests.
- Retention: 5 new tests.
- **Total: 67** (was 34).

### Known limitations (later addressed in 0.4)

- Multi-table UPDATE/DELETE not yet supported.
- REPLACE not auto-backed up (PK-level rollback not yet implemented).
- INSERT auto-rollback hint not yet implemented.

## [0.1.1] — 2026-05-06

### Changed (BREAKING)

- **Renamed package: `sequel-ace-mcp` → `sequel-mcp`.** The project is a fully standalone MySQL/MariaDB MCP — Sequel Ace integration is a one-time importer, not core. The old name was misleading. The old npm package is deprecated and points to the new name; the GitHub repo at `xicv/sequel-ace-mcp` redirects to `xicv/sequel-mcp`.
  - App name → `sequel-mcp`
  - Keychain service prefix → `sequel-mcp : <name>`
  - Resource URI → `sequel-mcp://connections`
  - Stderr breadcrumb prefix → `[sequel-mcp]`
  - Bin entries → `sequel-mcp`, `sequel-mcp-doctor`, `sequel-mcp-migrate`
- **`sequel-mcp-migrate` tool.** Copies `~/.config/sequel-ace-mcp/config.json` → `~/.config/sequel-mcp/config.json` and re-keys macOS Keychain entries from service `sequel-ace-mcp : <name>` to `sequel-mcp : <name>`. Non-destructive by default; `--purge` to remove legacy; `--force` to overwrite; `--json` for machine output.

### Added

- **Default connection state.** New tools: `set_default_connection`, `get_default_connection`. Tools that took a `connection` arg now treat it as optional; if omitted, the resolver falls back to the configured default.
- **`select_database` tool.** Set a connection's default database without re-entering the password.
- README + Migration section.

## [0.1.0] — 2026-05-06

### Initial release

MCP server that lets Claude run MySQL/MariaDB queries via Sequel Ace's saved connections, with policy-gated read/write/DDL action sets and macOS Keychain credential storage.

#### Highlights

- **AST-based SQL classification** via `node-sql-parser` + admin-keyword regex fallback. Closed-world: unknown statement types are denied.
- **Per-connection policy** (`allow | confirm | deny`) per category: `read`, `write`, `ddl`, `admin`, `txCtrl`.
- **Elicitation-driven CONFIRM token** for gated statements — server-issued, uncircumventable.
- **Multi-statement input rejected** at parse time + driver-level (`multipleStatements: false`).
- **Server-side `START TRANSACTION READ ONLY`** for read-category statements.
- **Sequel Ace bootstrap importer** for `Favorites.plist` + legacy keychain entries.
- **macOS Keychain** via `@napi-rs/keyring`. Non-syncable, `WhenUnlockedThisDeviceOnly`.
- **Optional Touch ID** gate via Swift `LocalAuthentication` helper.
- **SSH tunnel support** via `ssh2` with tilde-expanded key paths.
- **`doctor` tool + CLI** for sanitized diagnostics.
- **13 tools / 2 prompts / 1 resource / 34 unit tests.**

#### Hardened repository

- `.gitignore` covers `node_modules`, `dist`, `fixtures`, all `.env` / key / secret patterns
- `.npmignore` strips source / tests / scripts from the published package
- LICENSE (MIT)
- SECURITY.md with full threat model
- CONTRIBUTING.md with credentials-and-PII rules
- `scripts/check-secrets.sh` local regex scanner + optional pre-commit hook

[0.4.0]: https://github.com/xicv/sequel-mcp/releases/tag/v0.4.0
[0.3.0]: https://github.com/xicv/sequel-mcp/releases/tag/v0.3.0
[0.2.0]: https://github.com/xicv/sequel-mcp/releases/tag/v0.2.0
[0.1.1]: https://github.com/xicv/sequel-mcp/releases/tag/v0.1.1
[0.1.0]: https://github.com/xicv/sequel-mcp/releases/tag/v0.1.0
