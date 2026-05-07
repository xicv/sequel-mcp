import { describe, expect, it } from 'vitest';
import { buildBaseOptions } from '../src/sql/executor.js';
import { ConnectionSchema, PolicySchema } from '../src/types.js';

function makeConn(overrides: Partial<Parameters<typeof ConnectionSchema.parse>[0]> = {}) {
  return ConnectionSchema.parse({
    name: 'test',
    host: 'db.example.com',
    port: 3306,
    user: 'root',
    ssl: false,
    policy: PolicySchema.parse({}),
    ...overrides,
  });
}

describe('buildBaseOptions — TLS behavior', () => {
  it('ssl=false → ssl undefined (legacy default)', () => {
    const conn = makeConn({ ssl: false });
    const opts = buildBaseOptions({ connection: conn, password: 'pw' });
    expect(opts.ssl).toBeUndefined();
  });

  it('ssl=true, no sslServerName → empty ssl object (legacy behavior preserved)', () => {
    const conn = makeConn({ ssl: true });
    const opts = buildBaseOptions({ connection: conn, password: 'pw' });
    expect(opts.ssl).toEqual({});
  });

  it('ssl=true, sslServerName="db.prod.example.com" → ssl carries servername (new opt-in)', () => {
    const conn = makeConn({ ssl: true, sslServerName: 'db.prod.example.com' });
    const opts = buildBaseOptions({ connection: conn, password: 'pw' });
    expect(opts.ssl).toEqual({ servername: 'db.prod.example.com' });
  });

  it('ssl=false, sslServerName ignored (no-op when ssl off)', () => {
    const conn = makeConn({ ssl: false, sslServerName: 'db.prod.example.com' });
    const opts = buildBaseOptions({ connection: conn, password: 'pw' });
    expect(opts.ssl).toBeUndefined();
  });
});

describe('buildBaseOptions — invariants existing users rely on', () => {
  it('host, port, user, password forwarded as-is', () => {
    const conn = makeConn({ host: '10.0.0.1', port: 3307, user: 'app' });
    const opts = buildBaseOptions({ connection: conn, password: 'pw' });
    expect(opts.host).toBe('10.0.0.1');
    expect(opts.port).toBe(3307);
    expect(opts.user).toBe('app');
    expect(opts.password).toBe('pw');
  });

  it('database override beats connection.database', () => {
    const conn = makeConn({ database: 'default_db' });
    const opts = buildBaseOptions({
      connection: conn,
      password: 'pw',
      database: 'override_db',
    });
    expect(opts.database).toBe('override_db');
  });

  it('database falls back to connection.database when override absent', () => {
    const conn = makeConn({ database: 'default_db' });
    const opts = buildBaseOptions({ connection: conn, password: 'pw' });
    expect(opts.database).toBe('default_db');
  });

  it('multipleStatements always false (SQL injection guardrail)', () => {
    const conn = makeConn();
    const opts = buildBaseOptions({ connection: conn, password: 'pw' });
    expect(opts.multipleStatements).toBe(false);
  });

  it('decimalNumbers=false, supportBigNumbers=true (numeric-fidelity contract)', () => {
    const conn = makeConn();
    const opts = buildBaseOptions({ connection: conn, password: 'pw' });
    expect(opts.decimalNumbers).toBe(false);
    expect(opts.supportBigNumbers).toBe(true);
    expect(opts.bigNumberStrings).toBe(true);
  });

  it('connectTimeout=15000 (kept for back-compat)', () => {
    const conn = makeConn();
    const opts = buildBaseOptions({ connection: conn, password: 'pw' });
    expect(opts.connectTimeout).toBe(15000);
  });
});

describe('ConnectionSchema — sslServerName backward compatibility', () => {
  it('parses connection with no sslServerName (legacy)', () => {
    const c = makeConn();
    expect(c.sslServerName).toBeUndefined();
  });

  it('parses connection with sslServerName (new)', () => {
    const c = makeConn({ sslServerName: 'db.prod.example.com' });
    expect(c.sslServerName).toBe('db.prod.example.com');
  });

  it('rejects empty sslServerName', () => {
    expect(() =>
      ConnectionSchema.parse({
        name: 'test',
        host: 'db',
        port: 3306,
        user: 'r',
        ssl: true,
        sslServerName: '',
        policy: PolicySchema.parse({}),
      }),
    ).toThrow();
  });

  it('rejects oversized sslServerName (>253)', () => {
    expect(() =>
      ConnectionSchema.parse({
        name: 'test',
        host: 'db',
        port: 3306,
        user: 'r',
        ssl: true,
        sslServerName: 'a'.repeat(254),
        policy: PolicySchema.parse({}),
      }),
    ).toThrow();
  });
});
