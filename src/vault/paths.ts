import os from 'node:os';
import path from 'node:path';

export const APP_NAME = 'sequel-ace-mcp';
export const KEYCHAIN_SERVICE_PREFIX = 'sequel-ace-mcp';

export function configDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  return xdg
    ? path.join(xdg, APP_NAME)
    : path.join(os.homedir(), '.config', APP_NAME);
}

export function configPath(): string {
  return path.join(configDir(), 'config.json');
}

export function keychainServiceName(connectionName: string): string {
  return `${KEYCHAIN_SERVICE_PREFIX} : ${connectionName}`;
}

export function sequelAceFavoritesPlistPath(): string {
  return path.join(
    os.homedir(),
    'Library',
    'Containers',
    'com.sequel-ace.sequel-ace',
    'Data',
    'Library',
    'Application Support',
    'Sequel Ace',
    'Data',
    'Favorites.plist',
  );
}

export function sequelAceLegacyKeychainServiceName(
  favoriteName: string,
  favoriteId: number | string,
): string {
  return `Sequel Ace : ${favoriteName} (${favoriteId})`;
}

export function sequelAceLegacySshKeychainServiceName(
  favoriteName: string,
  favoriteId: number | string,
): string {
  return `Sequel Ace SSHTunnel : ${favoriteName} (${favoriteId})`;
}
