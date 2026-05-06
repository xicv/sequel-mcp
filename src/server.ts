import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import {
  ConnectionSchema,
  POLICY_PRESETS,
  PolicySchema,
  PolicyConfirmationDeclinedError,
  PolicyDeniedError,
  type Connection,
  type PolicyPresetName,
} from './types.js';
import { classifyStatement } from './policy/classifier.js';
import { evaluatePolicy } from './policy/gate.js';
import {
  getConnection,
  getDefaultConnectionName,
  loadConfig,
  policyFromPreset,
  removeConnectionByName,
  resolveConnection,
  setDefaultConnection,
  upsertConnection,
} from './vault/config.js';
import { KeychainSecretStore, type SecretStore } from './vault/keyring.js';
import { SessionAuthenticator, getTouchID } from './vault/touchid.js';
import { executeStatement } from './sql/executor.js';
import { importFromSequelAce } from './importer/sequelAcePlist.js';
import { makeConfirmFn } from './elicit/confirm.js';

const PACKAGE_NAME = 'sequel-ace-mcp';
const PACKAGE_VERSION = '0.1.0';

function toolError(text: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text }] };
}

function jsonResult(value: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

function textResult(text: string): CallToolResult {
  return { content: [{ type: 'text', text }] };
}

async function loadCredentials(args: {
  store: SecretStore;
  connection: Connection;
}): Promise<{ password: string; sshPassword?: string } | null> {
  const password = await args.store.getPassword(args.connection.name, args.connection.user);
  if (!password) return null;
  let sshPassword: string | undefined;
  if (args.connection.ssh) {
    const got = await args.store.getPassword(
      `${args.connection.name}::ssh`,
      args.connection.ssh.user,
    );
    if (got) sshPassword = got;
  }
  return { password, sshPassword };
}

export interface AppOptions {
  secretStore?: SecretStore;
}

export function buildServer(opts: AppOptions = {}): McpServer {
  const mcp = new McpServer(
    { name: PACKAGE_NAME, version: PACKAGE_VERSION },
    {
      capabilities: {
        tools: {},
        prompts: {},
        resources: {},
        logging: {},
      },
    },
  );

  const secretStore: SecretStore = opts.secretStore ?? new KeychainSecretStore();
  const confirmFn = makeConfirmFn(mcp.server);
  const auth = new SessionAuthenticator({ available: false, prompt: async () => false });
  void getTouchID().then((tid) => {
    Object.assign(auth, new SessionAuthenticator(tid));
  });

  registerTools(mcp, { secretStore, confirmFn, auth });
  registerPrompts(mcp);
  registerResources(mcp, { secretStore });

  return mcp;
}

interface ToolDeps {
  secretStore: SecretStore;
  confirmFn: ReturnType<typeof makeConfirmFn>;
  auth: SessionAuthenticator;
}

function registerTools(mcp: McpServer, deps: ToolDeps): void {
  mcp.registerTool(
    'list_connections',
    {
      title: 'List configured connections',
      description: 'Return all connections configured in the local config (no passwords).',
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      inputSchema: {},
    },
    async () => {
      const cfg = await loadConfig();
      const sanitized = cfg.connections.map((c) => ({
        name: c.name,
        host: c.host,
        port: c.port,
        user: c.user,
        database: c.database,
        ssl: c.ssl,
        ssh: c.ssh ? { host: c.ssh.host, user: c.ssh.user, port: c.ssh.port } : null,
        policy: c.policy,
        isDefault: c.name === cfg.defaultConnection,
        hasStoredPassword: undefined as boolean | undefined,
      }));
      for (const item of sanitized) {
        item.hasStoredPassword = await deps.secretStore.hasPassword(item.name, item.user);
      }
      return jsonResult({ defaultConnection: cfg.defaultConnection ?? null, connections: sanitized });
    },
  );

  const queryShape = {
    connection: z
      .string()
      .min(1)
      .optional()
      .describe('Configured connection name. Omit to use the default connection set via set_default_connection.'),
    sql: z.string().min(1).describe('Single SQL statement (multi-statement input rejected)'),
    database: z.string().optional().describe('Override default database'),
  };

  mcp.registerTool(
    'query',
    {
      title: 'Run a read-only SQL query',
      description:
        'Run a single read-only SQL statement (SELECT/SHOW/DESCRIBE/EXPLAIN). Wrapped in START TRANSACTION READ ONLY. Server-side enforced even if the connection user has write privileges.',
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: queryShape,
    },
    async (args) => {
      return runSqlTool({ ...deps, args, expectReadOnly: true });
    },
  );

  mcp.registerTool(
    'execute',
    {
      title: 'Execute a write/DDL/admin SQL statement',
      description:
        'Run a non-read SQL statement (INSERT/UPDATE/DELETE/DDL/admin). Subject to the connection policy: write/ddl/admin may be allow|confirm|deny. Confirm triggers a user elicitation.',
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
      inputSchema: queryShape,
    },
    async (args) => {
      return runSqlTool({ ...deps, args, expectReadOnly: false });
    },
  );

  mcp.registerTool(
    'describe_table',
    {
      title: 'Describe a table',
      description: 'Run DESCRIBE <table>. Always read-only.',
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      inputSchema: {
        connection: z.string().min(1).optional(),
        database: z.string().optional(),
        table: z.string().min(1).regex(/^[A-Za-z0-9_]+$/, 'identifier-safe table name'),
      },
    },
    async (args) => {
      const sql = args.database
        ? `DESCRIBE \`${args.database}\`.\`${args.table}\``
        : `DESCRIBE \`${args.table}\``;
      return runSqlTool({
        ...deps,
        args: { connection: args.connection, sql, database: args.database },
        expectReadOnly: true,
      });
    },
  );

  mcp.registerTool(
    'list_databases',
    {
      title: 'List databases',
      description: 'SHOW DATABASES on the given connection.',
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      inputSchema: { connection: z.string().min(1).optional() },
    },
    async (args) => {
      return runSqlTool({
        ...deps,
        args: { connection: args.connection, sql: 'SHOW DATABASES' },
        expectReadOnly: true,
      });
    },
  );

  mcp.registerTool(
    'add_connection',
    {
      title: 'Add or update a connection',
      description:
        'Persist a connection. The password is captured via elicitation and stored in the macOS Keychain; it never appears in tool arguments or logs.',
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: {
        name: z.string().min(1).max(128),
        host: z.string().min(1),
        port: z.number().int().min(1).max(65535).default(3306),
        user: z.string().min(1),
        database: z.string().optional(),
        ssl: z.boolean().default(false),
        policyPreset: z.enum(['read-only', 'dev', 'admin']).default('read-only'),
        sshHost: z.string().optional(),
        sshPort: z.number().int().min(1).max(65535).optional(),
        sshUser: z.string().optional(),
        sshKeyPath: z.string().optional(),
      },
    },
    async (args) => {
      const passwordReply = await mcp.server.elicitInput({
        mode: 'form',
        message: `Enter MySQL/MariaDB password for ${args.user}@${args.host}:${args.port}. Stored in macOS Keychain (service "${PACKAGE_NAME} : ${args.name}").`,
        requestedSchema: {
          type: 'object',
          properties: {
            password: {
              type: 'string',
              title: 'Password',
              description: 'Stored locally in macOS Keychain',
            },
          },
          required: ['password'],
        },
      });
      if (passwordReply.action !== 'accept' || typeof passwordReply.content?.['password'] !== 'string') {
        return toolError('Password capture cancelled. Connection not saved.');
      }
      const password = passwordReply.content['password'];

      const ssh =
        args.sshHost && args.sshUser
          ? {
              host: args.sshHost,
              port: args.sshPort ?? 22,
              user: args.sshUser,
              authMethod: args.sshKeyPath ? ('key' as const) : ('password' as const),
              privateKeyPath: args.sshKeyPath,
            }
          : undefined;

      const connection = ConnectionSchema.parse({
        name: args.name,
        host: args.host,
        port: args.port,
        user: args.user,
        database: args.database,
        ssl: args.ssl,
        ssh,
        policy: policyFromPreset(args.policyPreset as PolicyPresetName),
      });

      await upsertConnection(connection);
      await deps.secretStore.setPassword(connection.name, connection.user, password);

      return textResult(
        `Saved connection "${connection.name}" with policy preset "${args.policyPreset}". Password stored in macOS Keychain.`,
      );
    },
  );

  mcp.registerTool(
    'remove_connection',
    {
      title: 'Remove a connection',
      description: 'Delete the connection from config and its Keychain password.',
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: { name: z.string().min(1) },
    },
    async (args) => {
      const c = await getConnection(args.name);
      if (!c) return toolError(`Connection "${args.name}" not found`);
      await deps.secretStore.deletePassword(c.name, c.user);
      if (c.ssh) {
        await deps.secretStore.deletePassword(`${c.name}::ssh`, c.ssh.user);
      }
      await removeConnectionByName(args.name);
      return textResult(`Removed connection "${args.name}".`);
    },
  );

  mcp.registerTool(
    'set_policy',
    {
      title: 'Update a connection policy',
      description:
        'Change the action set (read|write|ddl|admin|txCtrl → allow|confirm|deny) and limits for an existing connection.',
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: {
        name: z.string().min(1),
        policy: z.object({
          read: z.enum(['allow', 'confirm', 'deny']).optional(),
          write: z.enum(['allow', 'confirm', 'deny']).optional(),
          ddl: z.enum(['allow', 'confirm', 'deny']).optional(),
          admin: z.enum(['allow', 'confirm', 'deny']).optional(),
          txCtrl: z.enum(['allow', 'confirm', 'deny']).optional(),
          rowCap: z.number().int().positive().optional(),
          stmtTimeoutMs: z.number().int().positive().optional(),
          requireTouchID: z.boolean().optional(),
        }),
      },
    },
    async (args) => {
      const c = await getConnection(args.name);
      if (!c) return toolError(`Connection "${args.name}" not found`);
      const merged = PolicySchema.parse({ ...c.policy, ...args.policy });
      await upsertConnection({ ...c, policy: merged });
      return jsonResult({ name: c.name, policy: merged });
    },
  );

  mcp.registerTool(
    'doctor',
    {
      title: 'Diagnostic report',
      description:
        'Print a sanitized JSON diagnostic of the MCP install: runtime versions, config file presence, Touch ID availability, every configured connection (host/user/db, password presence, SSH key file presence, policy). Contains zero passwords and zero secrets — safe to paste into a bug report.',
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      inputSchema: {},
    },
    async () => {
      const cfg = await loadConfig();
      const def = cfg.defaultConnection ?? null;
      const tid = await getTouchID();
      const conns = await Promise.all(
        cfg.connections.map(async (c) => ({
          name: c.name,
          host: c.host,
          port: c.port,
          user: c.user,
          database: c.database ?? null,
          ssl: c.ssl,
          isDefault: c.name === def,
          hasStoredPassword: await deps.secretStore.hasPassword(c.name, c.user),
          ssh: c.ssh
            ? {
                host: c.ssh.host,
                port: c.ssh.port,
                user: c.ssh.user,
                authMethod: c.ssh.authMethod,
                privateKeyPath: c.ssh.privateKeyPath ?? null,
              }
            : null,
          policy: c.policy,
        })),
      );
      return jsonResult({
        app: 'sequel-ace-mcp',
        version: PACKAGE_VERSION,
        runtime: {
          node: process.versions.node,
          platform: process.platform,
          arch: process.arch,
        },
        touchID: { available: tid.available },
        defaultConnection: def,
        connections: conns,
        note: 'no passwords or Keychain secrets included; hostnames/usernames/key paths ARE included — redact before posting publicly.',
      });
    },
  );

  mcp.registerTool(
    'set_default_connection',
    {
      title: 'Set the default connection',
      description:
        'Mark a saved connection as the default. Subsequent query/execute/list_databases/describe_table calls without an explicit "connection" arg will use it. Pass an empty string to clear.',
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: {
        name: z.string().describe('Connection name, or empty string to clear the default.'),
      },
    },
    async (args) => {
      try {
        if (args.name === '') {
          await setDefaultConnection(null);
          return textResult('Default connection cleared.');
        }
        await setDefaultConnection(args.name);
        return textResult(`Default connection is now "${args.name}".`);
      } catch (e) {
        return toolError((e as Error).message);
      }
    },
  );

  mcp.registerTool(
    'get_default_connection',
    {
      title: 'Get the default connection',
      description: 'Return the connection name currently used when "connection" arg is omitted.',
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      inputSchema: {},
    },
    async () => {
      const name = await getDefaultConnectionName();
      return jsonResult({ defaultConnection: name });
    },
  );

  mcp.registerTool(
    'select_database',
    {
      title: 'Set the default database on a connection',
      description:
        'Update a saved connection so that subsequent query/execute calls default to this database when no per-call override is supplied. Does not require the password.',
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: {
        connection: z.string().min(1).optional(),
        database: z
          .string()
          .min(1)
          .max(64)
          .regex(/^[A-Za-z0-9_$]+$/, 'identifier-safe database name'),
      },
    },
    async (args) => {
      const c = await resolveConnection(args.connection);
      if (!c) return toolError(noConnectionMessage(args.connection));
      await upsertConnection({ ...c, database: args.database });
      return textResult(
        `Default database for "${c.name}" set to "${args.database}". Per-call database overrides still take precedence.`,
      );
    },
  );

  mcp.registerTool(
    'import_from_sequel_ace',
    {
      title: 'Import connections from Sequel Ace',
      description:
        'Read Sequel Ace Favorites.plist, copy connections (and optionally passwords via /usr/bin/security; macOS will prompt user to allow access) into our config + keychain. Sequel Ace data is never modified.',
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: { copyPasswords: z.boolean().default(true) },
    },
    async (args) => {
      const result = await importFromSequelAce({
        copyPasswords: args.copyPasswords,
        secretStore: deps.secretStore,
      });
      return jsonResult(result);
    },
  );
}

function noConnectionMessage(explicit: string | undefined): string {
  return explicit
    ? `Unknown connection "${explicit}". Use list_connections to see available names.`
    : 'No connection specified and no default set. Pass "connection" or call set_default_connection first.';
}

async function runSqlTool(params: {
  secretStore: SecretStore;
  confirmFn: ReturnType<typeof makeConfirmFn>;
  auth: SessionAuthenticator;
  args: { connection?: string; sql: string; database?: string };
  expectReadOnly: boolean;
}): Promise<CallToolResult> {
  const { args, secretStore, confirmFn, auth, expectReadOnly } = params;
  const conn = await resolveConnection(args.connection);
  if (!conn) return toolError(noConnectionMessage(args.connection));

  const classified = classifyStatement(args.sql);
  if (!classified.ok) return toolError(`Cannot run statement: ${classified.error}`);

  if (expectReadOnly && classified.category !== 'read') {
    return toolError(
      `query tool only accepts read statements (got ${classified.category}). Use the "execute" tool for non-read statements.`,
    );
  }

  if (conn.policy.requireTouchID) {
    const ok = await auth.ensureAuthenticated(
      `Authenticate to run ${classified.category} on ${conn.name}`,
    );
    if (!ok) return toolError('Touch ID authentication failed.');
  }

  try {
    await evaluatePolicy({
      policy: conn.policy,
      category: classified.category,
      statement: args.sql,
      connectionName: conn.name,
      elicitConfirm: confirmFn,
    });
  } catch (e) {
    if (e instanceof PolicyDeniedError) {
      return toolError(`Denied by policy: ${classified.category} statements not allowed on "${conn.name}".`);
    }
    if (e instanceof PolicyConfirmationDeclinedError) {
      return toolError('User declined confirmation. Statement not executed.');
    }
    throw e;
  }

  const creds = await loadCredentials({ store: secretStore, connection: conn });
  if (!creds) {
    return toolError(
      `No password stored for connection "${conn.name}". Run add_connection or import_from_sequel_ace first.`,
    );
  }

  try {
    const result = await executeStatement({
      connection: conn,
      password: creds.password,
      sshPassword: creds.sshPassword,
      sql: args.sql,
      category: classified.category,
      policy: conn.policy,
      database: args.database,
    });
    return jsonResult({
      connection: conn.name,
      category: classified.category,
      rows: result.rows,
      fields: result.fields,
      affectedRows: result.affectedRows,
      truncated: result.truncated,
      rowCap: conn.policy.rowCap,
      durationMs: result.durationMs,
    });
  } catch (e) {
    return toolError(`SQL execution failed: ${(e as Error).message}`);
  }
}

function registerPrompts(mcp: McpServer): void {
  mcp.registerPrompt(
    'setup-connection',
    {
      title: 'Set up a new database connection',
      description:
        'Walks through host, port, user, database, then asks for a password via elicitation and stores it in the macOS Keychain.',
      argsSchema: {
        suggestedName: z.string().optional(),
      },
    },
    (args) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text:
              `I want to add a new MySQL/MariaDB connection${args.suggestedName ? ` called "${args.suggestedName}"` : ''}.\n\n` +
              `Use the "add_connection" tool. Ask me for: name, host, port (default 3306), user, database (optional), ssl (default false), policy preset (read-only | dev | admin), and optional SSH tunnel (host/port/user/keyPath). The tool will then prompt me for the password via elicitation. Do NOT include the password in the tool arguments — the tool collects it through the secure elicitation channel.`,
          },
        },
      ],
    }),
  );

  mcp.registerPrompt(
    'analyze-table',
    {
      title: 'Analyze a table',
      description: 'Read-only investigation: schema, row count, indexes, sample rows.',
      argsSchema: { connection: z.string(), database: z.string().optional(), table: z.string() },
    },
    (args) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text:
              `Analyze table \`${args.table}\`${args.database ? ` in database \`${args.database}\`` : ''} on connection "${args.connection}". ` +
              `Use only read-only tools: describe_table, list_databases, and query (SELECT/SHOW only). Specifically: ` +
              `1) describe schema, 2) SHOW INDEX FROM the table, 3) SELECT COUNT(*), 4) SELECT * LIMIT 5. Summarize findings.`,
          },
        },
      ],
    }),
  );
}

function registerResources(
  mcp: McpServer,
  deps: { secretStore: SecretStore },
): void {
  mcp.registerResource(
    'connections',
    'sequel-ace-mcp://connections',
    {
      title: 'Configured connections',
      description: 'JSON listing of saved connections (no secrets).',
      mimeType: 'application/json',
    },
    async () => {
      const cfg = await loadConfig();
      const items = await Promise.all(
        cfg.connections.map(async (c) => ({
          name: c.name,
          host: c.host,
          port: c.port,
          user: c.user,
          database: c.database,
          ssh: c.ssh ? { host: c.ssh.host, user: c.ssh.user } : null,
          policy: c.policy,
          presets: Object.keys(POLICY_PRESETS),
          hasPassword: await deps.secretStore.hasPassword(c.name, c.user),
        })),
      );
      return {
        contents: [
          {
            uri: 'sequel-ace-mcp://connections',
            mimeType: 'application/json',
            text: JSON.stringify({ connections: items }, null, 2),
          },
        ],
      };
    },
  );
}
