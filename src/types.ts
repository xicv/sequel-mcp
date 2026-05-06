import { z } from 'zod';

export const SQL_CATEGORIES = ['read', 'write', 'ddl', 'admin', 'txCtrl'] as const;
export type SqlCategory = (typeof SQL_CATEGORIES)[number];

export const POLICY_ACTIONS = ['allow', 'confirm', 'deny'] as const;
export type PolicyAction = (typeof POLICY_ACTIONS)[number];

export const PolicySchema = z.object({
  read: z.enum(POLICY_ACTIONS).default('allow'),
  write: z.enum(POLICY_ACTIONS).default('confirm'),
  ddl: z.enum(POLICY_ACTIONS).default('deny'),
  admin: z.enum(POLICY_ACTIONS).default('deny'),
  txCtrl: z.enum(POLICY_ACTIONS).default('allow'),
  rowCap: z.number().int().positive().max(100000).default(1000),
  stmtTimeoutMs: z.number().int().positive().max(600000).default(10000),
  requireTouchID: z.boolean().default(false),
});

export type Policy = z.infer<typeof PolicySchema>;

export const SshTunnelSchema = z.object({
  host: z.string().min(1),
  port: z.number().int().positive().max(65535).default(22),
  user: z.string().min(1),
  authMethod: z.enum(['password', 'key']).default('key'),
  privateKeyPath: z.string().optional(),
});

export type SshTunnel = z.infer<typeof SshTunnelSchema>;

export const ConnectionSchema = z.object({
  name: z.string().min(1).max(128).regex(/^[A-Za-z0-9 _\-:.]+$/),
  host: z.string().min(1),
  port: z.number().int().positive().max(65535).default(3306),
  user: z.string().min(1),
  database: z.string().optional(),
  ssl: z.boolean().default(false),
  ssh: SshTunnelSchema.optional(),
  policy: PolicySchema,
});

export type Connection = z.infer<typeof ConnectionSchema>;

export const ConfigSchema = z.object({
  version: z.literal(1).default(1),
  connections: z.array(ConnectionSchema).default([]),
  defaultConnection: z.string().optional(),
});

export type Config = z.infer<typeof ConfigSchema>;

export const POLICY_PRESETS = {
  'read-only': {
    read: 'allow',
    write: 'deny',
    ddl: 'deny',
    admin: 'deny',
    txCtrl: 'allow',
    rowCap: 1000,
    stmtTimeoutMs: 10000,
    requireTouchID: false,
  },
  dev: {
    read: 'allow',
    write: 'confirm',
    ddl: 'confirm',
    admin: 'deny',
    txCtrl: 'allow',
    rowCap: 5000,
    stmtTimeoutMs: 30000,
    requireTouchID: false,
  },
  admin: {
    read: 'allow',
    write: 'confirm',
    ddl: 'confirm',
    admin: 'confirm',
    txCtrl: 'allow',
    rowCap: 5000,
    stmtTimeoutMs: 60000,
    requireTouchID: true,
  },
} as const satisfies Record<string, Policy>;

export type PolicyPresetName = keyof typeof POLICY_PRESETS;

export class PolicyDeniedError extends Error {
  constructor(
    public readonly category: SqlCategory,
    public readonly statementSnippet: string,
  ) {
    super(`Policy denies ${category} statements on this connection: ${statementSnippet}`);
    this.name = 'PolicyDeniedError';
  }
}

export class PolicyConfirmationDeclinedError extends Error {
  constructor(public readonly category: SqlCategory) {
    super(`User declined confirmation for ${category} statement`);
    this.name = 'PolicyConfirmationDeclinedError';
  }
}

export class ClassifierError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClassifierError';
  }
}
