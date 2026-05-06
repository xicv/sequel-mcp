import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Parser } = require('node-sql-parser') as typeof import('node-sql-parser');

const parser = new Parser();

interface AstNode {
  type?: unknown;
  value?: unknown;
  [key: string]: unknown;
}

function isPlainObject(v: unknown): v is AstNode {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function redactNode(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(redactNode);
  if (!isPlainObject(node)) return node;
  const out: AstNode = {};
  for (const [k, v] of Object.entries(node)) {
    out[k] = v;
  }
  if (typeof out.type === 'string') {
    switch (out.type) {
      case 'string':
      case 'single_quote_string':
      case 'double_quote_string':
        out.value = '<str>';
        break;
      case 'number':
      case 'bigint':
        out.value = 0;
        break;
      case 'bool':
        out.value = false;
        break;
      case 'hex_string':
        out.value = '<hex>';
        break;
      case 'param':
        out.value = '<param>';
        break;
    }
  }
  for (const [k, v] of Object.entries(out)) {
    if (k === 'value' || k === 'type') continue;
    out[k] = redactNode(v);
  }
  return out;
}

export function redactSql(sql: string): string {
  try {
    const ast = parser.astify(sql, { database: 'mysql' });
    const redacted = redactNode(ast);
    const result = parser.sqlify(redacted as Parameters<typeof parser.sqlify>[0], { database: 'mysql' });
    return typeof result === 'string' ? result : sql;
  } catch {
    return sql.replace(/'(?:[^'\\]|\\.)*'/g, "'<str>'").replace(/\b\d+(\.\d+)?\b/g, '<num>');
  }
}
