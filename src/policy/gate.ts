import {
  PolicyConfirmationDeclinedError,
  PolicyDeniedError,
  type Policy,
  type PolicyAction,
  type SqlCategory,
} from '../types.js';

export interface ElicitConfirmFn {
  (params: {
    category: SqlCategory;
    statement: string;
    connectionName: string;
  }): Promise<boolean>;
}

export interface PolicyDecision {
  category: SqlCategory;
  action: PolicyAction;
  confirmed: boolean;
}

function actionForCategory(policy: Policy, category: SqlCategory): PolicyAction {
  switch (category) {
    case 'read':
      return policy.read;
    case 'write':
      return policy.write;
    case 'ddl':
      return policy.ddl;
    case 'admin':
      return policy.admin;
    case 'txCtrl':
      return policy.txCtrl;
  }
}

export async function evaluatePolicy(args: {
  policy: Policy;
  category: SqlCategory;
  statement: string;
  connectionName: string;
  elicitConfirm: ElicitConfirmFn;
}): Promise<PolicyDecision> {
  const action = actionForCategory(args.policy, args.category);
  if (action === 'deny') {
    throw new PolicyDeniedError(args.category, args.statement.slice(0, 200));
  }
  if (action === 'allow') {
    return { category: args.category, action, confirmed: false };
  }
  const accepted = await args.elicitConfirm({
    category: args.category,
    statement: args.statement,
    connectionName: args.connectionName,
  });
  if (!accepted) {
    throw new PolicyConfirmationDeclinedError(args.category);
  }
  return { category: args.category, action, confirmed: true };
}
