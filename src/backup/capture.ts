import type mysql from 'mysql2/promise';
import { openAuditDb } from '../audit/db.js';
import type { BackupSpec } from './extractor.js';
import type { Policy } from '../types.js';

export interface CapturedBackup {
  backupId: number;
  totalRows: number;
  truncated: boolean;
  totalBytes: number;
  perTable: { db: string | null; table: string; rowCount: number; truncated: boolean }[];
}

export class BackupOverflowError extends Error {
  constructor(public readonly limit: { kind: 'rows' | 'bytes'; cap: number }, public readonly observed: number) {
    super(`backup ${limit.kind} cap exceeded (${observed} > ${limit.cap})`);
    this.name = 'BackupOverflowError';
  }
}

async function showCreateTable(conn: mysql.Connection, db: string | null, table: string): Promise<string | null> {
  const target = db ? `\`${db}\`.\`${table}\`` : `\`${table}\``;
  try {
    const [rowsRaw] = await conn.query(`SHOW CREATE TABLE ${target}`);
    const r = Array.isArray(rowsRaw) && rowsRaw.length > 0 ? (rowsRaw[0] as Record<string, unknown>) : null;
    if (!r) return null;
    const create = r['Create Table'] ?? r['Create View'];
    return typeof create === 'string' ? create : null;
  } catch {
    return null;
  }
}

async function fetchRows(args: {
  conn: mysql.Connection;
  selectSql: string;
  rowCap: number;
  byteCap: number;
}): Promise<{ rows: unknown[]; totalBytes: number; truncated: boolean }> {
  const cappedSql = `${args.selectSql} LIMIT ${Math.max(args.rowCap + 1, 1)}`;
  const [rowsRaw] = await args.conn.query(cappedSql);
  if (!Array.isArray(rowsRaw)) return { rows: [], totalBytes: 0, truncated: false };
  const truncatedRows = rowsRaw.length > args.rowCap;
  const usable = truncatedRows ? rowsRaw.slice(0, args.rowCap) : rowsRaw;
  const json = JSON.stringify(usable);
  const bytes = Buffer.byteLength(json, 'utf8');
  return {
    rows: usable as unknown[],
    totalBytes: bytes,
    truncated: truncatedRows,
  };
}

export async function captureBackup(args: {
  conn: mysql.Connection;
  spec: BackupSpec;
  connectionName: string;
  database: string | undefined;
  policy: Policy;
  pathOverride?: string;
}): Promise<CapturedBackup | null> {
  if (args.spec.kind === 'none') return null;

  const db = openAuditDb({ pathOverride: args.pathOverride });
  const ts = new Date().toISOString();
  const stmt = db.prepare(
    `INSERT INTO backup
       (ts, connection, database, table_name, backup_kind, rows_json, schema_sql, primary_key, row_count, truncated, size_bytes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const rowCap = args.policy.maxBackupRows;
  const byteCap = args.policy.maxBackupBytes;
  const onOverflow = args.policy.onBackupOverflow;
  const perTable: CapturedBackup['perTable'] = [];
  let totalRows = 0;
  let totalBytes = 0;
  let truncatedAny = false;
  let firstId: number | null = null;

  const tables =
    args.spec.kind === 'rows' || args.spec.kind === 'combined'
      ? args.spec.tables
      : args.spec.tables;

  for (const t of tables) {
    let rowsJson: string | null = null;
    let schemaSql: string | null = null;
    let rowCount = 0;
    let truncated = false;
    let bytes = 0;

    if (args.spec.kind === 'schema' || args.spec.kind === 'combined') {
      schemaSql = await showCreateTable(args.conn, t.db, t.table);
    }
    if (args.spec.kind === 'rows' || args.spec.kind === 'combined') {
      const tt = t as { db: string | null; table: string; selectSql: string; locking: 'FOR UPDATE' | 'NONE' };
      const fetch = await fetchRows({
        conn: args.conn,
        selectSql: tt.selectSql,
        rowCap,
        byteCap,
      });
      if (fetch.truncated && onOverflow === 'abort') {
        throw new BackupOverflowError({ kind: 'rows', cap: rowCap }, rowCap + 1);
      }
      if (fetch.totalBytes > byteCap && onOverflow === 'abort') {
        throw new BackupOverflowError({ kind: 'bytes', cap: byteCap }, fetch.totalBytes);
      }
      rowsJson = JSON.stringify(fetch.rows);
      rowCount = fetch.rows.length;
      truncated = fetch.truncated;
      bytes = fetch.totalBytes;
    }

    const ins = stmt.run(
      ts,
      args.connectionName,
      args.database ?? t.db ?? null,
      t.table,
      args.spec.kind,
      rowsJson,
      schemaSql,
      null,
      rowCount,
      truncated ? 1 : 0,
      bytes,
    );

    if (firstId === null) firstId = Number(ins.lastInsertRowid);
    perTable.push({ db: t.db, table: t.table, rowCount, truncated });
    totalRows += rowCount;
    totalBytes += bytes;
    truncatedAny = truncatedAny || truncated;
  }

  if (firstId === null) return null;
  return { backupId: firstId, totalRows, totalBytes, truncated: truncatedAny, perTable };
}

export interface BackupRow {
  id: number;
  ts: string;
  connection: string;
  database: string | null;
  table_name: string;
  backup_kind: string;
  row_count: number;
  truncated: boolean;
  size_bytes: number;
}

export function listBackups(filters: { connection?: string; limit?: number }, opts?: { pathOverride?: string }): BackupRow[] {
  const db = openAuditDb({ pathOverride: opts?.pathOverride });
  const conds: string[] = [];
  const params: (string | number)[] = [];
  if (filters.connection) {
    conds.push('connection = ?');
    params.push(filters.connection);
  }
  const where = conds.length > 0 ? `WHERE ${conds.join(' AND ')}` : '';
  const limit = Math.min(filters.limit ?? 50, 1000);
  const rows = db
    .prepare(
      `SELECT id, ts, connection, database, table_name, backup_kind, row_count, truncated, size_bytes
       FROM backup ${where} ORDER BY id DESC LIMIT ?`,
    )
    .all(...params, limit) as Record<string, unknown>[];
  return rows.map((r) => ({
    id: Number(r.id),
    ts: String(r.ts),
    connection: String(r.connection),
    database: r.database == null ? null : String(r.database),
    table_name: String(r.table_name),
    backup_kind: String(r.backup_kind),
    row_count: Number(r.row_count),
    truncated: Boolean(r.truncated),
    size_bytes: Number(r.size_bytes),
  }));
}

export interface BackupDetail extends BackupRow {
  rows: unknown[] | null;
  schema_sql: string | null;
}

export function getBackup(id: number, opts?: { pathOverride?: string }): BackupDetail | null {
  const db = openAuditDb({ pathOverride: opts?.pathOverride });
  const r = db
    .prepare(
      `SELECT id, ts, connection, database, table_name, backup_kind, rows_json, schema_sql, row_count, truncated, size_bytes
       FROM backup WHERE id = ?`,
    )
    .get(id) as Record<string, unknown> | undefined;
  if (!r) return null;
  return {
    id: Number(r.id),
    ts: String(r.ts),
    connection: String(r.connection),
    database: r.database == null ? null : String(r.database),
    table_name: String(r.table_name),
    backup_kind: String(r.backup_kind),
    row_count: Number(r.row_count),
    truncated: Boolean(r.truncated),
    size_bytes: Number(r.size_bytes),
    rows: r.rows_json == null ? null : (JSON.parse(String(r.rows_json)) as unknown[]),
    schema_sql: r.schema_sql == null ? null : String(r.schema_sql),
  };
}
