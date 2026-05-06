import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HELPER_NAME = 'touchid-helper';
const SOURCE_NAME = 'touchid-helper.swift';

function distRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', '..');
}

function helperBinaryPath(): string {
  return path.join(distRoot(), 'dist', HELPER_NAME);
}

function helperSourcePath(): string {
  return path.join(distRoot(), 'scripts', SOURCE_NAME);
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function compileHelper(): Promise<string | null> {
  const src = helperSourcePath();
  const out = helperBinaryPath();
  if (!(await exists(src))) return null;
  await fs.mkdir(path.dirname(out), { recursive: true });
  return new Promise((resolve) => {
    const child = spawn('swiftc', [src, '-o', out], { stdio: 'ignore' });
    child.on('error', () => resolve(null));
    child.on('exit', (code) => resolve(code === 0 ? out : null));
  });
}

export interface TouchIDPrompt {
  available: boolean;
  prompt(reason: string): Promise<boolean>;
}

class UnavailableTouchID implements TouchIDPrompt {
  available = false;
  async prompt(): Promise<boolean> {
    return false;
  }
}

class SwiftTouchID implements TouchIDPrompt {
  available = true;
  constructor(private readonly binary: string) {}
  async prompt(reason: string): Promise<boolean> {
    return new Promise((resolve) => {
      const child = spawn(this.binary, [reason], { stdio: ['ignore', 'ignore', 'pipe'] });
      child.on('error', () => resolve(false));
      child.on('exit', (code) => resolve(code === 0));
    });
  }
}

let cached: TouchIDPrompt | null = null;

export async function getTouchID(): Promise<TouchIDPrompt> {
  if (cached) return cached;
  if (process.platform !== 'darwin') {
    cached = new UnavailableTouchID();
    return cached;
  }
  const binary = helperBinaryPath();
  if (await exists(binary)) {
    cached = new SwiftTouchID(binary);
    return cached;
  }
  const compiled = await compileHelper();
  cached = compiled ? new SwiftTouchID(compiled) : new UnavailableTouchID();
  return cached;
}

export interface SessionAuthOptions {
  idleMs: number;
}

export class SessionAuthenticator {
  private lastOkAt = 0;

  constructor(
    private readonly touchID: TouchIDPrompt,
    private readonly options: SessionAuthOptions = { idleMs: 15 * 60 * 1000 },
  ) {}

  async ensureAuthenticated(reason: string): Promise<boolean> {
    if (!this.touchID.available) return true;
    const now = Date.now();
    if (now - this.lastOkAt < this.options.idleMs) return true;
    const ok = await this.touchID.prompt(reason);
    if (ok) this.lastOkAt = now;
    return ok;
  }

  invalidate(): void {
    this.lastOkAt = 0;
  }
}
