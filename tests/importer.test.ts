import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFavoritesPlist } from '../src/importer/sequelAcePlist.js';

const PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Favorites Root</key>
  <dict>
    <key>Name</key>
    <string>Favorites</string>
    <key>Children</key>
    <array>
      <dict>
        <key>id</key><integer>17000001</integer>
        <key>name</key><string>local</string>
        <key>host</key><string>127.0.0.1</string>
        <key>port</key><integer>3306</integer>
        <key>user</key><string>root</string>
        <key>database</key><string>app</string>
        <key>type</key><integer>0</integer>
        <key>useSSL</key><integer>0</integer>
      </dict>
      <dict>
        <key>Name</key>
        <string>Production</string>
        <key>Children</key>
        <array>
          <dict>
            <key>id</key><integer>17000002</integer>
            <key>name</key><string>prod-tunnel</string>
            <key>host</key><string>10.0.0.5</string>
            <key>port</key><integer>3306</integer>
            <key>user</key><string>readonly</string>
            <key>database</key><string>app</string>
            <key>type</key><integer>1</integer>
            <key>sshHost</key><string>bastion.example.com</string>
            <key>sshPort</key><integer>22</integer>
            <key>sshUser</key><string>deploy</string>
            <key>sshKeyLocation</key><string>~/.ssh/id_ed25519</string>
            <key>sshKeyLocationEnabled</key><integer>1</integer>
          </dict>
        </array>
      </dict>
    </array>
  </dict>
</dict>
</plist>
`;

describe('readFavoritesPlist', () => {
  let tmpFile: string;

  beforeEach(async () => {
    tmpFile = path.join(os.tmpdir(), `sequel-ace-mcp-fav-${Date.now()}.plist`);
    await fs.writeFile(tmpFile, PLIST, 'utf8');
  });

  afterEach(async () => {
    await fs.rm(tmpFile, { force: true });
  });

  it('parses flat and nested favorites', async () => {
    const items = await readFavoritesPlist(tmpFile);
    expect(items).toHaveLength(2);
    const names = items.map((i) => i.connection.name).sort();
    expect(names).toEqual(['local', 'prod-tunnel']);
  });

  it('extracts SSH tunnel metadata', async () => {
    const items = await readFavoritesPlist(tmpFile);
    const prod = items.find((i) => i.connection.name === 'prod-tunnel');
    expect(prod?.connection.ssh).toBeDefined();
    expect(prod?.connection.ssh?.host).toBe('bastion.example.com');
    expect(prod?.connection.ssh?.authMethod).toBe('key');
  });

  it('builds correct legacy keychain service names', async () => {
    const items = await readFavoritesPlist(tmpFile);
    const local = items.find((i) => i.connection.name === 'local');
    expect(local?.legacyKeychainService).toBe('Sequel Ace : local (17000001)');
  });

  it('defaults imported policy to read-only preset', async () => {
    const items = await readFavoritesPlist(tmpFile);
    expect(items[0]?.connection.policy.write).toBe('deny');
    expect(items[0]?.connection.policy.read).toBe('allow');
  });
});
