import { Entry } from '@napi-rs/keyring';
import { keychainServiceName } from './paths.js';

export interface SecretStore {
  setPassword(connectionName: string, account: string, password: string): Promise<void>;
  getPassword(connectionName: string, account: string): Promise<string | null>;
  deletePassword(connectionName: string, account: string): Promise<boolean>;
  hasPassword(connectionName: string, account: string): Promise<boolean>;
}

export class KeychainSecretStore implements SecretStore {
  private entry(connectionName: string, account: string): Entry {
    return new Entry(keychainServiceName(connectionName), account);
  }

  async setPassword(connectionName: string, account: string, password: string): Promise<void> {
    this.entry(connectionName, account).setPassword(password);
  }

  async getPassword(connectionName: string, account: string): Promise<string | null> {
    try {
      return this.entry(connectionName, account).getPassword();
    } catch {
      return null;
    }
  }

  async deletePassword(connectionName: string, account: string): Promise<boolean> {
    try {
      return this.entry(connectionName, account).deletePassword();
    } catch {
      return false;
    }
  }

  async hasPassword(connectionName: string, account: string): Promise<boolean> {
    return (await this.getPassword(connectionName, account)) !== null;
  }
}

export class InMemorySecretStore implements SecretStore {
  private readonly store = new Map<string, string>();

  private key(connectionName: string, account: string): string {
    return `${keychainServiceName(connectionName)}::${account}`;
  }

  async setPassword(connectionName: string, account: string, password: string): Promise<void> {
    this.store.set(this.key(connectionName, account), password);
  }

  async getPassword(connectionName: string, account: string): Promise<string | null> {
    return this.store.get(this.key(connectionName, account)) ?? null;
  }

  async deletePassword(connectionName: string, account: string): Promise<boolean> {
    return this.store.delete(this.key(connectionName, account));
  }

  async hasPassword(connectionName: string, account: string): Promise<boolean> {
    return this.store.has(this.key(connectionName, account));
  }
}
