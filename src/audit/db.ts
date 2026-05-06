import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { auditDbPath, dataDir } from '../vault/paths.js';

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS audit_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ts            TEXT    NOT NULL,
  request_id    TEXT    NOT NULL,
  connection    TEXT    NOT NULL,
  databases     TEXT    NOT NULL,
  category      TEXT    NOT NULL,
  ast_type      TEXT,
  sql_raw       TEXT    NOT NULL,
  sql_redacted  TEXT    NOT NULL,
  decision      TEXT    NOT NULL,
  confirmed     INTEGER NOT NULL DEFAULT 0,
  outcome       TEXT    NOT NULL,
  affected_rows INTEGER,
  duration_ms   INTEGER,
  error_msg     TEXT,
  backup_id     INTEGER REFERENCES backup(id) ON DELETE SET NULL,
  prev_hash     BLOB,
  row_hash      BLOB
);

CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(ts);
CREATE INDEX IF NOT EXISTS idx_audit_connection ON audit_log(connection, ts);
CREATE INDEX IF NOT EXISTS idx_audit_outcome ON audit_log(outcome, ts);

CREATE TABLE IF NOT EXISTS backup (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ts            TEXT    NOT NULL,
  connection    TEXT    NOT NULL,
  database      TEXT,
  table_name    TEXT    NOT NULL,
  backup_kind   TEXT    NOT NULL,
  rows_json     TEXT,
  schema_sql    TEXT,
  primary_key   TEXT,
  row_count     INTEGER NOT NULL DEFAULT 0,
  truncated     INTEGER NOT NULL DEFAULT 0,
  size_bytes    INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_backup_ts ON backup(ts);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);
`;

const PRAGMAS = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA temp_store = MEMORY;
PRAGMA mmap_size = 268435456;
PRAGMA cache_size = -20000;
PRAGMA wal_autocheckpoint = 1000;
PRAGMA journal_size_limit = 67108864;
PRAGMA busy_timeout = 5000;
PRAGMA foreign_keys = ON;
`;

export type AuditDb = Database.Database;

let cached: AuditDb | null = null;

export interface OpenAuditDbOptions {
  pathOverride?: string;
}

export function openAuditDb(opts: OpenAuditDbOptions = {}): AuditDb {
  if (cached && !opts.pathOverride) return cached;
  const file = opts.pathOverride ?? auditDbPath();
  if (!opts.pathOverride) {
    fs.mkdirSync(dataDir(), { recursive: true, mode: 0o700 });
  } else {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }
  const db = new Database(file);
  db.exec(PRAGMAS);
  db.exec(SCHEMA_SQL);
  if (!opts.pathOverride) cached = db;
  return db;
}

export function closeAuditDb(): void {
  if (cached) {
    try {
      cached.pragma('wal_checkpoint(TRUNCATE)');
      cached.close();
    } catch {
      /* ignore */
    }
    cached = null;
  }
}
