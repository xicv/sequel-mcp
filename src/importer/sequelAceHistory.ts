import fs from 'node:fs';
import Database from 'better-sqlite3';
import { sequelAceQueryHistoryDbPath } from '../vault/paths.js';

export interface SequelAceHistoryEntry {
  id: number;
  query: string;
  createdTime: number;
  createdAtIso: string;
}

export interface SequelAceHistoryFilters {
  sinceIso?: string;
  search?: string;
  limit?: number;
}

export interface SequelAceHistoryStat {
  exists: boolean;
  path: string;
  entryCount: number;
  sizeBytes: number;
}

function openReadOnly(filepath: string): Database.Database | null {
  try {
    return new Database(filepath, { readonly: true, fileMustExist: true });
  } catch {
    return null;
  }
}

export function statSequelAceHistory(opts?: { pathOverride?: string }): SequelAceHistoryStat {
  const filepath = opts?.pathOverride ?? sequelAceQueryHistoryDbPath();
  let exists = false;
  let sizeBytes = 0;
  try {
    const stat = fs.statSync(filepath);
    exists = stat.isFile();
    sizeBytes = stat.size;
  } catch {
    return { exists: false, path: filepath, entryCount: 0, sizeBytes: 0 };
  }
  if (!exists) return { exists, path: filepath, entryCount: 0, sizeBytes: 0 };

  const db = openReadOnly(filepath);
  if (!db) return { exists, path: filepath, entryCount: 0, sizeBytes };
  try {
    const r = db.prepare('SELECT COUNT(*) as c FROM QueryHistory').get() as { c: number };
    return { exists, path: filepath, entryCount: Number(r.c), sizeBytes };
  } catch {
    return { exists, path: filepath, entryCount: 0, sizeBytes };
  } finally {
    db.close();
  }
}

export function readSequelAceHistory(
  filters: SequelAceHistoryFilters,
  opts?: { pathOverride?: string },
): SequelAceHistoryEntry[] {
  const filepath = opts?.pathOverride ?? sequelAceQueryHistoryDbPath();
  const db = openReadOnly(filepath);
  if (!db) return [];

  try {
    const conds: string[] = [];
    const params: (string | number)[] = [];
    if (filters.sinceIso) {
      const t = Date.parse(filters.sinceIso);
      if (!Number.isNaN(t)) {
        conds.push('createdTime >= ?');
        params.push(t / 1000);
      }
    }
    if (filters.search) {
      conds.push('query LIKE ?');
      params.push(`%${filters.search}%`);
    }
    const where = conds.length > 0 ? `WHERE ${conds.join(' AND ')}` : '';
    const limit = Math.min(filters.limit ?? 200, 5000);

    const rows = db
      .prepare(
        `SELECT id, query, createdTime FROM QueryHistory ${where} ORDER BY createdTime DESC LIMIT ?`,
      )
      .all(...params, limit) as { id: number; query: string; createdTime: number }[];

    return rows.map((r) => ({
      id: Number(r.id),
      query: String(r.query),
      createdTime: Number(r.createdTime),
      createdAtIso: new Date(Number(r.createdTime) * 1000).toISOString(),
    }));
  } catch {
    return [];
  } finally {
    db.close();
  }
}
