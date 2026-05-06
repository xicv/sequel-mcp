import { searchAuditLog, type AuditRow } from './logger.js';
import { readSequelAceHistory } from '../importer/sequelAceHistory.js';

export type HistorySource = 'mcp' | 'sequel-ace';

export interface UnifiedHistoryEntry {
  source: HistorySource;
  ts: string;
  sql: string;
  connection?: string;
  category?: string;
  outcome?: string;
  decision?: string;
  databases?: string[];
  durationMs?: number;
  affectedRows?: number;
  backupId?: number | null;
  sequelAceId?: number;
}

export interface HistorySearchFilters {
  sinceIso?: string;
  untilIso?: string;
  search?: string;
  connection?: string;
  source?: HistorySource | 'both';
  limit?: number;
}

function fromAudit(row: AuditRow): UnifiedHistoryEntry {
  return {
    source: 'mcp',
    ts: row.ts,
    sql: row.sql_redacted,
    connection: row.connection,
    category: row.category,
    outcome: row.outcome,
    decision: row.decision,
    databases: row.databases,
    durationMs: row.duration_ms ?? undefined,
    affectedRows: row.affected_rows ?? undefined,
    backupId: row.backup_id,
  };
}

export function searchUnifiedHistory(
  filters: HistorySearchFilters,
  opts?: { auditPathOverride?: string; sequelAcePathOverride?: string },
): UnifiedHistoryEntry[] {
  const source = filters.source ?? 'both';
  const limit = Math.min(filters.limit ?? 200, 5000);
  const since = filters.sinceIso ? new Date(filters.sinceIso) : undefined;
  const until = filters.untilIso ? new Date(filters.untilIso) : undefined;

  const out: UnifiedHistoryEntry[] = [];

  if (source === 'mcp' || source === 'both') {
    const audit = searchAuditLog(
      {
        since,
        until,
        connection: filters.connection,
        limit: limit * 2,
      },
      { pathOverride: opts?.auditPathOverride },
    );
    for (const r of audit) {
      if (filters.search && !r.sql_redacted.toLowerCase().includes(filters.search.toLowerCase())) {
        continue;
      }
      out.push(fromAudit(r));
    }
  }

  if (source === 'sequel-ace' || source === 'both') {
    const sequelAce = readSequelAceHistory(
      { sinceIso: filters.sinceIso, search: filters.search, limit: limit * 2 },
      { pathOverride: opts?.sequelAcePathOverride },
    );
    for (const r of sequelAce) {
      const ts = r.createdAtIso;
      if (until && ts >= until.toISOString()) continue;
      out.push({ source: 'sequel-ace', ts, sql: r.query, sequelAceId: r.id });
    }
  }

  out.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
  return out.slice(0, limit);
}
