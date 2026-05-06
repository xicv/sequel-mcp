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
  it.each(['update', 'delete', 'replace', 'insert', 'truncate', 'drop', 'alter', 'rename'])(
    '%s requires backup',
    (t) => {
      expect(isBackupRequired(t)).toBe(true);
    },
  );
  it.each(['select', 'show', 'create', 'transaction', 'admin-keyword'])('%s does not require backup', (t) => {
    expect(isBackupRequired(t)).toBe(false);
  });
});

describe('multi-table UPDATE/DELETE', () => {
  it('multi-table UPDATE: only mutated tables get backups', () => {
    const r = extractBackupSpec(
      'UPDATE a JOIN b ON a.id = b.aid SET a.x = 1 WHERE a.k = 10',
      'update',
    );
    expect(r.kind).toBe('rows');
    if (r.kind === 'rows') {
      expect(r.tables).toHaveLength(1);
      expect(r.tables[0]?.table).toBe('a');
    }
  });

  it('multi-table UPDATE: both tables in SET → both backed up', () => {
    const r = extractBackupSpec(
      'UPDATE a JOIN b ON a.id = b.aid SET a.x = 1, b.y = 2 WHERE a.k = 10',
      'update',
    );
    expect(r.kind).toBe('rows');
    if (r.kind === 'rows') {
      const names = r.tables.map((t) => t.table).sort();
      expect(names).toEqual(['a', 'b']);
    }
  });

  it('multi-table DELETE: each target gets a backup', () => {
    const r = extractBackupSpec('DELETE a, b FROM a JOIN b ON a.id = b.aid WHERE a.k = 10', 'delete');
    expect(r.kind).toBe('rows');
    if (r.kind === 'rows') {
      const names = r.tables.map((t) => t.table).sort();
      expect(names).toEqual(['a', 'b']);
    }
  });
});

describe('REPLACE PK rollback', () => {
  it('REPLACE with id column → SELECT pre-existing rows by PK', () => {
    const r = extractBackupSpec("REPLACE INTO users (id, name) VALUES (1, 'x'), (2, 'y')", 'replace');
    expect(r.kind).toBe('rows');
    if (r.kind === 'rows') {
      expect(r.tables).toHaveLength(1);
      expect(r.tables[0]?.selectSql).toContain('IN (1, 2)');
      expect(r.tables[0]?.selectSql).toContain('FOR UPDATE');
    }
  });

  it('REPLACE without id column → none', () => {
    const r = extractBackupSpec("REPLACE INTO users (name) VALUES ('x')", 'replace');
    expect(r.kind).toBe('none');
  });
});

describe('INSERT hint', () => {
  it('INSERT with explicit id values → kind=insert-hint with PK values', () => {
    const r = extractBackupSpec("INSERT INTO users (id, name) VALUES (1, 'x'), (2, 'y')", 'insert');
    expect(r.kind).toBe('insert-hint');
    if (r.kind === 'insert-hint') {
      expect(r.table.table).toBe('users');
      expect(r.columns).toEqual(['id', 'name']);
      expect(r.explicitPkValues).toEqual([[1], [2]]);
    }
  });

  it('INSERT without id column → insert-hint with no PK values', () => {
    const r = extractBackupSpec("INSERT INTO users (name) VALUES ('x')", 'insert');
    expect(r.kind).toBe('insert-hint');
    if (r.kind === 'insert-hint') {
      expect(r.explicitPkValues).toBeNull();
    }
  });
});
