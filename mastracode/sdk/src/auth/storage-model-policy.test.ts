import * as fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthStorage } from './storage.js';
import type { OAuthLoginCallbacks } from './types.js';

// Keep every credential-file operation synthetic, including the native-default control.
vi.mock('node:fs', async importOriginal => ({
  ...(await importOriginal<typeof import('node:fs')>()),
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn((path: unknown) => {
    if (typeof path === 'string' && path.endsWith('/package.json')) return '{"version":"0.0.0"}';
    throw new Error('Unexpected credential file read');
  }),
  writeFileSync: vi.fn(() => {
    throw new Error('Unexpected credential file write');
  }),
  mkdirSync: vi.fn(),
  renameSync: vi.fn(),
  chmodSync: vi.fn(),
  rmSync: vi.fn(),
}));
vi.mock('../utils/project.js', () => ({ getAppDataDir: () => '/synthetic-app-data' }));

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.unstubAllEnvs());

function expectNoFileAccess() {
  for (const method of [
    fs.existsSync,
    fs.readFileSync,
    fs.writeFileSync,
    fs.mkdirSync,
    fs.renameSync,
    fs.chmodSync,
    fs.rmSync,
  ]) {
    expect(method).not.toHaveBeenCalled();
  }
}

const editingRefusal = 'Native credential editing is unavailable because the host model policy owns credentials.';

describe('policy-owned credential storage', () => {
  it('constructs, reloads, and reads without opening any credential file', async () => {
    const storage = new AuthStorage(null);
    storage.reload();
    expect(storage.get('synthetic')).toBeUndefined();
    expect(storage.get('toString')).toBeUndefined();
    expect(storage.has('__proto__')).toBe(false);
    expect(storage.list()).toEqual([]);
    expect(storage.has('synthetic')).toBe(false);
    expect(storage.isLoggedIn('synthetic')).toBe(false);
    expect(storage.hasStoredApiKey('synthetic')).toBe(false);
    expect(storage.getStoredApiKey('synthetic')).toBeUndefined();
    expect(storage.listAccounts('synthetic')).toEqual([]);
    expect(storage.getActiveAccount('synthetic')).toBeUndefined();
    expect(await storage.getApiKey('synthetic')).toBeUndefined();
    expect(await storage.getOAuthCredential('synthetic')).toBeUndefined();
    expectNoFileAccess();
  });

  it.each([
    ['set', (storage: AuthStorage) => storage.set('synthetic', { type: 'api_key', key: 'synthetic-value' })],
    ['remove', (storage: AuthStorage) => storage.remove('synthetic')],
    ['logout', (storage: AuthStorage) => storage.logout('synthetic')],
    [
      'setStoredApiKey',
      (storage: AuthStorage) => storage.setStoredApiKey('synthetic', 'synthetic-value', 'SYNTHETIC_POLICY_KEY'),
    ],
    [
      'loadStoredApiKeysIntoEnv',
      (storage: AuthStorage) => storage.loadStoredApiKeysIntoEnv({ synthetic: 'SYNTHETIC_POLICY_KEY' }),
    ],
    ['activateAccount', (storage: AuthStorage) => storage.activateAccount('synthetic', 'account-a')],
    ['removeAccount', (storage: AuthStorage) => storage.removeAccount('synthetic', 'account-a')],
    ['renameAccount', (storage: AuthStorage) => storage.renameAccount('synthetic', 'account-a', 'Renamed')],
  ] as const)('refuses %s before changing state or environment', (_name, mutate) => {
    vi.stubEnv('SYNTHETIC_POLICY_KEY', 'unchanged');
    const storage = new AuthStorage(null);
    expect(() => mutate(storage)).toThrow(editingRefusal);
    expect(storage.list()).toEqual([]);
    expect(process.env.SYNTHETIC_POLICY_KEY).toBe('unchanged');
    expectNoFileAccess();
  });

  it.each(['login', 'addAccount', 'forceRefresh'] as const)('refuses %s before contacting a provider', async method => {
    const storage = new AuthStorage(null);
    const loginCallback = vi.fn();
    const operation =
      method === 'login'
        ? storage.login('anthropic', { onAuth: loginCallback, onPrompt: loginCallback } as OAuthLoginCallbacks)
        : method === 'addAccount'
          ? storage.addAccount('synthetic', { access: 'synthetic-access', refresh: 'synthetic-refresh', expires: 1 })
          : storage.forceRefreshActiveAccount('synthetic');
    await expect(operation).rejects.toThrow(editingRefusal);
    expect(loginCallback).not.toHaveBeenCalled();
    expect(storage.list()).toEqual([]);
    expectNoFileAccess();
  });

  it('preserves the file-backed constructor when its argument is omitted', () => {
    new AuthStorage();
    expect(fs.existsSync).toHaveBeenCalledWith('/synthetic-app-data/auth.json');
    expect(fs.readFileSync).not.toHaveBeenCalled();
    expect(fs.writeFileSync).not.toHaveBeenCalled();
  });
});
