import { createRequestId, failure, success } from '@/api/common';
import { validateConnectionProfile } from '@/domain/connections';
import type {
  AppError,
  ConnectionProfile,
  CreateConnectionProfileInput,
  OperationResult,
  UpdateConnectionProfileInput,
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
    authenticationMethod: 'password',
    identityFile: null,
    proxyJump: null,
    proxyJumpProfileIds: [],
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
    authenticationMethod: 'agent',
    identityFile: null,
    proxyJump: null,
    proxyJumpProfileIds: [],
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
    authenticationMethod: 'private_key',
    identityFile: '~/.ssh/id_ed25519',
    proxyJump: null,
    proxyJumpProfileIds: [],
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
    authenticationMethod: 'password',
    identityFile: null,
    proxyJump: null,
    proxyJumpProfileIds: [],
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
    const routeError = validateBrowserJumpRoute(profiles, input);
    if (routeError) return Promise.resolve(failure(routeError, requestId));
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

export function updateBrowserProfile(
  id: string,
  input: UpdateConnectionProfileInput,
): Promise<OperationResult<ConnectionProfile>> {
  const requestId = createRequestId();
  const validationError = validateConnectionProfile(input);
  if (validationError) return Promise.resolve(failure(validationError, requestId));
  const profiles = readProfiles();
  const index = profiles.findIndex((profile) => profile.id === id);
  if (index < 0) return Promise.resolve(failure(notFoundError(), requestId));
  const existing = profiles[index];
  if (!existing) return Promise.resolve(failure(notFoundError(), requestId));
  const usedAsJump = profiles.some((profile) => profile.id !== id && profile.proxyJumpProfileIds.includes(id));
  if (usedAsJump && (input.proxyJumpProfileIds.length > 0 || input.proxyJump?.trim())) {
    return Promise.resolve(failure(jumpRouteError(
      'PROFILE_PROXY_JUMP_NESTED_PROFILE',
      'profile.proxyJumpNestedProfile',
    ), requestId));
  }
  const routeError = validateBrowserJumpRoute(profiles, input, id);
  if (routeError) return Promise.resolve(failure(routeError, requestId));
  const updated: ConnectionProfile = {
    ...existing,
    ...input,
    name: input.name.trim(),
    group: input.group.trim() || '未分组',
    host: input.host.trim(),
    username: input.username.trim(),
    tags: [...new Set(input.tags.map((tag) => tag.trim()).filter(Boolean))],
  };
  profiles[index] = updated;
  localStorage.setItem(storageKey, JSON.stringify(profiles));
  return Promise.resolve(success(updated, requestId));
}

export function duplicateBrowserProfile(id: string): Promise<OperationResult<ConnectionProfile>> {
  const requestId = createRequestId();
  const profiles = readProfiles();
  const source = profiles.find((profile) => profile.id === id);
  if (!source) return Promise.resolve(failure(notFoundError(), requestId));
  const duplicate: ConnectionProfile = {
    ...source,
    id: createRequestId(),
    name: `${source.name} Copy`,
    favorite: false,
    credentialRef: null,
    state: 'idle',
    latencyMs: null,
    lastUsedAt: null,
  };
  localStorage.setItem(storageKey, JSON.stringify([...profiles, duplicate]));
  return Promise.resolve(success(duplicate, requestId));
}

export function deleteBrowserProfile(id: string): Promise<OperationResult<null>> {
  const requestId = createRequestId();
  const profiles = readProfiles();
  if (!profiles.some((profile) => profile.id === id)) {
    return Promise.resolve(failure(notFoundError(), requestId));
  }
  if (profiles.some((profile) => profile.proxyJumpProfileIds.includes(id))) {
    return Promise.resolve(failure(jumpRouteError('PROFILE_USED_AS_JUMP', 'profile.usedAsJump'), requestId));
  }
  localStorage.setItem(storageKey, JSON.stringify(profiles.filter((profile) => profile.id !== id)));
  return Promise.resolve(success(null, requestId));
}

function notFoundError() {
  return {
    code: 'PROFILE_NOT_FOUND',
    messageKey: 'errors.profileNotFound',
    retryable: false,
    remoteState: 'not_applicable' as const,
  };
}

function validateBrowserJumpRoute(
  profiles: ConnectionProfile[],
  input: CreateConnectionProfileInput,
  destinationId?: string,
): AppError | null {
  for (const jumpProfileId of input.proxyJumpProfileIds) {
    if (jumpProfileId === destinationId) {
      return jumpRouteError('PROFILE_PROXY_JUMP_ROUTE_INVALID', 'profile.proxyJumpRouteInvalid');
    }
    const jumpProfile = profiles.find((profile) => profile.id === jumpProfileId);
    if (!jumpProfile) return jumpRouteError('PROFILE_PROXY_JUMP_PROFILE_NOT_FOUND', 'profile.proxyJumpProfileNotFound');
    if (jumpProfile.proxyJumpProfileIds.length > 0 || jumpProfile.proxyJump?.trim()) {
      return jumpRouteError('PROFILE_PROXY_JUMP_NESTED_PROFILE', 'profile.proxyJumpNestedProfile');
    }
  }
  return null;
}

function jumpRouteError(code: string, messageKey: string): AppError {
  return {
    code,
    messageKey,
    retryable: false,
    remoteState: 'not_applicable',
    field: 'proxyJumpProfileIds',
  };
}

function readProfiles(): ConnectionProfile[] {
  const raw = localStorage.getItem(storageKey);
  if (!raw) {
    localStorage.setItem(storageKey, JSON.stringify(seedProfiles));
    return structuredClone(seedProfiles);
  }
  const profiles = JSON.parse(raw) as Partial<ConnectionProfile>[];
  return profiles.map((profile) => ({
    ...profile,
    authenticationMethod: profile.authenticationMethod ?? 'password',
    identityFile: profile.identityFile ?? null,
    proxyJump: profile.proxyJump ?? null,
    proxyJumpProfileIds: profile.proxyJumpProfileIds ?? [],
  })) as ConnectionProfile[];
}
