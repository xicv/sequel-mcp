import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeAuditEntry } from '../src/audit/logger.js';
import { cleanupAudit, maybeAutoCleanup } from '../src/audit/retention.js';
import { closeAuditDb } from '../src/audit/db.js';
import { RetentionConfigSchema } from '../src/types.js';

let dbFile: string;

beforeEach(() => {
  dbFile = path.join(os.tmpdir(), `sequel-mcp-retention-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
});

afterEach(() => {
  closeAuditDb();
  for (const ext of ['', '-wal', '-shm']) {
    try {
      fs.unlinkSync(dbFile + ext);
    } catch {
      /* ignore */
    }
  }
});

const cfg = RetentionConfigSchema.parse({
  auditDays: 7,
  backupDays: 3,
  autoCleanupHours: 24,
});

function writeAt(daysAgo: number, requestId: string) {
  const ts = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
  writeAuditEntry(
    { ts, requestId, connection: 'c', databases: [], category: 'read', sql: 'SELECT 1', decision: 'allow', confirmed: false, outcome: 'success' },
    { redactSqlInLog: false, tamperEvidentChain: false, pathOverride: dbFile },
  );
}

describe('cleanupAudit', () => {
  it('removes audit entries older than auditDays', () => {
    writeAt(0, 'r-fresh');
    writeAt(10, 'r-stale');
    const result = cleanupAudit(cfg, { pathOverride: dbFile });
    expect(result.auditDeleted).toBe(1);
  });

  it('dry-run reports counts without deleting', () => {
    writeAt(10, 'r-stale-1');
    writeAt(15, 'r-stale-2');
    const dry = cleanupAudit(cfg, { pathOverride: dbFile, dryRun: true });
    expect(dry.auditDeleted).toBe(2);
    const real = cleanupAudit(cfg, { pathOverride: dbFile });
    expect(real.auditDeleted).toBe(2);
  });
});

describe('per-category retention', () => {
  it('keeps writes longer than reads at differing windows', () => {
    const ts7 = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000); // 7 days
    const ts15 = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000); // 15 days
    writeAuditEntry(
      { ts: ts15, requestId: 'r-old-write', connection: 'c', databases: [], category: 'write', sql: 'UPDATE t SET x=1', decision: 'allow', confirmed: false, outcome: 'success' },
      { redactSqlInLog: false, tamperEvidentChain: false, pathOverride: dbFile },
    );
    writeAuditEntry(
      { ts: ts7, requestId: 'r-old-read', connection: 'c', databases: [], category: 'read', sql: 'SELECT 1', decision: 'allow', confirmed: false, outcome: 'success' },
      { redactSqlInLog: false, tamperEvidentChain: false, pathOverride: dbFile },
    );

    const c = RetentionConfigSchema.parse({
      retentionDaysByCategory: { read: 3, write: 30, ddl: 90, admin: 180, txCtrl: 7 },
    });
    const r = cleanupAudit(c, { pathOverride: dbFile });
    expect(r.auditDeletedByCategory.read).toBe(1);
    expect(r.auditDeletedByCategory.write).toBe(0);
  });

  it('legacy auditDays migrates uniformly to all categories', () => {
    const c = RetentionConfigSchema.parse({ auditDays: 14 });
    expect(c.retentionDaysByCategory.read).toBe(14);
    expect(c.retentionDaysByCategory.write).toBe(14);
    expect(c.retentionDaysByCategory.admin).toBe(14);
  });
});

describe('maybeAutoCleanup', () => {
  it('runs on first call (no last_cleanup yet)', () => {
    writeAt(20, 'r1');
    const r = maybeAutoCleanup(cfg, { pathOverride: dbFile });
    expect(r).not.toBeNull();
    expect(r!.auditDeleted).toBe(1);
  });

  it('skips if last cleanup was recent', () => {
    writeAt(20, 'r1');
    maybeAutoCleanup(cfg, { pathOverride: dbFile });
    writeAt(20, 'r2');
    const second = maybeAutoCleanup(cfg, { pathOverride: dbFile });
    expect(second).toBeNull();
  });

  it('skips when autoCleanupHours = 0', () => {
    const c = RetentionConfigSchema.parse({ ...cfg, autoCleanupHours: 0 });
    const r = maybeAutoCleanup(c, { pathOverride: dbFile });
    expect(r).toBeNull();
  });
});
