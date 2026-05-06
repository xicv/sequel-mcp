import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readSequelAceHistory, statSequelAceHistory } from '../src/importer/sequelAceHistory.js';

let dbFile: string;

beforeEach(() => {
  dbFile = path.join(os.tmpdir(), `sequel-ace-history-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const db = new Database(dbFile);
  db.exec(`
    CREATE TABLE QueryHistory (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      query TEXT NOT NULL,
      createdTime REAL NOT NULL
    );
    CREATE UNIQUE INDEX query_idx ON QueryHistory (query);
  `);
  const insert = db.prepare('INSERT INTO QueryHistory (query, createdTime) VALUES (?, ?)');
  const now = Date.now() / 1000;
  insert.run('SELECT 1', now - 60);
  insert.run('SELECT * FROM users WHERE id = 1', now - 3600);
  insert.run('UPDATE users SET name = ?', now - 86400 * 5);
  insert.run('DROP TABLE old_logs', now - 86400 * 30);
  db.close();
});

afterEach(() => {
  for (const ext of ['', '-wal', '-shm']) {
    try {
      fs.unlinkSync(dbFile + ext);
    } catch {
      /* ignore */
    }
  }
});

describe('readSequelAceHistory', () => {
  it('returns all entries by default ordered by createdTime DESC', () => {
    const rows = readSequelAceHistory({}, { pathOverride: dbFile });
    expect(rows).toHaveLength(4);
    expect(rows[0]?.query).toBe('SELECT 1');
    expect(rows[3]?.query).toBe('DROP TABLE old_logs');
  });

  it('filter by since', () => {
    const since = new Date(Date.now() - 7 * 86400 * 1000).toISOString();
    const rows = readSequelAceHistory({ sinceIso: since }, { pathOverride: dbFile });
    expect(rows.length).toBe(3);
  });

  it('filter by search', () => {
    const rows = readSequelAceHistory({ search: 'users' }, { pathOverride: dbFile });
    expect(rows.length).toBe(2);
  });

  it('limit caps result count', () => {
    const rows = readSequelAceHistory({ limit: 2 }, { pathOverride: dbFile });
    expect(rows).toHaveLength(2);
  });

  it('returns empty array when file missing', () => {
    const rows = readSequelAceHistory({}, { pathOverride: '/does/not/exist.db' });
    expect(rows).toEqual([]);
  });
});

describe('statSequelAceHistory', () => {
  it('reports entry count + size when file exists', () => {
    const s = statSequelAceHistory({ pathOverride: dbFile });
    expect(s.exists).toBe(true);
    expect(s.entryCount).toBe(4);
    expect(s.sizeBytes).toBeGreaterThan(0);
  });

  it('reports exists=false when missing', () => {
    const s = statSequelAceHistory({ pathOverride: '/does/not/exist.db' });
    expect(s.exists).toBe(false);
    expect(s.entryCount).toBe(0);
  });
});
