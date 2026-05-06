import type mysql from 'mysql2/promise';
import { getBackup } from './capture.js';

function quoteId(id: string): string {
  return '`' + id.replace(/`/g, '``') + '`';
}

function tableRefSql(db: string | null, table: string): string {
  return db ? `${quoteId(db)}.${quoteId(table)}` : quoteId(table);
}

function escapeValue(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number' || typeof v === 'bigint') return String(v);
  if (typeof v === 'boolean') return v ? '1' : '0';
  if (v instanceof Date) return `'${v.toISOString().slice(0, 19).replace('T', ' ')}'`;
  if (Buffer.isBuffer(v)) return `0x${v.toString('hex')}`;
  if (typeof v === 'object') return `'${JSON.stringify(v).replace(/'/g, "''").replace(/\\/g, '\\\\')}'`;
  return `'${String(v).replace(/'/g, "''").replace(/\\/g, '\\\\')}'`;
}

export interface RestorePlan {
  backupId: number;
  statements: string[];
  rowCount: number;
  warnings: string[];
}

export function planRestore(backupId: number, opts?: { pathOverride?: string }): RestorePlan {
  const backup = getBackup(backupId, opts);
  if (!backup) throw new Error(`backup #${backupId} not found`);

  const statements: string[] = [];
  const warnings: string[] = [];

  if (backup.truncated) {
    warnings.push('backup was truncated; restore will not be complete');
  }

  if (backup.backup_kind === 'schema' && backup.schema_sql) {
    warnings.push('schema-only backup; running this will fail unless the table was dropped first');
    statements.push(backup.schema_sql + ';');
    return { backupId, statements, rowCount: 0, warnings };
  }

  if (backup.backup_kind === 'combined') {
    if (backup.schema_sql) statements.push(backup.schema_sql + ';');
  }

  if (backup.rows && Array.isArray(backup.rows) && backup.rows.length > 0) {
    const tref = tableRefSql(backup.database, backup.table_name);
    const sample = backup.rows[0] as Record<string, unknown>;
    const cols = Object.keys(sample);
    const colList = cols.map(quoteId).join(', ');
    const updateClause = cols.map((c) => `${quoteId(c)} = VALUES(${quoteId(c)})`).join(', ');

    for (const row of backup.rows as Record<string, unknown>[]) {
      const values = cols.map((c) => escapeValue(row[c])).join(', ');
      statements.push(
        `INSERT INTO ${tref} (${colList}) VALUES (${values}) ON DUPLICATE KEY UPDATE ${updateClause};`,
      );
    }
  }

  return { backupId, statements, rowCount: backup.row_count, warnings };
}

export async function executeRestore(args: {
  conn: mysql.Connection;
  plan: RestorePlan;
}): Promise<{ statementsRun: number; affected: number }> {
  let affected = 0;
  for (const stmt of args.plan.statements) {
    const [r] = await args.conn.query(stmt);
    if (r && typeof r === 'object' && 'affectedRows' in r) {
      affected += Number((r as { affectedRows: number }).affectedRows ?? 0);
    }
  }
  return { statementsRun: args.plan.statements.length, affected };
}
