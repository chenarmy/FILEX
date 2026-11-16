import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { failure, success } from '@/api/common';
import { validateConnectionProfile } from '@/domain/connections';
import { useKeysStore } from '@/stores/keys';
import { useProxiesStore } from '@/stores/proxies';
import type {
  CreateConnectionProfileInput,
  ProxyPreflightResult,
  ProxyProfile,
  SshKeyEntry,
  SshKeyMetadataInspection,
} from '@/types/contracts';

const mockKeysApi = vi.hoisted(() => ({
  selectLibraryKeyFile: vi.fn(),
  listSshKeys: vi.fn(),
  inspectSshKeyFile: vi.fn(),
  registerSshKey: vi.fn(),
  rotateSshKey: vi.fn(),
  countSshKeyReferences: vi.fn(),
  deleteSshKey: vi.fn(),
}));

const mockProxiesApi = vi.hoisted(() => ({
  listProxyProfiles: vi.fn(),
  createProxyProfile: vi.fn(),
  updateProxyProfile: vi.fn(),
  countProxyReferences: vi.fn(),
  deleteProxyProfile: vi.fn(),
  testProxyProfile: vi.fn(),
}));

vi.mock('@/api/domain/keysApi', () => mockKeysApi);
vi.mock('@/api/domain/proxiesApi', () => mockProxiesApi);

const baseProfileInput: CreateConnectionProfileInput = {
  name: 'edge-host',
  group: 'Ops',
  host: '10.20.0.15',
  port: 22,
  username: 'ops',
  environment: 'production',
  tags: ['edge'],
  authenticationMethod: 'private_key',
  identityFile: null,
  keyId: 'key-1',
  proxyProfileId: 'proxy-1',
  proxyJump: null,
  proxyJumpProfileIds: [],
};

function makeKeyEntry(overrides: Partial<SshKeyEntry> = {}): SshKeyEntry {
  return {
    id: 'key-1',
    label: 'Ops Ed25519',
    keyPath: 'C:/Users/test/.ssh/id_ed25519',
    algorithm: 'ssh-ed25519',
    fingerprintSha256: 'SHA256:abc123',
    hasPassphrase: false,
    passphraseRef: null,
    createdAt: '2026-11-15T00:00:00Z',
    updatedAt: '2026-11-15T00:00:00Z',
    ...overrides,
  };
}

function makeProxyProfile(overrides: Partial<ProxyProfile> = {}): ProxyProfile {
  return {
    id: 'proxy-1',
    label: 'Corp SOCKS5',
    kind: 'socks5',
    host: '127.0.0.1',
    port: 1080,
    username: 'proxyuser',
    hasPassword: true,
    credentialRef: 'proxy:proxy-1',
    createdAt: '2026-11-15T00:00:00Z',
    updatedAt: '2026-11-15T00:00:00Z',
    ...overrides,
  };
}

describe('central SSH key and outbound proxy library', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  it('rejects combining outbound proxyProfileId with proxyJump or jump profile ids', () => {
    expect(validateConnectionProfile(baseProfileInput)).toBeNull();

    const conflictWithIds = validateConnectionProfile({
      ...baseProfileInput,
      proxyProfileId: 'proxy-1',
      proxyJumpProfileIds: ['jump-1'],
    });
    expect(conflictWithIds).toMatchObject({
      code: 'PROFILE_VALIDATION_FAILED',
      messageKey: 'profile.proxyAndJumpConflict',
      field: 'proxyProfileId',
    });

    const conflictWithImportedJump = validateConnectionProfile({
      ...baseProfileInput,
      proxyProfileId: 'proxy-1',
      proxyJump: 'bastion.internal',
    });
    expect(conflictWithImportedJump).toMatchObject({
      messageKey: 'profile.proxyAndJumpConflict',
      field: 'proxyProfileId',
    });
  });

  it('manages key registration, inspection, rotation, reference counting, and deletion in store', async () => {
    const store = useKeysStore();
    const initial = makeKeyEntry();
    const rotated = makeKeyEntry({
      algorithm: 'rsa-sha2-512',
      fingerprintSha256: 'SHA256:rotated',
      hasPassphrase: true,
      passphraseRef: 'ssh-key:key-1',
    });
    const inspected: SshKeyMetadataInspection = {
      algorithm: 'ssh-ed25519',
      fingerprintSha256: 'SHA256:abc123',
      encrypted: true,
      supported: true,
    };

    mockKeysApi.listSshKeys.mockResolvedValueOnce(success([]));
    await store.refresh();
    expect(store.entries).toEqual([]);

    mockKeysApi.inspectSshKeyFile.mockResolvedValueOnce(success(inspected));
    expect(await store.inspectFile(initial.keyPath, 'pass')).toEqual(inspected);

    mockKeysApi.registerSshKey.mockResolvedValueOnce(success(initial));
    mockKeysApi.listSshKeys.mockResolvedValueOnce(success([initial]));
    expect(await store.register({
      label: initial.label,
      keyPath: initial.keyPath,
      passphrase: null,
      savePassphrase: false,
    })).toEqual(initial);
    expect(store.entries).toHaveLength(1);

    mockKeysApi.rotateSshKey.mockResolvedValueOnce(success(rotated));
    mockKeysApi.listSshKeys.mockResolvedValueOnce(success([rotated]));
    expect(await store.rotate({
      keyId: initial.id,
      label: rotated.label,
      newKeyPath: rotated.keyPath,
      passphrase: 'secret',
      savePassphrase: true,
    })).toEqual(rotated);
    expect(store.entries[0]?.hasPassphrase).toBe(true);

    mockKeysApi.countSshKeyReferences.mockResolvedValueOnce(success(2));
    expect(await store.referenceCount(initial.id)).toBe(2);

    mockKeysApi.deleteSshKey.mockResolvedValueOnce(success(null));
    mockKeysApi.listSshKeys.mockResolvedValueOnce(success([]));
    expect(await store.remove(initial.id)).toBe(true);
    expect(store.entries).toEqual([]);
  });

  it('manages proxy CRUD, preflight diagnostics, reference count, and deletion cleanup', async () => {
    const store = useProxiesStore();
    const initial = makeProxyProfile();
    const updated = makeProxyProfile({ kind: 'http_connect', port: 8080 });
    const preflight: ProxyPreflightResult = {
      ok: true,
      latencyMs: 12,
      detailCode: 'PROXY_REACHABLE',
    };

    mockProxiesApi.createProxyProfile.mockResolvedValueOnce(success(initial));
    mockProxiesApi.listProxyProfiles.mockResolvedValueOnce(success([initial]));
    expect(await store.create({
      label: initial.label,
      kind: initial.kind,
      host: initial.host,
      port: initial.port,
      username: initial.username,
      password: 'pw',
      savePassword: true,
    })).toEqual(initial);
    expect(store.entries).toHaveLength(1);

    mockProxiesApi.updateProxyProfile.mockResolvedValueOnce(success(updated));
    mockProxiesApi.listProxyProfiles.mockResolvedValueOnce(success([updated]));
    await store.update({
      id: updated.id,
      label: updated.label,
      kind: updated.kind,
      host: updated.host,
      port: updated.port,
      username: updated.username,
      password: null,
      savePassword: false,
      clearPassword: false,
    });
    expect(store.entries[0]?.port).toBe(8080);

    mockProxiesApi.testProxyProfile.mockResolvedValueOnce(success(preflight));
    expect(await store.runTest(updated.id)).toEqual(preflight);
    expect(store.testResults[updated.id]).toEqual(preflight);

    mockProxiesApi.countProxyReferences.mockResolvedValueOnce(success(1));
    expect(await store.referenceCount(updated.id)).toBe(1);

    mockProxiesApi.deleteProxyProfile.mockResolvedValueOnce(success(null));
    mockProxiesApi.listProxyProfiles.mockResolvedValueOnce(success([]));
    expect(await store.remove(updated.id)).toBe(true);
    expect(store.entries).toEqual([]);
    expect(store.testResults[updated.id]).toBeUndefined();
  });

  it('surfaces structured errors cleanly when key or proxy calls fail', async () => {
    const keysStore = useKeysStore();
    mockKeysApi.registerSshKey.mockResolvedValueOnce(failure({
      code: 'SSH_KEY_UNSUPPORTED',
      messageKey: 'errors.sshKeyUnsupported',
      retryable: false,
      remoteState: 'not_applicable',
    }));

    expect(await keysStore.register({
      label: 'Bad',
      keyPath: '/bad/key',
      passphrase: null,
      savePassphrase: false,
    })).toBeNull();
    expect(keysStore.error?.code).toBe('SSH_KEY_UNSUPPORTED');
  });
});
