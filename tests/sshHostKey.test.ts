import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  parseKnownHosts,
  matchHost,
  fingerprintSha256,
  keyMatchesEntry,
  verifyHostKey,
  type KnownHostEntry,
} from '../src/sql/sshHostKey.js';

function makeKey(payload: string): Buffer {
  return crypto.createHash('sha256').update(payload).digest();
}

describe('parseKnownHosts', () => {
  it('parses plain hostname entries', () => {
    const content = `
# comment line
example.com ssh-ed25519 AAAA1
git.example.com,git ssh-rsa AAAA2
`;
    const entries = parseKnownHosts(content);
    expect(entries).toHaveLength(2);
    expect(entries[0].hostPatterns).toEqual(['example.com']);
    expect(entries[0].keyType).toBe('ssh-ed25519');
    expect(entries[1].hostPatterns).toEqual(['git.example.com', 'git']);
  });

  it('parses entries with port wrapped in brackets', () => {
    const entries = parseKnownHosts('[git.example.com]:2222 ssh-ed25519 AAAA');
    expect(entries[0].hostPatterns).toEqual(['[git.example.com]:2222']);
  });

  it('parses @cert-authority and @revoked markers', () => {
    const entries = parseKnownHosts(`@cert-authority *.example.com ssh-ed25519 AAAA
@revoked bad.example.com ssh-rsa BBBB`);
    expect(entries[0].marker).toBe('@cert-authority');
    expect(entries[1].marker).toBe('@revoked');
  });

  it('parses hashed host entries', () => {
    const entries = parseKnownHosts('|1|salt+base64=|hashbase64= ssh-ed25519 AAAA');
    expect(entries[0].hashed?.salt).toBe('salt+base64=');
    expect(entries[0].hashed?.hash).toBe('hashbase64=');
  });

  it('skips blank lines and comments', () => {
    expect(parseKnownHosts('')).toHaveLength(0);
    expect(parseKnownHosts('# only comment\n  \n')).toHaveLength(0);
  });

  it('skips malformed lines', () => {
    expect(parseKnownHosts('host-only ssh-rsa\nincomplete')).toHaveLength(0);
  });
});

describe('matchHost', () => {
  const entries: KnownHostEntry[] = [
    { hostPatterns: ['example.com'], keyType: 'ssh-ed25519', keyBase64: 'A' },
    { hostPatterns: ['*.example.com'], keyType: 'ssh-rsa', keyBase64: 'B' },
    { hostPatterns: ['[host.example.com]:2222'], keyType: 'ssh-ed25519', keyBase64: 'C' },
  ];

  it('matches exact hostname on port 22', () => {
    expect(matchHost(entries, 'example.com', 22)).toHaveLength(1);
  });

  it('matches wildcard on port 22', () => {
    expect(matchHost(entries, 'sub.example.com', 22)).toHaveLength(1);
  });

  it('matches bracketed host:port for non-default port', () => {
    expect(matchHost(entries, 'host.example.com', 2222)).toHaveLength(1);
  });

  it('does not match non-default port without bracket entry', () => {
    expect(matchHost(entries, 'example.com', 2222)).toHaveLength(0);
  });

  it('returns empty when no patterns match', () => {
    expect(matchHost(entries, 'unknown.com', 22)).toHaveLength(0);
  });
});

describe('fingerprintSha256', () => {
  it('produces SHA256: prefixed base64 string', () => {
    const fp = fingerprintSha256(Buffer.from('hello'));
    expect(fp).toMatch(/^SHA256:[A-Za-z0-9+/]+$/);
    expect(fp).not.toMatch(/=$/); // padding stripped
  });

  it('different inputs produce different fingerprints', () => {
    expect(fingerprintSha256(Buffer.from('a'))).not.toBe(fingerprintSha256(Buffer.from('b')));
  });
});

describe('keyMatchesEntry', () => {
  it('matches when raw key equals decoded entry key', () => {
    const raw = makeKey('test');
    const entry: KnownHostEntry = {
      hostPatterns: ['example.com'],
      keyType: 'ssh-ed25519',
      keyBase64: raw.toString('base64'),
    };
    expect(keyMatchesEntry(raw, entry)).toBe(true);
  });

  it('returns false on mismatch', () => {
    const raw = makeKey('test');
    const entry: KnownHostEntry = {
      hostPatterns: ['example.com'],
      keyType: 'ssh-ed25519',
      keyBase64: makeKey('other').toString('base64'),
    };
    expect(keyMatchesEntry(raw, entry)).toBe(false);
  });

  it('returns false on length mismatch (resists timing oracle)', () => {
    const raw = makeKey('test');
    const entry: KnownHostEntry = {
      hostPatterns: ['example.com'],
      keyType: 'ssh-ed25519',
      keyBase64: Buffer.from([0x01]).toString('base64'),
    };
    expect(keyMatchesEntry(raw, entry)).toBe(false);
  });
});

describe('verifyHostKey', () => {
  const goodKey = makeKey('good');
  const otherKey = makeKey('other');

  it('matched=true when host + key both match', () => {
    const r = verifyHostKey({
      rawKey: goodKey,
      host: 'db.example.com',
      port: 22,
      entries: [
        {
          hostPatterns: ['db.example.com'],
          keyType: 'ssh-ed25519',
          keyBase64: goodKey.toString('base64'),
        },
      ],
    });
    expect(r.matched).toBe(true);
    expect(r.hadMatchingHostEntry).toBe(true);
    expect(r.revoked).toBe(false);
  });

  it('matched=false, hadMatchingHostEntry=true when key changed (MitM signal)', () => {
    const r = verifyHostKey({
      rawKey: goodKey,
      host: 'db.example.com',
      port: 22,
      entries: [
        {
          hostPatterns: ['db.example.com'],
          keyType: 'ssh-ed25519',
          keyBase64: otherKey.toString('base64'),
        },
      ],
    });
    expect(r.matched).toBe(false);
    expect(r.hadMatchingHostEntry).toBe(true);
  });

  it('hadMatchingHostEntry=false when host unknown', () => {
    const r = verifyHostKey({
      rawKey: goodKey,
      host: 'unknown.example.com',
      port: 22,
      entries: [
        {
          hostPatterns: ['db.example.com'],
          keyType: 'ssh-ed25519',
          keyBase64: goodKey.toString('base64'),
        },
      ],
    });
    expect(r.hadMatchingHostEntry).toBe(false);
    expect(r.matched).toBe(false);
  });

  it('revoked=true when @revoked marker matches the key', () => {
    const r = verifyHostKey({
      rawKey: goodKey,
      host: 'db.example.com',
      port: 22,
      entries: [
        {
          marker: '@revoked',
          hostPatterns: ['db.example.com'],
          keyType: 'ssh-ed25519',
          keyBase64: goodKey.toString('base64'),
        },
      ],
    });
    expect(r.revoked).toBe(true);
    expect(r.matched).toBe(false);
  });

  it('always emits a fingerprint, even with empty entries', () => {
    const r = verifyHostKey({ rawKey: goodKey, host: 'x', port: 22, entries: [] });
    expect(r.fingerprint).toMatch(/^SHA256:/);
    expect(r.matched).toBe(false);
    expect(r.hadMatchingHostEntry).toBe(false);
  });
});
