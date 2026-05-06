import { describe, expect, it, vi } from 'vitest';
import { evaluatePolicy } from '../src/policy/gate.js';
import { PolicySchema, PolicyDeniedError, PolicyConfirmationDeclinedError } from '../src/types.js';

const policy = PolicySchema.parse({});

describe('evaluatePolicy', () => {
  it('allows read by default without prompt', async () => {
    const elicit = vi.fn();
    const decision = await evaluatePolicy({
      policy,
      category: 'read',
      statement: 'SELECT 1',
      connectionName: 'x',
      elicitConfirm: elicit,
    });
    expect(decision.action).toBe('allow');
    expect(elicit).not.toHaveBeenCalled();
  });

  it('confirms write and proceeds when user accepts', async () => {
    const elicit = vi.fn(async () => true);
    const decision = await evaluatePolicy({
      policy,
      category: 'write',
      statement: 'UPDATE t SET x = 1',
      connectionName: 'x',
      elicitConfirm: elicit,
    });
    expect(decision.action).toBe('confirm');
    expect(decision.confirmed).toBe(true);
    expect(elicit).toHaveBeenCalledOnce();
  });

  it('rejects when user declines confirmation', async () => {
    const elicit = vi.fn(async () => false);
    await expect(
      evaluatePolicy({
        policy,
        category: 'write',
        statement: 'UPDATE t SET x = 1',
        connectionName: 'x',
        elicitConfirm: elicit,
      }),
    ).rejects.toBeInstanceOf(PolicyConfirmationDeclinedError);
  });

  it('denies DDL by default without prompt', async () => {
    const elicit = vi.fn();
    await expect(
      evaluatePolicy({
        policy,
        category: 'ddl',
        statement: 'DROP TABLE x',
        connectionName: 'x',
        elicitConfirm: elicit,
      }),
    ).rejects.toBeInstanceOf(PolicyDeniedError);
    expect(elicit).not.toHaveBeenCalled();
  });
});
