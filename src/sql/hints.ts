const SELECT_HINT_SLOT = /^\s*select\b/i;

export function injectMaxExecutionTime(sql: string, ms: number): string {
  if (!SELECT_HINT_SLOT.test(sql)) return sql;
  if (/\/\*\+\s*MAX_EXECUTION_TIME/i.test(sql)) return sql;
  return sql.replace(SELECT_HINT_SLOT, (m) => `${m} /*+ MAX_EXECUTION_TIME(${ms}) */`);
}
