import type { AppError, ConnectionProfile, CreateConnectionProfileInput } from '@/types/contracts';

const hostPattern = /^(?=.{1,253}$)(?:\[[0-9a-fA-F:]+\]|[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?)$/;

export function validateConnectionProfile(input: CreateConnectionProfileInput): AppError | null {
  if (input.name.trim().length < 2) {
    return validationError('profile.nameTooShort', 'name');
  }

  if (!hostPattern.test(input.host.trim())) {
    return validationError('profile.hostInvalid', 'host');
  }

  if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65_535) {
    return validationError('profile.portInvalid', 'port');
  }

  if (input.username.trim().length === 0) {
    return validationError('profile.usernameRequired', 'username');
  }

  if (input.proxyJumpProfileIds.length > 4) {
    return validationError('profile.proxyJumpTooManyHops', 'proxyJumpProfileIds');
  }

  if (input.proxyJumpProfileIds.some((id) => !id.trim() || id.trim() !== id)
    || new Set(input.proxyJumpProfileIds).size !== input.proxyJumpProfileIds.length) {
    return validationError('profile.proxyJumpRouteInvalid', 'proxyJumpProfileIds');
  }

  return null;
}

export function filterProfiles(profiles: ConnectionProfile[], query: string): ConnectionProfile[] {
  const normalized = query.trim().toLocaleLowerCase();
  if (normalized.length === 0) return profiles;

  return profiles.filter((profile) => {
    const searchable = [
      profile.name,
      profile.group,
      profile.host,
      profile.username,
      profile.environment,
      ...profile.tags,
    ].join(' ').toLocaleLowerCase();
    return searchable.includes(normalized);
  });
}

export function groupProfiles(profiles: ConnectionProfile[]): Map<string, ConnectionProfile[]> {
  const groups = new Map<string, ConnectionProfile[]>();
  for (const profile of profiles) {
    const group = groups.get(profile.group) ?? [];
    group.push(profile);
    groups.set(profile.group, group);
  }
  return groups;
}

function validationError(messageKey: string, field: string): AppError {
  return {
    code: 'PROFILE_VALIDATION_FAILED',
    messageKey,
    retryable: true,
    remoteState: 'not_applicable',
    field,
  };
}
