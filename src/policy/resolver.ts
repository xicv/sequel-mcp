import type { Connection, PartialPolicy, Policy, PolicyAction, SqlCategory } from '../types.js';

const ACTION_RANK: Record<PolicyAction, number> = { allow: 0, confirm: 1, deny: 2 };

function actionForCategory(p: Policy | PartialPolicy, category: SqlCategory): PolicyAction | undefined {
  switch (category) {
    case 'read': return p.read;
    case 'write': return p.write;
    case 'ddl': return p.ddl;
    case 'admin': return p.admin;
    case 'txCtrl': return p.txCtrl;
  }
}

export interface ResolvedPolicy {
  effective: Policy;
  action: PolicyAction;
  contributingDatabase: string | null;
  contributingDatabases: string[];
}

function mergePolicy(baseline: Policy, override: PartialPolicy): Policy {
  return { ...baseline, ...override } satisfies Policy;
}

function effectiveDatabases(args: {
  connection: Connection;
  targetDatabases: string[];
  fallbackDatabase?: string;
}): string[] {
  if (args.targetDatabases.length > 0) return args.targetDatabases;
  const fallback = args.fallbackDatabase ?? args.connection.database;
  return fallback ? [fallback] : [];
}

export function resolveEffectivePolicy(args: {
  connection: Connection;
  category: SqlCategory;
  targetDatabases: string[];
  fallbackDatabase?: string;
}): ResolvedPolicy {
  const baseline = args.connection.policy;
  const dbOverrides = args.connection.databasePolicies ?? {};
  const dbs = effectiveDatabases(args);

  if (dbs.length === 0) {
    const action = actionForCategory(baseline, args.category) ?? 'deny';
    return {
      effective: baseline,
      action,
      contributingDatabase: null,
      contributingDatabases: [],
    };
  }

  const firstDb = dbs[0]!;
  const firstOverride = dbOverrides[firstDb];
  const firstEffective = firstOverride ? mergePolicy(baseline, firstOverride) : baseline;
  let strictAction: PolicyAction = actionForCategory(firstEffective, args.category) ?? 'deny';
  let strictDb: string = firstDb;
  let strictPolicy: Policy = firstEffective;

  for (let i = 1; i < dbs.length; i++) {
    const db = dbs[i]!;
    const override = dbOverrides[db];
    const effective = override ? mergePolicy(baseline, override) : baseline;
    const a = actionForCategory(effective, args.category) ?? 'deny';
    if (ACTION_RANK[a] > ACTION_RANK[strictAction]) {
      strictAction = a;
      strictDb = db;
      strictPolicy = effective;
    }
  }

  return {
    effective: strictPolicy,
    action: strictAction,
    contributingDatabase: strictDb,
    contributingDatabases: dbs,
  };
}
