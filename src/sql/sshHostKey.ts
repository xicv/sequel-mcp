import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { SshHostKeyPolicy } from '../types.js';

export interface KnownHostEntry {
  hostPatterns: string[];
  keyType: string;
  keyBase64: string;
  marker?: '@cert-authority' | '@revoked';
  hashed?: { salt: string; hash: string };
}

export function parseKnownHosts(content: string): KnownHostEntry[] {
  const entries: KnownHostEntry[] = [];
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const parts = line.split(/\s+/);
    let cursor = 0;
    let marker: KnownHostEntry['marker'];
    if (parts[0] === '@cert-authority' || parts[0] === '@revoked') {
      marker = parts[0];
      cursor = 1;
    }
    const hostField = parts[cursor];
    const keyType = parts[cursor + 1];
    const keyBase64 = parts[cursor + 2];
    if (!hostField || !keyType || !keyBase64) continue;

    let hashed: KnownHostEntry['hashed'];
    let hostPatterns: string[];
    if (hostField.startsWith('|1|')) {
      const segments = hostField.split('|');
      if (segments.length >= 4) {
        hashed = { salt: segments[2] ?? '', hash: segments[3] ?? '' };
      }
      hostPatterns = [];
    } else {
      hostPatterns = hostField.split(',').map((s) => s.trim()).filter(Boolean);
    }

    entries.push({ hostPatterns, keyType, keyBase64, marker, hashed });
  }
  return entries;
}

function matchesPattern(pattern: string, host: string, port: number): boolean {
  let p = pattern;
  let portMatch = true;
  if (p.startsWith('[') && p.includes(']:')) {
    const close = p.indexOf(']:');
    const portPart = p.slice(close + 2);
    p = p.slice(1, close);
    portMatch = portPart === String(port);
  } else if (port !== 22) {
    portMatch = false;
  }
  if (!portMatch) return false;
  if (p === host) return true;
  if (p.includes('*') || p.includes('?')) {
    const re = new RegExp(
      '^' + p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$',
    );
    return re.test(host);
  }
  return false;
}

function hashedHostMatches(entry: KnownHostEntry, host: string, port: number): boolean {
  if (!entry.hashed) return false;
  const probes = port === 22 ? [host] : [`[${host}]:${port}`];
  for (const probe of probes) {
    const salt = Buffer.from(entry.hashed.salt, 'base64');
    const expected = Buffer.from(entry.hashed.hash, 'base64');
    const actual = crypto.createHmac('sha1', salt).update(probe).digest();
    if (actual.equals(expected)) return true;
  }
  return false;
}

export function matchHost(
  entries: KnownHostEntry[],
  host: string,
  port: number,
): KnownHostEntry[] {
  return entries.filter((e) => {
    if (e.hashed) return hashedHostMatches(e, host, port);
    return e.hostPatterns.some((p) => matchesPattern(p, host, port));
  });
}

export function fingerprintSha256(rawKey: Buffer): string {
  const digest = crypto.createHash('sha256').update(rawKey).digest('base64');
  return `SHA256:${digest.replace(/=+$/, '')}`;
}

export function keyMatchesEntry(rawKey: Buffer, entry: KnownHostEntry): boolean {
  const entryKey = Buffer.from(entry.keyBase64, 'base64');
  return entryKey.length === rawKey.length && crypto.timingSafeEqual(entryKey, rawKey);
}

export interface VerifyArgs {
  rawKey: Buffer;
  host: string;
  port: number;
  entries: KnownHostEntry[];
}

export interface VerifyResult {
  fingerprint: string;
  matched: boolean;
  hadMatchingHostEntry: boolean;
  revoked: boolean;
}

export function verifyHostKey(args: VerifyArgs): VerifyResult {
  const fingerprint = fingerprintSha256(args.rawKey);
  const candidates = matchHost(args.entries, args.host, args.port);
  let matched = false;
  let revoked = false;
  for (const e of candidates) {
    if (keyMatchesEntry(args.rawKey, e)) {
      if (e.marker === '@revoked') {
        revoked = true;
      } else {
        matched = true;
      }
    }
  }
  return {
    fingerprint,
    matched,
    hadMatchingHostEntry: candidates.length > 0,
    revoked,
  };
}

export async function loadKnownHosts(filePath?: string): Promise<KnownHostEntry[]> {
  const target = filePath ?? path.join(os.homedir(), '.ssh', 'known_hosts');
  try {
    const content = await fs.readFile(target, 'utf8');
    return parseKnownHosts(content);
  } catch {
    return [];
  }
}

export interface HostVerifierArgs {
  policy: SshHostKeyPolicy;
  host: string;
  port: number;
  entries: KnownHostEntry[];
  log?: (msg: string) => void;
}

export function buildHostVerifier(args: HostVerifierArgs): (rawKey: Buffer) => boolean {
  return (rawKey: Buffer) => {
    const r = verifyHostKey({
      rawKey,
      host: args.host,
      port: args.port,
      entries: args.entries,
    });
    args.log?.(`SSH host ${args.host}:${args.port} fingerprint=${r.fingerprint}`);
    if (r.revoked) {
      args.log?.(`SSH host key REVOKED for ${args.host}:${args.port} — rejecting`);
      return false;
    }
    if (args.policy === 'strict') {
      if (!r.hadMatchingHostEntry) {
        args.log?.(
          `SSH host ${args.host}:${args.port} not in known_hosts (strict mode — rejecting). Fingerprint=${r.fingerprint}`,
        );
        return false;
      }
      if (!r.matched) {
        args.log?.(
          `SSH host key MISMATCH for ${args.host}:${args.port} (strict mode — rejecting). Got=${r.fingerprint}`,
        );
        return false;
      }
      return true;
    }
    // lenient (default)
    if (r.hadMatchingHostEntry && !r.matched) {
      args.log?.(
        `SSH host key MISMATCH for ${args.host}:${args.port} (lenient mode — accepting). Got=${r.fingerprint}`,
      );
    } else if (!r.hadMatchingHostEntry) {
      args.log?.(
        `SSH host ${args.host}:${args.port} not in known_hosts (lenient mode — accepting). Add ${r.fingerprint} to enable strict mode.`,
      );
    }
    return true;
  };
}
