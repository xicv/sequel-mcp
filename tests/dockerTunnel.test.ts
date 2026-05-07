import { describe, expect, it } from 'vitest';
import {
  buildBridgeCommand,
  type BuildBridgeArgs,
} from '../src/sql/dockerTunnel.js';
import { SshDockerSchema, SshTunnelSchema, ConnectionSchema, PolicySchema } from '../src/types.js';

describe('buildBridgeCommand', () => {
  const base: BuildBridgeArgs = {
    container: 'mysql-prod',
    bridgeTool: 'nc',
    remoteHost: '127.0.0.1',
    remotePort: 3306,
  };

  it('produces nc form', () => {
    expect(buildBridgeCommand(base)).toBe('docker exec -i mysql-prod nc 127.0.0.1 3306');
  });

  it('produces socat form', () => {
    expect(buildBridgeCommand({ ...base, bridgeTool: 'socat' })).toBe(
      'docker exec -i mysql-prod socat - TCP:127.0.0.1:3306',
    );
  });

  it('produces ncat form', () => {
    expect(buildBridgeCommand({ ...base, bridgeTool: 'ncat' })).toBe(
      'docker exec -i mysql-prod ncat 127.0.0.1 3306',
    );
  });

  it.each([
    'mysql; rm -rf /',
    'mysql && evil',
    'mysql$(whoami)',
    'mysql`pwd`',
    'mysql|cat',
    'mysql prod',
    "mysql'name",
    'mysql"name',
    '../escape',
    '-startsWithDash',
    '',
  ])('rejects malicious container name: %s', (bad) => {
    expect(() => buildBridgeCommand({ ...base, container: bad })).toThrow(/invalid container/);
  });

  it.each([
    '127.0.0.1; nc evil 9999',
    'host with space',
    'host$injected',
    'host`cmd`',
    'host|pipe',
    '',
  ])('rejects malicious remote host: %s', (bad) => {
    expect(() => buildBridgeCommand({ ...base, remoteHost: bad })).toThrow(/invalid remote host/);
  });

  it.each([0, -1, 65536, 1.5, Number.NaN])('rejects invalid port: %s', (bad) => {
    expect(() => buildBridgeCommand({ ...base, remotePort: bad })).toThrow(/invalid remote port/);
  });

  it('rejects unknown bridge tool', () => {
    expect(() =>
      buildBridgeCommand({ ...base, bridgeTool: 'bash' as 'nc' }),
    ).toThrow(/invalid bridge tool/);
  });

  it('accepts hostnames with hyphens and dots', () => {
    expect(
      buildBridgeCommand({ ...base, remoteHost: 'db.internal-net.example.com' }),
    ).toBe('docker exec -i mysql-prod nc db.internal-net.example.com 3306');
  });

  it('accepts container names with dots/underscores', () => {
    expect(
      buildBridgeCommand({ ...base, container: 'project_db.v2' }),
    ).toBe('docker exec -i project_db.v2 nc 127.0.0.1 3306');
  });
});

describe('SshDockerSchema', () => {
  it('parses minimal config with default bridgeTool', () => {
    const r = SshDockerSchema.parse({ container: 'mysql' });
    expect(r.container).toBe('mysql');
    expect(r.bridgeTool).toBe('nc');
  });

  it('rejects shell metacharacters in container', () => {
    expect(() => SshDockerSchema.parse({ container: 'mysql;evil' })).toThrow();
    expect(() => SshDockerSchema.parse({ container: 'mysql evil' })).toThrow();
    expect(() => SshDockerSchema.parse({ container: 'mysql$x' })).toThrow();
  });

  it('rejects unknown bridge tool', () => {
    expect(() =>
      SshDockerSchema.parse({ container: 'mysql', bridgeTool: 'bash' }),
    ).toThrow();
  });

  it('accepts all three valid bridge tools', () => {
    for (const tool of ['nc', 'socat', 'ncat'] as const) {
      const r = SshDockerSchema.parse({ container: 'mysql', bridgeTool: tool });
      expect(r.bridgeTool).toBe(tool);
    }
  });
});

describe('SshTunnelSchema backward compatibility', () => {
  it('parses tunnel config with no docker field (existing users)', () => {
    const r = SshTunnelSchema.parse({
      host: 'jump.example.com',
      user: 'deploy',
      authMethod: 'key',
      privateKeyPath: '~/.ssh/id_rsa',
    });
    expect(r.docker).toBeUndefined();
    expect(r.host).toBe('jump.example.com');
    expect(r.port).toBe(22);
  });

  it('parses tunnel config with docker field (new users)', () => {
    const r = SshTunnelSchema.parse({
      host: 'jump.example.com',
      user: 'deploy',
      authMethod: 'key',
      privateKeyPath: '~/.ssh/id_rsa',
      docker: { container: 'mysql' },
    });
    expect(r.docker?.container).toBe('mysql');
    expect(r.docker?.bridgeTool).toBe('nc');
  });
});

describe('ConnectionSchema with docker (end-to-end)', () => {
  it('round-trips a connection with docker tunnel', () => {
    const c = ConnectionSchema.parse({
      name: 'prod-mysql',
      host: '127.0.0.1',
      port: 3306,
      user: 'root',
      ssl: false,
      ssh: {
        host: 'jump.example.com',
        port: 22,
        user: 'deploy',
        authMethod: 'key',
        privateKeyPath: '~/.ssh/id_rsa',
        docker: { container: 'mysql_prod', bridgeTool: 'socat' },
      },
      policy: PolicySchema.parse({}),
    });
    expect(c.ssh?.docker?.container).toBe('mysql_prod');
    expect(c.ssh?.docker?.bridgeTool).toBe('socat');
  });

  it('legacy connection (no docker) still parses', () => {
    const c = ConnectionSchema.parse({
      name: 'legacy',
      host: 'db.internal',
      port: 3306,
      user: 'root',
      ssl: false,
      ssh: {
        host: 'jump.example.com',
        port: 22,
        user: 'deploy',
        authMethod: 'key',
        privateKeyPath: '~/.ssh/id_rsa',
      },
      policy: PolicySchema.parse({}),
    });
    expect(c.ssh?.docker).toBeUndefined();
  });
});
