import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeAuditEntry } from '../src/audit/logger.js';
import { closeAuditDb } from '../src/audit/db.js';
import { searchUnifiedHistory } from '../src/audit/history-search.js';

let auditFile: string;
let saHistoryFile: string;

beforeEach(() => {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  auditFile = path.join(os.tmpdir(), `unified-audit-${stamp}.sqlite`);
  saHistoryFile = path.join(os.tmpdir(), `unified-sahist-${stamp}.db`);

  const db = new Database(saHistoryFile);
  db.exec(`
    CREATE TABLE QueryHistory (id INTEGER PRIMARY KEY AUTOINCREMENT, query TEXT NOT NULL, createdTime REAL NOT NULL);
    CREATE UNIQUE INDEX query_idx ON QueryHistory (query);
  `);
  const insert = db.prepare('INSERT INTO QueryHistory (query, createdTime) VALUES (?, ?)');
  const t = Date.now() / 1000;
  insert.run('SELECT * FROM users WHERE id = 1', t - 30);
  insert.run('UPDATE users SET name = ?', t - 600);
  db.close();
});

afterEach(() => {
  closeAuditDb();
  for (const ext of ['', '-wal', '-shm']) {
    try {
      fs.unlinkSync(auditFile + ext);
    } catch {
      /* ignore */
    }
    try {
      fs.unlinkSync(saHistoryFile + ext);
    } catch {
      /* ignore */
    }
  }
});

describe('searchUnifiedHistory', () => {
  it('merges audit + sequel-ace; sort by ts DESC', () => {
    writeAuditEntry(
      { requestId: 'r1', connection: 'c', databases: ['app'], category: 'read', sql: 'SELECT 1', decision: 'allow', confirmed: false, outcome: 'success' },
      { redactSqlInLog: false, tamperEvidentChain: false, pathOverride: auditFile },
    );

    const rows = searchUnifiedHistory(
      {},
      { auditPathOverride: auditFile, sequelAcePathOverride: saHistoryFile },
    );

    expect(rows.length).toBe(3);
    expect(rows.some((r) => r.source === 'mcp')).toBe(true);
    expect(rows.some((r) => r.source === 'sequel-ace')).toBe(true);
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i - 1]!.ts >= rows[i]!.ts).toBe(true);
    }
  });

  it('source=mcp filters out sequel-ace', () => {
    writeAuditEntry(
      { requestId: 'r1', connection: 'c', databases: [], category: 'read', sql: 'SELECT 1', decision: 'allow', confirmed: false, outcome: 'success' },
      { redactSqlInLog: false, tamperEvidentChain: false, pathOverride: auditFile },
    );
    const rows = searchUnifiedHistory(
      { source: 'mcp' },
      { auditPathOverride: auditFile, sequelAcePathOverride: saHistoryFile },
    );
    expect(rows.every((r) => r.source === 'mcp')).toBe(true);
  });

  it('search filters across both sources', () => {
    writeAuditEntry(
      { requestId: 'r1', connection: 'c', databases: [], category: 'read', sql: 'SELECT * FROM orders', decision: 'allow', confirmed: false, outcome: 'success' },
      { redactSqlInLog: false, tamperEvidentChain: false, pathOverride: auditFile },
    );
    const rows = searchUnifiedHistory(
      { search: 'users' },
      { auditPathOverride: auditFile, sequelAcePathOverride: saHistoryFile },
    );
    expect(rows.length).toBe(2);
    expect(rows.every((r) => r.sql.toLowerCase().includes('users'))).toBe(true);
  });
});
