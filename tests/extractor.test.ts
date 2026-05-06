import { describe, expect, it } from 'vitest';
import { extractBackupSpec, isBackupRequired } from '../src/backup/extractor.js';

describe('extractBackupSpec', () => {
  it('UPDATE with WHERE → SELECT … FOR UPDATE', () => {
    const r = extractBackupSpec("UPDATE users SET name='X' WHERE id = 1", 'update');
    expect(r.kind).toBe('rows');
    if (r.kind === 'rows') {
      expect(r.tables).toHaveLength(1);
      expect(r.tables[0]?.table).toBe('users');
      expect(r.tables[0]?.selectSql).toContain('SELECT');
      expect(r.tables[0]?.selectSql).toContain('FOR UPDATE');
    }
  });

  it('DELETE with WHERE', () => {
    const r = extractBackupSpec("DELETE FROM orders WHERE status = 'cancelled'", 'delete');
    expect(r.kind).toBe('rows');
    if (r.kind === 'rows') {
      expect(r.tables[0]?.table).toBe('orders');
      expect(r.tables[0]?.locking).toBe('FOR UPDATE');
    }
  });

  it('UPDATE without WHERE → backup all rows', () => {
    const r = extractBackupSpec("UPDATE users SET archived = 1", 'update');
    expect(r.kind).toBe('rows');
    if (r.kind === 'rows') {
      expect(r.tables[0]?.selectSql).toContain('SELECT');
      expect(r.tables[0]?.selectSql).toContain('FOR UPDATE');
    }
  });

  it('TRUNCATE → combined (schema + rows)', () => {
    const r = extractBackupSpec('TRUNCATE TABLE users', 'truncate');
    expect(r.kind).toBe('combined');
  });

  it('DROP TABLE → combined', () => {
    const r = extractBackupSpec('DROP TABLE users', 'drop');
    expect(r.kind).toBe('combined');
  });

  it('ALTER TABLE → schema-only', () => {
    const r = extractBackupSpec('ALTER TABLE users ADD COLUMN x INT', 'alter');
    expect(r.kind).toBe('schema');
  });

  it('CREATE TABLE → none', () => {
    const r = extractBackupSpec('CREATE TABLE x (id INT)', 'create');
    expect(r.kind).toBe('none');
  });
});

describe('isBackupRequired', () => {
  it.each(['update', 'delete', 'truncate', 'drop', 'alter', 'rename'])('%s requires backup', (t) => {
    expect(isBackupRequired(t)).toBe(true);
  });
  it.each(['select', 'show', 'insert', 'create', 'transaction', 'admin-keyword'])(
    '%s does not require backup',
    (t) => {
      expect(isBackupRequired(t)).toBe(false);
    },
  );
});
