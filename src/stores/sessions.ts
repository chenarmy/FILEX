import { computed, ref, shallowRef } from 'vue';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { defineStore } from 'pinia';
import {
  connectAgentSession,
  connectPrivateKeySession,
  connectPasswordSession,
  connectQuickPasswordSession,
  cancelSessionAttempt,
  disconnectSession,
  listSessions,
  probeQuickSessionHostKey,
  probeSessionHostKey,
  reprobeSessionHostKey,
  resizeTerminal,
  saveProfilePrivateKeyPassphrase,
  saveProfilePassword,
  writeTerminal,
} from '@/api/domain/sessionsApi';
import { isTauriRuntime } from '@/api/common';
import { recordHostTrust } from '@/api/domain/trustApi';
import { useConnectionsStore } from '@/stores/connections';
import { useEventsStore } from '@/stores/events';
import { useTunnelsStore } from '@/stores/tunnels';
import { useSettingsStore } from '@/stores/settings';
import type {
  AppError,
  ConnectionProfile,
  HostKeyChallenge,
  QuickConnectInput,
  SessionSummary,
} from '@/types/contracts';

export const useSessionsStore = defineStore('sessions', () => {
  const summaries = ref<SessionSummary[]>([]);
  const activeSessionId = ref<string | null>(null);
  const challenge = ref<HostKeyChallenge | null>(null);
  const currentRouteProfileId = ref<string | null>(null);
  const pendingConnectionSessionId = ref<string | null>(null);
  const quickProfiles = shallowRef<Record<string, ConnectionProfile>>({});
  const passwordProfileId = ref<string | null>(null);
  const privateKeyPassphraseProfileId = ref<string | null>(null);
  const busy = ref(false);
  const error = ref<AppError | null>(null);
  const outputBuffers = shallowRef<Record<string, Uint8Array[]>>({});
  const outputBufferStarts = shallowRef<Record<string, number>>({});
  const outputRevision = ref(0);
  const sessionCwds = ref<Record<string, string>>({});
  const commandHistory = ref<string[]>([]);
  const COMMAND_HISTORY_LIMIT = 100;
  let unlistenTerminal: UnlistenFn | null = null;
  const autoReconnectInFlight = new Set<string>();
  const suppressAutoReconnect = new Set<string>();
  const activeSession = computed(() => summaries.value.find((item) => item.id === activeSessionId.value) ?? null);

  function profileForId(profileId: string | null | undefined): ConnectionProfile | null {
    if (!profileId) return null;
    return quickProfiles.value[profileId]
      ?? useConnectionsStore().profiles.find((profile) => profile.id === profileId)
      ?? null;
  }

  function profileForSession(session: SessionSummary | null | undefined): ConnectionProfile | null {
    return session ? profileForId(session.profileId) : null;
  }

  function isQuickProfile(profileId: string | null | undefined): boolean {
    return Boolean(profileId && quickProfiles.value[profileId]);
  }

  function bindQuickProfile(profileId: string, input: QuickConnectInput, name: string): void {
    const profile: ConnectionProfile = {
      id: profileId,
      name,
      group: '',
      host: input.host.trim(),
      port: input.port,
      username: input.username.trim(),
      environment: 'development',
      favorite: false,
      tags: [],
      authenticationMethod: 'password',
      identityFile: null,
      proxyJump: null,
      proxyJumpProfileIds: [],
      credentialRef: null,
      state: 'idle',
      latencyMs: null,
      lastUsedAt: null,
    };
    quickProfiles.value = { ...quickProfiles.value, [profileId]: profile };
  }

  function clearQuickProfile(profileId: string | null | undefined): void {
    if (!profileId || !quickProfiles.value[profileId]) return;
    const next = { ...quickProfiles.value };
    delete next[profileId];
    quickProfiles.value = next;
  }

  function markQuickProfileUsed(profileId: string): void {
    const profile = quickProfiles.value[profileId];
    if (!profile) return;
    quickProfiles.value = {
      ...quickProfiles.value,
      [profileId]: {
        ...profile,
        state: 'connected',
        lastUsedAt: new Date().toISOString(),
      },
    };
  }

  function profileSupportError(profile: ConnectionProfile): AppError | null {
    if (profile.authenticationMethod === 'private_key' && !profile.identityFile?.trim()) {
      return {
        code: 'SSH_PRIVATE_KEY_PATH_REQUIRED',
        messageKey: 'profile.privateKeyPathRequired',
        retryable: false,
        remoteState: 'not_applicable',
        field: 'identityFile',
      };
    }
    if (profile.proxyJump?.trim() && profile.proxyJumpProfileIds.length === 0) {
      return {
        code: 'SSH_PROXY_JUMP_MAPPING_REQUIRED',
        messageKey: 'profile.proxyJumpMappingRequired',
        retryable: false,
        remoteState: 'not_applicable',
        field: 'proxyJumpProfileIds',
      };
    }
    if (profile.proxyJumpProfileIds.length > 4) {
      return {
        code: 'SSH_PROXY_JUMP_TOO_MANY_HOPS',
        messageKey: 'profile.proxyJumpTooManyHops',
        retryable: false,
        remoteState: 'not_applicable',
        field: 'proxyJumpProfileIds',
      };
    }
    return null;
  }

  function blockUnsupportedProfile(profile: ConnectionProfile): boolean {
    const unsupported = profileSupportError(profile);
    if (!unsupported) return false;
    error.value = unsupported;
    useEventsStore().record('session', unsupported.code, 'warning', { profileId: profile.id });
    return true;
  }

  function missingProfileError(): AppError {
    return {
      code: 'PROFILE_NOT_FOUND',
      messageKey: 'errors.profileNotFound',
      retryable: false,
      remoteState: 'not_applicable',
    };
  }

  function authenticationMethodMismatchError(): AppError {
    return {
      code: 'SSH_AUTH_METHOD_MISMATCH',
      messageKey: 'errors.sshAuthMethodMismatch',
      retryable: false,
      remoteState: 'not_applicable',
    };
  }

  function upsert(summary: SessionSummary): void {
    const index = summaries.value.findIndex((item) => item.id === summary.id);
    if (index >= 0) summaries.value[index] = summary;
    else summaries.value.push(summary);
    activeSessionId.value = summary.id;
  }

  async function refreshSummary(sessionId: string): Promise<void> {
    const result = await listSessions();
    if (!result.ok) return;
    const refreshed = result.data.find((item) => item.id === sessionId);
    if (!refreshed) {
      summaries.value = summaries.value.filter((item) => item.id !== sessionId);
      if (pendingConnectionSessionId.value === sessionId) {
        clearQuickProfile(challenge.value?.profileId);
        pendingConnectionSessionId.value = null;
        currentRouteProfileId.value = null;
        challenge.value = null;
        passwordProfileId.value = null;
        privateKeyPassphraseProfileId.value = null;
      }
      return;
    }
    const index = summaries.value.findIndex((item) => item.id === sessionId);
    if (index >= 0) summaries.value[index] = refreshed;
    else summaries.value.push(refreshed);
    if (
      pendingConnectionSessionId.value === sessionId
      && ['failed', 'disconnected'].includes(refreshed.state)
    ) {
      clearQuickProfile(challenge.value?.profileId ?? refreshed.profileId);
      pendingConnectionSessionId.value = null;
      currentRouteProfileId.value = null;
      challenge.value = null;
      passwordProfileId.value = null;
      privateKeyPassphraseProfileId.value = null;
    }
  }

  function clearError(): void {
    error.value = null;
  }

  async function begin(profile: ConnectionProfile): Promise<void> {
    if (busy.value) return;
    if (pendingConnectionSessionId.value) await cancelPendingAttempt();
    error.value = null;
    challenge.value = null;
    currentRouteProfileId.value = null;
    pendingConnectionSessionId.value = null;
    passwordProfileId.value = null;
    privateKeyPassphraseProfileId.value = null;
    if (blockUnsupportedProfile(profile)) return;
    busy.value = true;
    try {
      const result = await probeSessionHostKey(profile.id);
      if (!result.ok) {
        error.value = result.error;
        useEventsStore().record('session', result.error.code, 'error', { profileId: profile.id });
        return;
      }
      challenge.value = result.data;
      currentRouteProfileId.value = result.data.profileId;
      pendingConnectionSessionId.value = result.data.session.id;
      upsert(result.data.session);
      useEventsStore().record('security', `HOST_KEY_${result.data.trust.toUpperCase()}`, result.data.trust === 'changed' ? 'warning' : 'info', { sessionId: result.data.session.id });
      if (result.data.trust === 'trusted') {
        const hopProfile = profileForId(result.data.profileId);
        if (hopProfile) {
          challenge.value = null;
          await requestAuthentication(hopProfile);
        }
      }
    } finally {
      busy.value = false;
    }
  }

  async function beginQuick(input: QuickConnectInput): Promise<boolean> {
    if (busy.value) return false;
    if (pendingConnectionSessionId.value) await cancelPendingAttempt();
    error.value = null;
    challenge.value = null;
    currentRouteProfileId.value = null;
    pendingConnectionSessionId.value = null;
    passwordProfileId.value = null;
    privateKeyPassphraseProfileId.value = null;
    busy.value = true;
    try {
      const result = await probeQuickSessionHostKey(input);
      if (!result.ok) {
        error.value = result.error;
        useEventsStore().record('session', result.error.code, 'error');
        return false;
      }
      bindQuickProfile(result.data.profileId, input, result.data.profileName);
      challenge.value = result.data;
      currentRouteProfileId.value = result.data.profileId;
      pendingConnectionSessionId.value = result.data.session.id;
      upsert(result.data.session);
      useEventsStore().record(
        'security',
        `HOST_KEY_${result.data.trust.toUpperCase()}`,
        result.data.trust === 'changed' ? 'warning' : 'info',
        { sessionId: result.data.session.id },
      );
      if (result.data.trust === 'trusted') {
        challenge.value = null;
        const profile = profileForId(result.data.profileId);
        if (profile) await requestAuthentication(profile);
      }
      return true;
    } finally {
      busy.value = false;
    }
  }

  async function reconnectActive(): Promise<void> {
    const session = activeSession.value;
    if (!session) return;
    await reconnectSession(session.id);
  }

  async function reconnectSession(sessionId: string, automatic = false): Promise<void> {
    if (!automatic) suppressAutoReconnect.delete(sessionId);
    const session = summaries.value.find((item) => item.id === sessionId);
    if (!session || busy.value || !['disconnected', 'failed'].includes(session.state)) return;
    const profile = profileForId(session.profileId);
    if (!profile) {
      suppressAutoReconnect.add(sessionId);
      error.value = missingProfileError();
      return;
    }
    if (blockUnsupportedProfile(profile)) {
      suppressAutoReconnect.add(sessionId);
      return;
    }
    busy.value = true;
    error.value = null;
    challenge.value = null;
    currentRouteProfileId.value = null;
    pendingConnectionSessionId.value = null;
    passwordProfileId.value = null;
    privateKeyPassphraseProfileId.value = null;
    try {
      const result = await reprobeSessionHostKey(session.id);
      if (!result.ok) {
        await refreshSummary(session.id);
        error.value = result.error;
        return;
      }
      challenge.value = result.data;
      currentRouteProfileId.value = result.data.profileId;
      pendingConnectionSessionId.value = result.data.session.id;
      upsert(result.data.session);
      if (result.data.trust === 'trusted') {
        const hopProfile = profileForId(result.data.profileId);
        if (hopProfile) {
          challenge.value = null;
          await requestAuthentication(hopProfile);
        }
      }
    } finally {
      busy.value = false;
    }
  }

  async function autoReconnect(sessionId: string): Promise<void> {
    if (autoReconnectInFlight.has(sessionId) || suppressAutoReconnect.has(sessionId)) return;
    const attempts = useSettingsStore().value.reconnectAttempts;
    if (attempts === 0) return;
    autoReconnectInFlight.add(sessionId);
    try {
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        const session = summaries.value.find((item) => item.id === sessionId);
        if (!session || session.state !== 'disconnected' || passwordProfileId.value || privateKeyPassphraseProfileId.value || challenge.value) return;
        const baseDelay = Math.min(8_000, 500 * (2 ** attempt));
        const jitter = 0.75 + Math.random() * 0.5;
        await new Promise<void>((resolve) => window.setTimeout(resolve, baseDelay * jitter));
        await reconnectSession(sessionId, true);
        if (suppressAutoReconnect.has(sessionId)) return;
        const next = summaries.value.find((item) => item.id === sessionId);
        if (next?.state === 'connected' || challenge.value || passwordProfileId.value || privateKeyPassphraseProfileId.value) return;
      }
    } finally {
      autoReconnectInFlight.delete(sessionId);
    }
  }

  async function acceptHostKey(): Promise<void> {
    const current = challenge.value;
    if (!current || busy.value) return;
    const profile = profileForId(current.profileId);
    if (!profile) {
      error.value = missingProfileError();
      await cancelPendingAttempt();
      return;
    }
    if (blockUnsupportedProfile(profile)) {
      challenge.value = null;
      await cancelPendingAttempt();
      return;
    }
    busy.value = true;
    error.value = null;
    try {
      const result = await recordHostTrust({
        host: current.host,
        port: current.port,
        algorithm: current.algorithm,
        fingerprintSha256: current.fingerprintSha256,
        source: 'filex_decision',
        observedAt: new Date().toISOString(),
      });
      if (!result.ok) {
        error.value = result.error;
        return;
      }
      challenge.value = null;
      currentRouteProfileId.value = current.profileId;
      await requestAuthentication(profile);
    } finally {
      busy.value = false;
    }
  }

  async function requestAuthentication(profile: ConnectionProfile): Promise<void> {
    if (blockUnsupportedProfile(profile)) {
      await cancelPendingAttempt();
      return;
    }
    if (profile.authenticationMethod === 'password') {
      if (!profile.credentialRef?.startsWith('password:')) {
        passwordProfileId.value = profile.id;
        return;
      }
    } else if (profile.authenticationMethod === 'private_key') {
      if (profile.credentialRef && !profile.credentialRef.startsWith('key-passphrase:')) {
        privateKeyPassphraseProfileId.value = profile.id;
        return;
      }
    }
    await connectActive();
  }

  async function savePassword(password: string): Promise<void> {
    const profileId = passwordProfileId.value;
    if (!profileId || busy.value) return;
    const profile = profileForId(profileId);
    if (!profile) {
      error.value = missingProfileError();
      await cancelPendingAttempt();
      return;
    }
    if (profile.authenticationMethod !== 'password') {
      error.value = authenticationMethodMismatchError();
      await cancelPendingAttempt();
      return;
    }
    if (blockUnsupportedProfile(profile)) {
      passwordProfileId.value = null;
      await cancelPendingAttempt();
      return;
    }
    if (isQuickProfile(profileId)) {
      const session = summaries.value.find((item) => item.profileId === profileId);
      if (!session) {
        error.value = {
          code: 'SESSION_NOT_FOUND',
          messageKey: 'errors.sessionNotFound',
          retryable: false,
          remoteState: 'not_applicable',
        };
        await cancelPendingAttempt();
        return;
      }
      busy.value = true;
      error.value = null;
      try {
        const result = await connectQuickPasswordSession(session.id, password);
        if (!result.ok) {
          suppressAutoReconnect.add(session.id);
          await refreshSummary(session.id);
          clearQuickProfile(profileId);
          passwordProfileId.value = null;
          challenge.value = null;
          currentRouteProfileId.value = null;
          pendingConnectionSessionId.value = null;
          error.value = result.error;
          return;
        }
        upsert(result.data.session);
        markQuickProfileUsed(profileId);
        passwordProfileId.value = null;
        challenge.value = null;
        currentRouteProfileId.value = null;
        pendingConnectionSessionId.value = null;
        useEventsStore().record('session', 'SSH_CONNECTED', 'success', {
          sessionId: result.data.session.id,
          generation: result.data.session.generation,
        });
        return;
      } finally {
        busy.value = false;
      }
    }
    busy.value = true;
    error.value = null;
    try {
      const result = await saveProfilePassword(profileId, password);
      if (!result.ok) {
        error.value = result.error;
        return;
      }
      useConnectionsStore().replaceProfile(result.data);
      passwordProfileId.value = null;
      await connectActive();
    } finally {
      busy.value = false;
    }
  }

  async function savePrivateKeyPassphrase(passphrase: string): Promise<void> {
    const profileId = privateKeyPassphraseProfileId.value;
    if (!profileId || busy.value) return;
    const profile = profileForId(profileId);
    if (!profile) {
      error.value = missingProfileError();
      await cancelPendingAttempt();
      return;
    }
    if (profile.authenticationMethod !== 'private_key') {
      error.value = authenticationMethodMismatchError();
      await cancelPendingAttempt();
      return;
    }
    if (blockUnsupportedProfile(profile)) {
      privateKeyPassphraseProfileId.value = null;
      await cancelPendingAttempt();
      return;
    }
    busy.value = true;
    error.value = null;
    try {
      const result = await saveProfilePrivateKeyPassphrase(profileId, passphrase);
      if (!result.ok) {
        error.value = result.error;
        return;
      }
      useConnectionsStore().replaceProfile(result.data);
      privateKeyPassphraseProfileId.value = null;
      await connectActive();
    } finally {
      busy.value = false;
    }
  }

  async function connectActive(): Promise<void> {
    const sessionId = pendingConnectionSessionId.value ?? activeSessionId.value;
    if (!sessionId) return;
    const session = summaries.value.find((item) => item.id === sessionId);
    if (!session) return;
    const routeProfileId = currentRouteProfileId.value ?? session.profileId;
    const profile = profileForId(routeProfileId);
    if (!profile) {
      error.value = missingProfileError();
      await cancelPendingAttempt();
      return;
    }
    if (blockUnsupportedProfile(profile)) {
      await cancelPendingAttempt();
      return;
    }
    const connect = profile.authenticationMethod === 'private_key'
      ? connectPrivateKeySession
      : profile.authenticationMethod === 'agent'
        ? connectAgentSession
        : connectPasswordSession;
    const result = await connect(sessionId);
    if (!result.ok) {
      await refreshSummary(sessionId);
      if (
        profile.authenticationMethod === 'password'
        && [
          'CREDENTIAL_NOT_CONFIGURED',
          'CREDENTIAL_TYPE_MISMATCH',
          'CREDENTIAL_NOT_FOUND',
          'CREDENTIAL_REFERENCE_INVALID',
        ].includes(result.error.code)
      ) {
        error.value = null;
        passwordProfileId.value = profile.id;
        return;
      }
      if (
        profile.authenticationMethod === 'private_key'
        && [
          'SSH_PRIVATE_KEY_PASSPHRASE_REQUIRED',
          'CREDENTIAL_TYPE_MISMATCH',
          'CREDENTIAL_NOT_FOUND',
          'CREDENTIAL_REFERENCE_INVALID',
        ].includes(result.error.code)
      ) {
        error.value = null;
        privateKeyPassphraseProfileId.value = profile.id;
        return;
      }
      if (
        profile.authenticationMethod === 'private_key'
        && result.error.code === 'SSH_PRIVATE_KEY_INVALID'
        && profile.credentialRef?.startsWith('key-passphrase:')
      ) {
        error.value = result.error;
        privateKeyPassphraseProfileId.value = profile.id;
        return;
      }
      error.value = result.error;
      return;
    }
    if (result.data.challenge) {
      challenge.value = result.data.challenge;
      currentRouteProfileId.value = result.data.challenge.profileId;
      upsert(result.data.session);
      useEventsStore().record(
        'security',
        `HOST_KEY_${result.data.challenge.trust.toUpperCase()}`,
        result.data.challenge.trust === 'changed' ? 'warning' : 'info',
        { sessionId: result.data.session.id, hopIndex: result.data.challenge.hopIndex },
      );
      if (result.data.challenge.trust === 'trusted') {
        const nextProfile = useConnectionsStore().profiles.find((item) => item.id === result.data.challenge?.profileId);
        if (nextProfile) {
          challenge.value = null;
          await requestAuthentication(nextProfile);
        }
      }
      return;
    }
    if (!result.data.connected) return;
    upsert(result.data.session);
    if (isQuickProfile(result.data.session.profileId)) {
      markQuickProfileUsed(result.data.session.profileId);
    }
    challenge.value = null;
    currentRouteProfileId.value = null;
    pendingConnectionSessionId.value = null;
    await useConnectionsStore().load();
    useEventsStore().record('session', 'SSH_CONNECTED', 'success', { sessionId: result.data.session.id, generation: result.data.session.generation });
    void useTunnelsStore().autoStartForSession(result.data.session.id, result.data.session.profileId);
  }

  async function disconnectActive(): Promise<void> {
    if (!activeSessionId.value || busy.value) return;
    const disconnectedId = activeSessionId.value;
    const quickProfileId = summaries.value.find((item) => item.id === disconnectedId)?.profileId;
    suppressAutoReconnect.add(disconnectedId);
    busy.value = true;
    error.value = null;
    try {
      const result = await disconnectSession(activeSessionId.value);
      if (!result.ok) {
        suppressAutoReconnect.delete(disconnectedId);
        clearQuickProfile(quickProfileId);
        error.value = result.error;
        return;
      }
      upsert(result.data);
      clearQuickProfile(quickProfileId);
      useEventsStore().record('session', 'SSH_DISCONNECTED', 'info', { sessionId: result.data.id });
    } finally {
      busy.value = false;
    }
  }

  async function writeToSession(sessionId: string, data: Uint8Array): Promise<boolean> {
    if (summaries.value.find((item) => item.id === sessionId)?.state !== 'connected') return false;
    const result = await writeTerminal(
      sessionId,
      Array.from(data),
      useSettingsStore().value.terminalEncoding,
    );
    if (!result.ok) {
      error.value = result.error;
      return false;
    }
    return true;
  }

  async function writeActive(data: Uint8Array): Promise<boolean> {
    if (!activeSessionId.value) return false;
    return writeToSession(activeSessionId.value, data);
  }

  async function resizeActive(columns: number, rows: number): Promise<void> {
    if (!activeSessionId.value) return;
    await resizeSession(activeSessionId.value, columns, rows);
  }

  async function resizeSession(sessionId: string, columns: number, rows: number): Promise<void> {
    if (summaries.value.find((item) => item.id === sessionId)?.state !== 'connected') return;
    const result = await resizeTerminal(sessionId, columns, rows);
    if (!result.ok) error.value = result.error;
  }

  function selectSession(sessionId: string): void {
    if (summaries.value.some((item) => item.id === sessionId)) activeSessionId.value = sessionId;
  }

  /** Records the OSC 7 working directory reported by the session's shell. */
  function setSessionCwd(sessionId: string, cwd: string): void {
    const trimmed = cwd.trim();
    if (!trimmed.startsWith('/') || trimmed.length > 4096 || trimmed.includes('\0')) return;
    if (sessionCwds.value[sessionId] === trimmed) return;
    sessionCwds.value = { ...sessionCwds.value, [sessionId]: trimmed };
  }

  function sessionCwd(sessionId: string | null | undefined): string | null {
    return sessionId ? sessionCwds.value[sessionId] ?? null : null;
  }

  /** Appends a sent command to the bounded in-memory history; never persisted. */
  function recordCommandHistory(command: string): void {
    const trimmed = command.trim();
    if (!trimmed) return;
    const next = commandHistory.value.filter((item) => item !== trimmed);
    next.push(trimmed);
    while (next.length > COMMAND_HISTORY_LIMIT) next.shift();
    commandHistory.value = next;
  }

  function clearCommandHistory(): void {
    commandHistory.value = [];
  }

  function removeCommandHistory(command: string): void {
    commandHistory.value = commandHistory.value.filter((item) => item !== command);
  }

  async function closeSession(sessionId: string): Promise<void> {
    if (pendingConnectionSessionId.value === sessionId) await cancelPendingAttempt();
    const summary = summaries.value.find((item) => item.id === sessionId);
    const profileId = summary?.profileId;
    if (summary?.state === 'connected') {
      activeSessionId.value = sessionId;
      await disconnectActive();
    }
    clearQuickProfile(profileId);
    summaries.value = summaries.value.filter((item) => item.id !== sessionId);
    const nextBuffers = { ...outputBuffers.value };
    delete nextBuffers[sessionId];
    outputBuffers.value = nextBuffers;
    const nextBufferStarts = { ...outputBufferStarts.value };
    delete nextBufferStarts[sessionId];
    outputBufferStarts.value = nextBufferStarts;
    const nextCwds = { ...sessionCwds.value };
    delete nextCwds[sessionId];
    sessionCwds.value = nextCwds;
    if (activeSessionId.value === sessionId) {
      activeSessionId.value = summaries.value.at(-1)?.id ?? null;
    }
  }

  async function initializeTerminalEvents(): Promise<void> {
    if (!isTauriRuntime() || unlistenTerminal) return;
    unlistenTerminal = await listen<{
      sessionId: string;
      kind: 'data' | 'exit' | 'closed';
      data: number[] | null;
      exitStatus: number | null;
    }>('terminal-output', ({ payload }) => {
      if (payload.kind === 'data' && payload.data) {
        const existing = outputBuffers.value[payload.sessionId] ?? [];
        const next = [...existing, Uint8Array.from(payload.data)];
        let total = next.reduce((sum, chunk) => sum + chunk.byteLength, 0);
        let droppedChunks = 0;
        while (total > 2_000_000 && next.length > 1) {
          total -= next.shift()?.byteLength ?? 0;
          droppedChunks += 1;
        }
        if (droppedChunks > 0) {
          outputBufferStarts.value = {
            ...outputBufferStarts.value,
            [payload.sessionId]: (outputBufferStarts.value[payload.sessionId] ?? 0) + droppedChunks,
          };
        }
        outputBuffers.value = { ...outputBuffers.value, [payload.sessionId]: next };
      } else {
        const index = summaries.value.findIndex((item) => item.id === payload.sessionId);
        const current = summaries.value[index];
        const quickSession = Boolean(current && isQuickProfile(current.profileId));
        if (current) summaries.value[index] = { ...current, state: 'disconnected' };
        useEventsStore().record('session', payload.kind === 'exit' ? 'PTY_EXITED' : 'PTY_CLOSED', 'warning', { sessionId: payload.sessionId, exitStatus: payload.exitStatus ?? -1 });
        if (payload.kind === 'closed' && current) {
          clearQuickProfile(current.profileId);
          if (quickSession) suppressAutoReconnect.add(payload.sessionId);
          else void autoReconnect(payload.sessionId);
        }
      }
      outputRevision.value += 1;
    });
  }

  async function cancelPendingAttempt(): Promise<void> {
    const sessionId = pendingConnectionSessionId.value;
    const quickProfileId = challenge.value?.profileId ?? passwordProfileId.value;
    challenge.value = null;
    currentRouteProfileId.value = null;
    pendingConnectionSessionId.value = null;
    passwordProfileId.value = null;
    privateKeyPassphraseProfileId.value = null;
    clearQuickProfile(quickProfileId);
    if (!sessionId) return;
    const result = await cancelSessionAttempt(sessionId);
    if (!result.ok) error.value = result.error;
    summaries.value = summaries.value.filter((item) => item.id !== sessionId);
    if (activeSessionId.value === sessionId) activeSessionId.value = summaries.value.at(-1)?.id ?? null;
  }

  function dismissChallenge(): void {
    void cancelPendingAttempt();
  }

  function dismissPassword(): void {
    void cancelPendingAttempt();
  }

  function dismissPrivateKeyPassphrase(): void {
    void cancelPendingAttempt();
  }

  return {
    summaries,
    activeSessionId,
    activeSession,
    challenge,
    quickProfiles,
    currentRouteProfileId,
    passwordProfileId,
    privateKeyPassphraseProfileId,
    busy,
    error,
    clearError,
    outputBuffers,
    outputBufferStarts,
    outputRevision,
    sessionCwds,
    sessionCwd,
    setSessionCwd,
    commandHistory,
    recordCommandHistory,
    clearCommandHistory,
    removeCommandHistory,
    profileForId,
    profileForSession,
    isQuickProfile,
    begin,
    beginQuick,
    reconnectActive,
    reconnectSession,
    acceptHostKey,
    savePassword,
    savePrivateKeyPassphrase,
    disconnectActive,
    writeActive,
    writeToSession,
    resizeActive,
    resizeSession,
    selectSession,
    closeSession,
    initializeTerminalEvents,
    dismissChallenge,
    dismissPassword,
    dismissPrivateKeyPassphrase,
  };
});
