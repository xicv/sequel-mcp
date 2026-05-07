import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { Client, type ConnectConfig } from 'ssh2';
import type { SshTunnel, SshDocker } from '../types.js';
import type { TunnelHandle } from './tunnel.js';
import { buildHostVerifier, loadKnownHosts } from './sshHostKey.js';

const CONTAINER_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const HOST_RE = /^[A-Za-z0-9.\-]{1,253}$/;
const VALID_TOOLS = new Set<'socat' | 'nc' | 'ncat'>(['socat', 'nc', 'ncat']);

function expandTilde(p: string): string {
  if (!p.startsWith('~')) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

export interface DockerTunnelHandle extends TunnelHandle {
  containerImage: string;
  containerStartedAt: string;
}

export interface BuildBridgeArgs {
  container: string;
  bridgeTool: 'socat' | 'nc' | 'ncat';
  remoteHost: string;
  remotePort: number;
}

export function buildBridgeCommand(args: BuildBridgeArgs): string {
  if (!CONTAINER_RE.test(args.container)) {
    throw new Error(`invalid container name: ${args.container}`);
  }
  if (!HOST_RE.test(args.remoteHost)) {
    throw new Error(`invalid remote host: ${args.remoteHost}`);
  }
  if (!VALID_TOOLS.has(args.bridgeTool)) {
    throw new Error(`invalid bridge tool: ${args.bridgeTool}`);
  }
  if (
    !Number.isInteger(args.remotePort) ||
    args.remotePort < 1 ||
    args.remotePort > 65535
  ) {
    throw new Error(`invalid remote port: ${args.remotePort}`);
  }
  const c = args.container;
  const h = args.remoteHost;
  const p = args.remotePort;
  switch (args.bridgeTool) {
    case 'socat':
      return `docker exec -i ${c} socat - TCP:${h}:${p}`;
    case 'nc':
      return `docker exec -i ${c} nc ${h} ${p}`;
    case 'ncat':
      return `docker exec -i ${c} ncat ${h} ${p}`;
  }
}

interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

function execAndCapture(client: Client, cmd: string, timeoutMs = 10000): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`command timed out after ${timeoutMs}ms: ${cmd}`)),
      timeoutMs,
    );
    client.exec(cmd, (err, stream) => {
      if (err) {
        clearTimeout(timer);
        reject(err);
        return;
      }
      const out: Buffer[] = [];
      const errBufs: Buffer[] = [];
      stream.on('data', (d: Buffer) => out.push(d));
      stream.stderr.on('data', (d: Buffer) => errBufs.push(d));
      stream.on('close', (code: number | null) => {
        clearTimeout(timer);
        resolve({
          code: code ?? 0,
          stdout: Buffer.concat(out).toString('utf8'),
          stderr: Buffer.concat(errBufs).toString('utf8'),
        });
      });
    });
  });
}

export async function inspectContainer(
  client: Client,
  container: string,
): Promise<{ image: string; startedAt: string; running: boolean }> {
  if (!CONTAINER_RE.test(container)) {
    throw new Error(`invalid container name: ${container}`);
  }
  const cmd = `docker inspect --format '{{.Config.Image}}|{{.State.StartedAt}}|{{.State.Running}}' ${container}`;
  const r = await execAndCapture(client, cmd, 8000);
  if (r.code !== 0) {
    throw new Error(
      `docker inspect failed (exit ${r.code}): ${r.stderr.trim() || r.stdout.trim() || '<no output>'}`,
    );
  }
  const parts = r.stdout.trim().split('|');
  const image = parts[0] ?? '<unknown>';
  const startedAt = parts[1] ?? '<unknown>';
  const running = (parts[2] ?? '').trim() === 'true';
  if (!running) {
    throw new Error(`container ${container} is not running`);
  }
  return { image, startedAt, running };
}

export async function assertBridgeToolPresent(
  client: Client,
  container: string,
  tool: 'socat' | 'nc' | 'ncat',
): Promise<void> {
  if (!CONTAINER_RE.test(container)) {
    throw new Error(`invalid container name: ${container}`);
  }
  if (!VALID_TOOLS.has(tool)) {
    throw new Error(`invalid bridge tool: ${tool}`);
  }
  const cmd = `docker exec ${container} sh -c 'command -v ${tool}'`;
  const r = await execAndCapture(client, cmd, 8000);
  if (r.code !== 0 || r.stdout.trim() === '') {
    throw new Error(
      `bridge tool '${tool}' not found in container '${container}'. Install ${tool} in the image, or pick a different bridgeTool.`,
    );
  }
}

export async function openSshDockerTunnel(args: {
  ssh: SshTunnel;
  sshPassword?: string;
  docker: SshDocker;
  remoteHost: string;
  remotePort: number;
}): Promise<DockerTunnelHandle> {
  const { ssh, docker } = args;
  const client = new Client();
  const policy = ssh.hostKeyPolicy ?? 'lenient';
  const entries = await loadKnownHosts(ssh.knownHostsPath);
  const sshConfig: ConnectConfig = {
    host: ssh.host,
    port: ssh.port,
    username: ssh.user,
    readyTimeout: 15000,
    hostVerifier: buildHostVerifier({
      policy,
      host: ssh.host,
      port: ssh.port,
      entries,
      log: (msg) => process.stderr.write(`[sequel-mcp] ${msg}\n`),
    }),
  };
  if (ssh.authMethod === 'password') {
    if (!args.sshPassword) {
      throw new Error('SSH tunnel requires password but none was supplied');
    }
    sshConfig.password = args.sshPassword;
  } else {
    if (!ssh.privateKeyPath) {
      throw new Error('SSH tunnel requires privateKeyPath');
    }
    const keyPath = expandTilde(ssh.privateKeyPath);
    sshConfig.privateKey = await fs.readFile(keyPath);
    if (args.sshPassword) sshConfig.passphrase = args.sshPassword;
  }

  await new Promise<void>((resolve, reject) => {
    client.once('ready', () => resolve());
    client.once('error', reject);
    client.connect(sshConfig);
  });

  let info: { image: string; startedAt: string };
  try {
    info = await inspectContainer(client, docker.container);
    await assertBridgeToolPresent(client, docker.container, docker.bridgeTool);
  } catch (e) {
    client.end();
    throw e;
  }

  const cmd = buildBridgeCommand({
    container: docker.container,
    bridgeTool: docker.bridgeTool,
    remoteHost: args.remoteHost,
    remotePort: args.remotePort,
  });

  const server = net.createServer((socket) => {
    client.exec(cmd, (err, stream) => {
      if (err) {
        socket.destroy(err);
        return;
      }
      socket.pipe(stream).pipe(socket);
      stream.on('close', () => socket.destroy());
      stream.stderr.on('data', () => {
        /* swallow bridge tool stderr */
      });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') {
    client.end();
    throw new Error('failed to acquire local docker tunnel address');
  }

  return {
    localHost: '127.0.0.1',
    localPort: addr.port,
    containerImage: info.image,
    containerStartedAt: info.startedAt,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      client.end();
    },
  };
}
