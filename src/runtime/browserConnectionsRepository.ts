import { createRequestId, failure, success } from '@/api/common';
import { validateConnectionProfile } from '@/domain/connections';
import type {
  ConnectionProfile,
  CreateConnectionProfileInput,
  OperationResult,
} from '@/types/contracts';

const storageKey = 'filex.connection-profiles.v1';

const seedProfiles: ConnectionProfile[] = [
  {
    id: 'prod-api-01',
    name: 'prod-api-01',
    group: '生产环境',
    host: '10.24.0.18',
    port: 22,
    username: 'deploy',
    environment: 'production',
    favorite: true,
    tags: ['api', 'primary'],
    credentialRef: null,
    state: 'connected',
    latencyMs: 38,
    lastUsedAt: '2026-11-01T08:45:00+08:00',
  },
  {
    id: 'worker-canary',
    name: 'worker-canary',
    group: '生产环境',
    host: '10.24.1.33',
    port: 22,
    username: 'ops',
    environment: 'production',
    favorite: false,
    tags: ['worker', 'canary'],
    credentialRef: null,
    state: 'idle',
    latencyMs: null,
    lastUsedAt: '2026-10-31T17:20:00+08:00',
  },
  {
    id: 'staging-web',
    name: 'staging-web',
    group: '预发布环境',
    host: '172.18.3.12',
    port: 22,
    username: 'ubuntu',
    environment: 'staging',
    favorite: true,
    tags: ['web'],
    credentialRef: null,
    state: 'degraded',
    latencyMs: 86,
    lastUsedAt: '2026-10-30T10:08:00+08:00',
  },
  {
    id: 'dev-sandbox',
    name: 'dev-sandbox',
    group: '开发环境',
    host: '192.168.56.21',
    port: 22,
    username: 'developer',
    environment: 'development',
    favorite: false,
    tags: ['sandbox'],
    credentialRef: null,
    state: 'idle',
    latencyMs: null,
    lastUsedAt: null,
  },
];

export function listBrowserProfiles(): Promise<OperationResult<ConnectionProfile[]>> {
  const requestId = createRequestId();
  try {
    return Promise.resolve(success(readProfiles(), requestId));
  } catch {
    return Promise.resolve(failure({
      code: 'PROFILE_STORAGE_UNAVAILABLE',
      messageKey: 'errors.profileStorageUnavailable',
      retryable: true,
      remoteState: 'not_applicable',
    }, requestId));
  }
}

export function createBrowserProfile(
  input: CreateConnectionProfileInput,
): Promise<OperationResult<ConnectionProfile>> {
  const requestId = createRequestId();
  const validationError = validateConnectionProfile(input);
  if (validationError) return Promise.resolve(failure(validationError, requestId));

  try {
    const profiles = readProfiles();
    const profile: ConnectionProfile = {
      ...input,
      id: createRequestId(),
      name: input.name.trim(),
      host: input.host.trim(),
      username: input.username.trim(),
      group: input.group.trim() || '未分组',
      tags: input.tags.map((tag) => tag.trim()).filter(Boolean),
      favorite: false,
      credentialRef: null,
      state: 'idle',
      latencyMs: null,
      lastUsedAt: null,
    };
    const next = [...profiles, profile];
    localStorage.setItem(storageKey, JSON.stringify(next));
    return Promise.resolve(success(profile, requestId));
  } catch {
    return Promise.resolve(failure({
      code: 'PROFILE_STORAGE_WRITE_FAILED',
      messageKey: 'errors.profileStorageWriteFailed',
      retryable: true,
      remoteState: 'not_applicable',
    }, requestId));
  }
}

function readProfiles(): ConnectionProfile[] {
  const raw = localStorage.getItem(storageKey);
  if (!raw) {
    localStorage.setItem(storageKey, JSON.stringify(seedProfiles));
    return structuredClone(seedProfiles);
  }
  return JSON.parse(raw) as ConnectionProfile[];
}
