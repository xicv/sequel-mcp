import fs from 'node:fs/promises';
import path from 'node:path';
import {
  ConfigSchema,
  ConnectionSchema,
  POLICY_PRESETS,
  type Config,
  type Connection,
  type Policy,
  type PolicyPresetName,
} from '../types.js';
import { configDir, configPath } from './paths.js';

const EMPTY_CONFIG: Config = { version: 1, connections: [] };

export async function loadConfig(): Promise<Config> {
  try {
    const raw = await fs.readFile(configPath(), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    return ConfigSchema.parse(parsed);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return EMPTY_CONFIG;
    throw e;
  }
}

async function ensureConfigDir(): Promise<void> {
  await fs.mkdir(configDir(), { recursive: true, mode: 0o700 });
}

async function atomicWrite(target: string, contents: string): Promise<void> {
  await ensureConfigDir();
  const tmp = path.join(configDir(), `.config.${process.pid}.tmp`);
  await fs.writeFile(tmp, contents, { encoding: 'utf8', mode: 0o600 });
  await fs.rename(tmp, target);
}

export async function saveConfig(cfg: Config): Promise<void> {
  const validated = ConfigSchema.parse(cfg);
  const json = `${JSON.stringify(validated, null, 2)}\n`;
  await atomicWrite(configPath(), json);
}

export function policyFromPreset(preset: PolicyPresetName): Policy {
  return { ...POLICY_PRESETS[preset] };
}

export async function upsertConnection(connection: Connection): Promise<Config> {
  const validated = ConnectionSchema.parse(connection);
  const cfg = await loadConfig();
  const idx = cfg.connections.findIndex((c) => c.name === validated.name);
  const next: Config = {
    ...cfg,
    connections:
      idx >= 0
        ? cfg.connections.map((c, i) => (i === idx ? validated : c))
        : [...cfg.connections, validated],
  };
  await saveConfig(next);
  return next;
}

export async function removeConnectionByName(name: string): Promise<Config> {
  const cfg = await loadConfig();
  const next: Config = {
    ...cfg,
    connections: cfg.connections.filter((c) => c.name !== name),
  };
  await saveConfig(next);
  return next;
}

export async function getConnection(name: string): Promise<Connection | null> {
  const cfg = await loadConfig();
  return cfg.connections.find((c) => c.name === name) ?? null;
}

export async function setDefaultConnection(name: string | null): Promise<Config> {
  const cfg = await loadConfig();
  if (name !== null) {
    const exists = cfg.connections.some((c) => c.name === name);
    if (!exists) throw new Error(`Connection "${name}" not found`);
  }
  const next: Config = { ...cfg };
  if (name === null) delete (next as { defaultConnection?: string }).defaultConnection;
  else next.defaultConnection = name;
  await saveConfig(next);
  return next;
}

export async function getDefaultConnectionName(): Promise<string | null> {
  const cfg = await loadConfig();
  return cfg.defaultConnection ?? null;
}

export async function resolveConnection(explicit: string | undefined): Promise<Connection | null> {
  if (explicit) return getConnection(explicit);
  const def = await getDefaultConnectionName();
  return def ? getConnection(def) : null;
}
