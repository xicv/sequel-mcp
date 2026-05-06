import { describe, expect, it } from 'vitest';
import { classifyStatement } from '../src/policy/classifier.js';
import type { SqlCategory } from '../src/types.js';

function expectCategory(sql: string, category: SqlCategory) {
  const r = classifyStatement(sql);
  expect(r.ok, `expected classifier to succeed for: ${sql}`).toBe(true);
  if (r.ok) {
    expect(r.category).toBe(category);
  }
}

describe('classifyStatement', () => {
  describe('read', () => {
    it('SELECT', () => expectCategory('SELECT 1', 'read'));
    it('SELECT with JOIN', () =>
      expectCategory('SELECT u.id FROM users u JOIN orders o ON o.user_id = u.id', 'read'));
    it('SHOW TABLES', () => expectCategory('SHOW TABLES', 'read'));
    it('DESCRIBE', () => expectCategory('DESCRIBE users', 'read'));
    it('EXPLAIN', () => expectCategory('EXPLAIN SELECT * FROM users', 'read'));
    it('CTE that only reads', () =>
      expectCategory('WITH x AS (SELECT 1 AS a) SELECT * FROM x', 'read'));
  });

  describe('write', () => {
    it('INSERT', () =>
      expectCategory('INSERT INTO users (name) VALUES ("x")', 'write'));
    it('UPDATE', () => expectCategory('UPDATE users SET name = "x" WHERE id = 1', 'write'));
    it('DELETE', () => expectCategory('DELETE FROM users WHERE id = 1', 'write'));
    it('REPLACE', () =>
      expectCategory('REPLACE INTO users (id, name) VALUES (1, "x")', 'write'));
  });

  describe('ddl', () => {
    it('CREATE TABLE', () =>
      expectCategory('CREATE TABLE x (id INT PRIMARY KEY)', 'ddl'));
    it('DROP TABLE', () => expectCategory('DROP TABLE users', 'ddl'));
    it('ALTER TABLE', () =>
      expectCategory('ALTER TABLE users ADD COLUMN x INT', 'ddl'));
    it('TRUNCATE', () => expectCategory('TRUNCATE TABLE users', 'ddl'));
    it('RENAME TABLE', () =>
      expectCategory('RENAME TABLE old_users TO users', 'ddl'));
  });

  describe('txCtrl', () => {
    it('BEGIN', () => expectCategory('BEGIN', 'txCtrl'));
    it('COMMIT', () => expectCategory('COMMIT', 'txCtrl'));
    it('ROLLBACK', () => expectCategory('ROLLBACK', 'txCtrl'));
    it('START TRANSACTION', () =>
      expectCategory('START TRANSACTION', 'txCtrl'));
  });

  describe('admin', () => {
    it('GRANT', () =>
      expectCategory('GRANT SELECT ON *.* TO "u"@"%"', 'admin'));
    it('REVOKE', () =>
      expectCategory('REVOKE SELECT ON *.* FROM "u"@"%"', 'admin'));
    it('SET GLOBAL', () =>
      expectCategory('SET GLOBAL max_connections = 100', 'admin'));
  });

  describe('rejection', () => {
    it('rejects multi-statement input', () => {
      const r = classifyStatement('SELECT 1; DROP TABLE users');
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error).toMatch(/multiple statements/i);
      }
    });

    it('rejects empty input', () => {
      const r = classifyStatement('   ');
      expect(r.ok).toBe(false);
    });

    it('rejects unparseable input', () => {
      const r = classifyStatement('not valid sql at all $$$');
      expect(r.ok).toBe(false);
    });

    it('rejects comment-only input', () => {
      const r = classifyStatement('-- just a comment');
      expect(r.ok).toBe(false);
    });
  });
});
