import { describe, expect, it } from 'vitest';
import { ConnectionSchema, PolicySchema } from '../src/types.js';
import { resolveEffectivePolicy } from '../src/policy/resolver.js';

const baseConn = ConnectionSchema.parse({
  name: 'c',
  host: 'h',
  user: 'u',
  policy: PolicySchema.parse({}),
});

describe('resolveEffectivePolicy', () => {
  it('falls back to baseline policy when no DBs touched', () => {
    const r = resolveEffectivePolicy({
      connection: baseConn,
      category: 'read',
      targetDatabases: [],
    });
    expect(r.action).toBe('allow');
    expect(r.contributingDatabase).toBeNull();
  });

  it('uses connection default DB when no explicit target', () => {
    const conn = ConnectionSchema.parse({
      ...baseConn,
      database: 'app',
      databasePolicies: { app: { write: 'allow' } },
    });
    const r = resolveEffectivePolicy({
      connection: conn,
      category: 'write',
      targetDatabases: [],
    });
    expect(r.action).toBe('allow');
    expect(r.contributingDatabase).toBe('app');
  });

  it('per-DB override beats baseline', () => {
    const conn = ConnectionSchema.parse({
      ...baseConn,
      databasePolicies: { db1: { write: 'allow' } },
    });
    const r = resolveEffectivePolicy({
      connection: conn,
      category: 'write',
      targetDatabases: ['db1'],
    });
    expect(r.action).toBe('allow');
  });

  it('strictest wins across multi-DB target', () => {
    const conn = ConnectionSchema.parse({
      ...baseConn,
      databasePolicies: {
        db1: { write: 'allow' },
        db2: { write: 'deny' },
      },
    });
    const r = resolveEffectivePolicy({
      connection: conn,
      category: 'write',
      targetDatabases: ['db1', 'db2'],
    });
    expect(r.action).toBe('deny');
    expect(r.contributingDatabase).toBe('db2');
  });

  it('cascades baseline to non-overridden databases', () => {
    const conn = ConnectionSchema.parse({
      ...baseConn,
      policy: PolicySchema.parse({ write: 'deny' }),
      databasePolicies: { db1: { write: 'confirm' } },
    });
    const safe = resolveEffectivePolicy({
      connection: conn,
      category: 'write',
      targetDatabases: ['db1'],
    });
    expect(safe.action).toBe('confirm');

    const unsafe = resolveEffectivePolicy({
      connection: conn,
      category: 'write',
      targetDatabases: ['db_other'],
    });
    expect(unsafe.action).toBe('deny');
  });

  it('confirm beats allow when mixed', () => {
    const conn = ConnectionSchema.parse({
      ...baseConn,
      databasePolicies: {
        db1: { read: 'allow' },
        db2: { read: 'confirm' },
      },
    });
    const r = resolveEffectivePolicy({
      connection: conn,
      category: 'read',
      targetDatabases: ['db1', 'db2'],
    });
    expect(r.action).toBe('confirm');
    expect(r.contributingDatabase).toBe('db2');
  });
});
