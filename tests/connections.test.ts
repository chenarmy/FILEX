import { describe, expect, it } from 'vitest';
import { filterProfiles, validateConnectionProfile } from '@/domain/connections';
import type { ConnectionProfile, CreateConnectionProfileInput } from '@/types/contracts';

const validInput: CreateConnectionProfileInput = {
  name: 'api-production',
  group: 'Production',
  host: 'api.example.internal',
  port: 22,
  username: 'deploy',
  environment: 'production',
  tags: ['api'],
  authenticationMethod: 'password',
  identityFile: null,
  proxyJump: null,
  proxyJumpProfileIds: [],
};

const profile: ConnectionProfile = {
  ...validInput,
  id: 'profile-1',
  favorite: true,
  credentialRef: null,
  state: 'idle',
  latencyMs: null,
  lastUsedAt: null,
};

describe('connection profile rules', () => {
  it('accepts a non-secret profile', () => {
    expect(validateConnectionProfile(validInput)).toBeNull();
  });

  it('rejects an invalid port with a structured field error', () => {
    const error = validateConnectionProfile({ ...validInput, port: 70_000 });
    expect(error).toMatchObject({
      code: 'PROFILE_VALIDATION_FAILED',
      field: 'port',
      remoteState: 'not_applicable',
    });
  });

  it('filters by host, group, username, environment and tags', () => {
    expect(filterProfiles([profile], 'example.internal')).toHaveLength(1);
    expect(filterProfiles([profile], 'Production')).toHaveLength(1);
    expect(filterProfiles([profile], 'deploy')).toHaveLength(1);
    expect(filterProfiles([profile], 'missing')).toHaveLength(0);
  });
});
