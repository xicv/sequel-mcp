import { openAuditDb } from './db.js';
import type { RetentionConfig, SqlCategory } from '../types.js';

export interface CleanupResult {
  auditDeleted: number;
  auditDeletedByCategory: Record<SqlCategory, number>;
  backupDeleted: number;
  bytesReclaimed: number;
  ranAt: string;
}

function pageBytes(db: ReturnType<typeof openAuditDb>): number {
  const pageCount = db.pragma('page_count', { simple: true }) as number;
  const pageSize = db.pragma('page_size', { simple: true }) as number;
  return Number(pageCount) * Number(pageSize);
}

function getMeta(db: ReturnType<typeof openAuditDb>, key: string): string | null {
  const r = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
  return r?.value ?? null;
}

function setMeta(db: ReturnType<typeof openAuditDb>, key: string, value: string): void {
  db.prepare(
    `INSERT INTO meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, value);
}

const CATEGORIES: SqlCategory[] = ['read', 'write', 'ddl', 'admin', 'txCtrl'];

function dayCutoff(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

export function cleanupAudit(config: RetentionConfig, opts?: { pathOverride?: string; dryRun?: boolean }): CleanupResult {
  const db = openAuditDb({ pathOverride: opts?.pathOverride });
  const ranAt = new Date().toISOString();
  const beforeBytes = pageBytes(db);

  const cutoffsByCategory = Object.fromEntries(
    CATEGORIES.map((c) => [c, dayCutoff(config.retentionDaysByCategory[c])]),
  ) as Record<SqlCategory, string>;
  const backupCutoff = dayCutoff(config.backupDays);

  const auditDeletedByCategory: Record<SqlCategory, number> = {
    read: 0,
    write: 0,
    ddl: 0,
    admin: 0,
    txCtrl: 0,
  };
  let auditDeleted = 0;
  let backupDeleted = 0;

  if (!opts?.dryRun) {
    const txn = db.transaction(() => {
      for (const cat of CATEGORIES) {
        const r = db
          .prepare('DELETE FROM audit_log WHERE category = ? AND ts < ?')
          .run(cat, cutoffsByCategory[cat]);
        auditDeletedByCategory[cat] = Number(r.changes);
        auditDeleted += Number(r.changes);
      }
      const b = db.prepare('DELETE FROM backup WHERE ts < ?').run(backupCutoff);
      backupDeleted = Number(b.changes);

      const auditMaxBytes = config.auditMaxMB * 1024 * 1024;
      const backupMaxBytes = config.backupMaxMB * 1024 * 1024;
      const cur = pageBytes(db);
      if (cur > auditMaxBytes + backupMaxBytes) {
        const trim = db
          .prepare(
            `DELETE FROM backup WHERE id IN (
               SELECT id FROM backup ORDER BY id ASC LIMIT
                 CAST((SELECT COUNT(*) FROM backup) * 0.2 AS INTEGER)
             )`,
          )
          .run();
        backupDeleted += Number(trim.changes);
        const trimAudit = db
          .prepare(
            `DELETE FROM audit_log WHERE id IN (
               SELECT id FROM audit_log ORDER BY id ASC LIMIT
                 CAST((SELECT COUNT(*) FROM audit_log) * 0.2 AS INTEGER)
             )`,
          )
          .run();
        auditDeleted += Number(trimAudit.changes);
      }

      setMeta(db, 'last_cleanup_at', ranAt);
    });
    txn();
    db.exec('VACUUM');
  } else {
    for (const cat of CATEGORIES) {
      const a = db
        .prepare('SELECT COUNT(*) as c FROM audit_log WHERE category = ? AND ts < ?')
        .get(cat, cutoffsByCategory[cat]) as { c: number };
      auditDeletedByCategory[cat] = Number(a.c);
      auditDeleted += Number(a.c);
    }
    const b = db.prepare('SELECT COUNT(*) as c FROM backup WHERE ts < ?').get(backupCutoff) as { c: number };
    backupDeleted = Number(b.c);
  }

  const afterBytes = pageBytes(db);
  return {
    auditDeleted,
    auditDeletedByCategory,
    backupDeleted,
    bytesReclaimed: Math.max(0, beforeBytes - afterBytes),
    ranAt,
  };
}

export function maybeAutoCleanup(config: RetentionConfig, opts?: { pathOverride?: string }): CleanupResult | null {
  if (config.autoCleanupHours <= 0) return null;
  const db = openAuditDb({ pathOverride: opts?.pathOverride });
  const last = getMeta(db, 'last_cleanup_at');
  if (last) {
    const ageMs = Date.now() - new Date(last).getTime();
    if (ageMs < config.autoCleanupHours * 60 * 60 * 1000) return null;
  }
  return cleanupAudit(config, opts);
}
