import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  buildHostVerifier,
  type KnownHostEntry,
} from '../src/sql/sshHostKey.js';

function key(payload: string): Buffer {
  return crypto.createHash('sha256').update(payload).digest();
}

function entry(host: string, payload: string, marker?: '@cert-authority' | '@revoked'): KnownHostEntry {
  return {
    hostPatterns: [host],
    keyType: 'ssh-ed25519',
    keyBase64: key(payload).toString('base64'),
    marker,
  };
}

describe('buildHostVerifier — lenient policy (default, backward compat)', () => {
  it('accepts unknown host and logs fingerprint', () => {
    const logs: string[] = [];
    const verify = buildHostVerifier({
      policy: 'lenient',
      host: 'jump.example.com',
      port: 22,
      entries: [],
      log: (m) => logs.push(m),
    });
    expect(verify(key('host-key'))).toBe(true);
    expect(logs.some((l) => l.includes('SHA256:'))).toBe(true);
    expect(logs.some((l) => l.includes('not in known_hosts'))).toBe(true);
  });

  it('accepts matching known host', () => {
    const k = key('good-key');
    const verify = buildHostVerifier({
      policy: 'lenient',
      host: 'jump.example.com',
      port: 22,
      entries: [
        {
          hostPatterns: ['jump.example.com'],
          keyType: 'ssh-ed25519',
          keyBase64: k.toString('base64'),
        },
      ],
    });
    expect(verify(k)).toBe(true);
  });

  it('accepts mismatch but logs warning (lenient = no break)', () => {
    const logs: string[] = [];
    const verify = buildHostVerifier({
      policy: 'lenient',
      host: 'jump.example.com',
      port: 22,
      entries: [entry('jump.example.com', 'old-key')],
      log: (m) => logs.push(m),
    });
    expect(verify(key('new-key'))).toBe(true);
    expect(logs.some((l) => l.includes('MISMATCH'))).toBe(true);
  });

  it('REJECTS @revoked even in lenient mode', () => {
    const k = key('compromised');
    const verify = buildHostVerifier({
      policy: 'lenient',
      host: 'jump.example.com',
      port: 22,
      entries: [entry('jump.example.com', 'compromised', '@revoked')],
    });
    expect(verify(k)).toBe(false);
  });
});

describe('buildHostVerifier — strict policy', () => {
  it('rejects unknown host', () => {
    const verify = buildHostVerifier({
      policy: 'strict',
      host: 'jump.example.com',
      port: 22,
      entries: [],
    });
    expect(verify(key('host-key'))).toBe(false);
  });

  it('rejects mismatched key for known host (MitM signal)', () => {
    const verify = buildHostVerifier({
      policy: 'strict',
      host: 'jump.example.com',
      port: 22,
      entries: [entry('jump.example.com', 'expected-key')],
    });
    expect(verify(key('attacker-key'))).toBe(false);
  });

  it('accepts matching key for known host', () => {
    const k = key('expected-key');
    const verify = buildHostVerifier({
      policy: 'strict',
      host: 'jump.example.com',
      port: 22,
      entries: [
        {
          hostPatterns: ['jump.example.com'],
          keyType: 'ssh-ed25519',
          keyBase64: k.toString('base64'),
        },
      ],
    });
    expect(verify(k)).toBe(true);
  });

  it('rejects @revoked even when key matches', () => {
    const k = key('once-trusted');
    const verify = buildHostVerifier({
      policy: 'strict',
      host: 'jump.example.com',
      port: 22,
      entries: [
        {
          marker: '@revoked',
          hostPatterns: ['jump.example.com'],
          keyType: 'ssh-ed25519',
          keyBase64: k.toString('base64'),
        },
      ],
    });
    expect(verify(k)).toBe(false);
  });
});

describe('SshTunnelSchema — hostKeyPolicy backward compatibility', () => {
  it('legacy config without hostKeyPolicy still parses (existing users unaffected)', async () => {
    const { SshTunnelSchema } = await import('../src/types.js');
    const r = SshTunnelSchema.parse({
      host: 'jump.example.com',
      user: 'deploy',
      authMethod: 'key',
      privateKeyPath: '~/.ssh/id_rsa',
    });
    expect(r.hostKeyPolicy).toBeUndefined();
    expect(r.knownHostsPath).toBeUndefined();
  });

  it('opt-in hostKeyPolicy="strict" parses', async () => {
    const { SshTunnelSchema } = await import('../src/types.js');
    const r = SshTunnelSchema.parse({
      host: 'jump.example.com',
      user: 'deploy',
      authMethod: 'key',
      privateKeyPath: '~/.ssh/id_rsa',
      hostKeyPolicy: 'strict',
      knownHostsPath: '/custom/known_hosts',
    });
    expect(r.hostKeyPolicy).toBe('strict');
    expect(r.knownHostsPath).toBe('/custom/known_hosts');
  });

  it('rejects unknown policy values', async () => {
    const { SshTunnelSchema } = await import('../src/types.js');
    expect(() =>
      SshTunnelSchema.parse({
        host: 'jump',
        user: 'd',
        authMethod: 'key',
        privateKeyPath: '~/.ssh/id_rsa',
        hostKeyPolicy: 'tofu',
      }),
    ).toThrow();
  });
});
