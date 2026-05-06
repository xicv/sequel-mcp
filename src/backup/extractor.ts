import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Parser } = require('node-sql-parser') as typeof import('node-sql-parser');

const parser = new Parser();

export type BackupSpec =
  | { kind: 'none'; reason?: string }
  | {
      kind: 'rows';
      tables: { db: string | null; table: string; selectSql: string; locking: 'FOR UPDATE' | 'NONE' }[];
    }
  | { kind: 'schema'; tables: { db: string | null; table: string }[] }
  | {
      kind: 'combined';
      tables: { db: string | null; table: string; selectSql: string; locking: 'FOR UPDATE' | 'NONE' }[];
    };

interface UpdateLikeAst {
  type: string;
  table?: TableRef[];
  from?: TableRef[];
  name?: TableRef[];
  where?: unknown;
  with?: unknown;
}

interface TableRef {
  db?: string | null;
  table?: string;
  as?: string | null;
}

function quoteId(id: string): string {
  return '`' + id.replace(/`/g, '``') + '`';
}

function tableRefSql(db: string | null | undefined, table: string): string {
  return db ? `${quoteId(db)}.${quoteId(table)}` : quoteId(table);
}

function buildSelect(args: {
  fromTables: TableRef[];
  where: unknown;
  forUpdate: boolean;
}): string | null {
  if (args.fromTables.length !== 1) return null;
  const t = args.fromTables[0];
  if (!t?.table) return null;
  const fromSql = tableRefSql(t.db ?? null, t.table);

  if (args.where) {
    try {
      const tmpAst = {
        type: 'select',
        with: null,
        options: null,
        distinct: null,
        columns: [{ expr: { type: 'column_ref', table: null, column: '*' }, as: null }],
        from: args.fromTables,
        where: args.where,
        groupby: null,
        having: null,
        orderby: null,
        limit: null,
      };
      const sql = parser.sqlify(tmpAst as unknown as Parameters<typeof parser.sqlify>[0], { database: 'mysql' });
      if (typeof sql !== 'string') return null;
      return args.forUpdate ? `${sql} FOR UPDATE` : sql;
    } catch {
      return null;
    }
  }

  const baseSelect = `SELECT * FROM ${fromSql}`;
  return args.forUpdate ? `${baseSelect} FOR UPDATE` : baseSelect;
}

export function extractBackupSpec(sql: string, astType: string): BackupSpec {
  let ast: UpdateLikeAst | null = null;
  try {
    const parsed = parser.astify(sql, { database: 'mysql' });
    ast = (Array.isArray(parsed) ? parsed[0] : parsed) as UpdateLikeAst | null;
  } catch (e) {
    return { kind: 'none', reason: `parse error: ${(e as Error).message}` };
  }
  if (!ast) return { kind: 'none', reason: 'no AST' };

  const t = astType.toLowerCase();

  if (t === 'update') {
    const tables = ast.table ?? [];
    if (tables.length === 0) return { kind: 'none', reason: 'UPDATE has no target table' };
    if (tables.length > 1) {
      return { kind: 'none', reason: 'multi-table UPDATE backup not supported in v0.2; statement will be denied' };
    }
    const target = tables[0]!;
    if (!target.table) return { kind: 'none', reason: 'UPDATE missing table name' };
    const selectSql = buildSelect({ fromTables: [target], where: ast.where, forUpdate: true });
    if (!selectSql) return { kind: 'none', reason: 'failed to construct backup SELECT' };
    return {
      kind: 'rows',
      tables: [{ db: target.db ?? null, table: target.table, selectSql, locking: 'FOR UPDATE' }],
    };
  }

  if (t === 'delete') {
    const tables = ast.from ?? ast.table ?? [];
    if (tables.length === 0) return { kind: 'none', reason: 'DELETE has no source table' };
    if (tables.length > 1) {
      return { kind: 'none', reason: 'multi-table DELETE backup not supported in v0.2; statement will be denied' };
    }
    const target = tables[0]!;
    if (!target.table) return { kind: 'none', reason: 'DELETE missing table name' };
    const selectSql = buildSelect({ fromTables: [target], where: ast.where, forUpdate: true });
    if (!selectSql) return { kind: 'none', reason: 'failed to construct backup SELECT' };
    return {
      kind: 'rows',
      tables: [{ db: target.db ?? null, table: target.table, selectSql, locking: 'FOR UPDATE' }],
    };
  }

  if (t === 'replace') {
    const tables = ast.table ?? [];
    if (tables.length !== 1 || !tables[0]?.table) return { kind: 'none', reason: 'REPLACE target unclear' };
    return { kind: 'none', reason: 'REPLACE not auto-backed-up in v0.2; PK-level rollback not yet implemented' };
  }

  if (t === 'truncate') {
    const tables = ast.name ?? ast.table ?? ast.from ?? [];
    const t0 = tables[0];
    if (!t0?.table) return { kind: 'none', reason: 'TRUNCATE target unclear' };
    return {
      kind: 'combined',
      tables: [
        {
          db: t0.db ?? null,
          table: t0.table,
          selectSql: `SELECT * FROM ${tableRefSql(t0.db ?? null, t0.table)}`,
          locking: 'NONE',
        },
      ],
    };
  }

  if (t === 'drop') {
    const tables = ast.name ?? ast.table ?? ast.from ?? [];
    const t0 = tables[0];
    if (!t0?.table) return { kind: 'none', reason: 'DROP target unclear' };
    return {
      kind: 'combined',
      tables: [
        {
          db: t0.db ?? null,
          table: t0.table,
          selectSql: `SELECT * FROM ${tableRefSql(t0.db ?? null, t0.table)}`,
          locking: 'NONE',
        },
      ],
    };
  }

  if (t === 'alter' || t === 'rename') {
    const tables = ast.table ?? ast.from ?? ast.name ?? [];
    const refs = tables.filter((tr) => !!tr?.table);
    if (refs.length === 0) return { kind: 'none', reason: 'ALTER/RENAME target unclear' };
    return { kind: 'schema', tables: refs.map((r) => ({ db: r.db ?? null, table: r.table! })) };
  }

  return { kind: 'none', reason: `no backup strategy for AST type "${astType}"` };
}

export function isBackupRequired(astType: string): boolean {
  const t = astType.toLowerCase();
  return ['update', 'delete', 'truncate', 'drop', 'alter', 'rename'].includes(t);
}
