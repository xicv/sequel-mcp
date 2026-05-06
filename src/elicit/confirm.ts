import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SqlCategory } from '../types.js';

type ServerHandle = McpServer['server'];

const CATEGORY_LABEL: Record<SqlCategory, string> = {
  read: 'read',
  write: 'WRITE',
  ddl: 'DDL (schema-changing)',
  admin: 'ADMIN',
  txCtrl: 'transaction control',
};

export function makeConfirmFn(server: ServerHandle) {
  return async (args: {
    category: SqlCategory;
    statement: string;
    connectionName: string;
  }): Promise<boolean> => {
    const snippet =
      args.statement.length > 800
        ? `${args.statement.slice(0, 800)}…`
        : args.statement;

    try {
      const result = await server.elicitInput({
        mode: 'form',
        message:
          `About to run a ${CATEGORY_LABEL[args.category]} statement on connection "${args.connectionName}".\n\n` +
          `--- SQL ---\n${snippet}\n--- end ---\n\n` +
          `Type CONFIRM (uppercase, exact) to proceed. Anything else cancels.`,
        requestedSchema: {
          type: 'object',
          properties: {
            confirm: {
              type: 'string',
              title: 'Confirmation',
              description: 'Type CONFIRM to authorize this statement',
            },
          },
          required: ['confirm'],
        },
      });

      if (result.action !== 'accept') return false;
      const value = result.content?.['confirm'];
      return typeof value === 'string' && value === 'CONFIRM';
    } catch {
      return false;
    }
  };
}
