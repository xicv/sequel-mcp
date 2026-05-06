import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { Client, type ConnectConfig } from 'ssh2';
import type { SshTunnel } from '../types.js';

function expandTilde(p: string): string {
  if (!p.startsWith('~')) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

export interface TunnelHandle {
  localHost: string;
  localPort: number;
  close(): Promise<void>;
}

export async function openSshTunnel(args: {
  ssh: SshTunnel;
  sshPassword?: string;
  remoteHost: string;
  remotePort: number;
}): Promise<TunnelHandle> {
  const { ssh } = args;
  const client = new Client();
  const sshConfig: ConnectConfig = {
    host: ssh.host,
    port: ssh.port,
    username: ssh.user,
    readyTimeout: 15000,
  };
  if (ssh.authMethod === 'password') {
    if (!args.sshPassword) throw new Error('SSH tunnel requires password but none was supplied');
    sshConfig.password = args.sshPassword;
  } else {
    if (!ssh.privateKeyPath) throw new Error('SSH tunnel requires privateKeyPath');
    const keyPath = expandTilde(ssh.privateKeyPath);
    sshConfig.privateKey = await fs.readFile(keyPath);
    if (args.sshPassword) sshConfig.passphrase = args.sshPassword;
  }

  await new Promise<void>((resolve, reject) => {
    client.once('ready', () => resolve());
    client.once('error', reject);
    client.connect(sshConfig);
  });

  const server = net.createServer((socket) => {
    client.forwardOut(
      '127.0.0.1',
      0,
      args.remoteHost,
      args.remotePort,
      (err, stream) => {
        if (err) {
          socket.destroy(err);
          return;
        }
        socket.pipe(stream).pipe(socket);
      },
    );
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') {
    throw new Error('failed to acquire local tunnel address');
  }

  return {
    localHost: '127.0.0.1',
    localPort: addr.port,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      client.end();
    },
  };
}
