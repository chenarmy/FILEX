import { computed, ref, shallowRef } from 'vue';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { defineStore } from 'pinia';
import {
  connectExternalLaunchSession,
  discardExternalLaunch,
  drainExternalLaunchEvents,
  listenExternalLaunchEvents,
  probeExternalLaunchHostKey,
} from '@/api/domain/externalLaunchApi';
import {
  connectAgentSession,
  connectPrivateKeySession,
  connectPasswordSession,
  connectQuickPasswordSession,
  cancelSessionAttempt,
  disconnectSession,
  duplicateConnectedSession,
  listSessions,
  probeQuickSessionHostKey,
  probeSessionHostKey,
  reprobeSessionHostKey,
  resizeTerminal,
  saveProfilePrivateKeyPassphrase,
  saveProfilePassword,
  writeTerminal,
} from '@/api/domain/sessionsApi';
import {
  closeLocalTerminal,
  listLocalShellOptions,
  openLocalTerminal,
} from '@/api/domain/localTerminalApi';
import {
  appendProfileCommandHistory,
  clearProfileCommandHistory,
  deleteProfileCommandHistoryEntry,
  listProfileCommandHistory,
} from '@/api/domain/commandHistoryApi';
import { isTauriRuntime } from '@/api/common';
import {
  MAX_PROFILE_COMMAND_HISTORY_ENTRIES,
  shouldExcludeCommandFromHistory,
} from '@/domain/commandHistory';
import {
  externalLaunchProfileName,
  shouldPromptExternalLaunchUsername,
} from '@/domain/externalLaunch';
import { t } from '@/i18n';
import { recordHostTrust } from '@/api/domain/trustApi';
import { isLocalSession } from '@/domain/sessionCapabilities';
import { useBookmarksStore } from '@/stores/bookmarks';
import { useConnectionsStore } from '@/stores/connections';
import { useEventsStore } from '@/stores/events';
import { useTunnelsStore } from '@/stores/tunnels';
import { useSettingsStore } from '@/stores/settings';
import { useUiStore } from '@/stores/ui';
import type {
  AppError,
  ConnectionProfile,
  ExternalLaunchEvent,
  ExternalLaunchRequest,
  HostKeyChallenge,
  LocalShellKind,
  LocalShellOption,
  OpenLocalTerminalInput,
  ProfileCommandHistoryEntry,
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
  const quickLaunchMeta = shallowRef<Record<string, { hasPresetPassword: boolean; openSftp: boolean }>>({});
  const passwordProfileId = ref<string | null>(null);
  const privateKeyPassphraseProfileId = ref<string | null>(null);
  const busy = ref(false);
  const error = ref<AppError | null>(null);
  const outputBuffers = shallowRef<Record<string, Uint8Array[]>>({});
  const outputBufferStarts = shallowRef<Record<string, number>>({});
  const outputRevision = ref(0);
  const sessionCwds = ref<Record<string, string>>({});
  const profileHistoryEntries = ref<Record<string, ProfileCommandHistoryEntry[]>>({});
  const ephemeralHistoryEntries = ref<Record<string, ProfileCommandHistoryEntry[]>>({});
  const loadedHistoryProfiles = new Set<string>();
  const localShellOptions = ref<LocalShellOption[]>([]);
  const localShellMetadata = ref<Record<string, {
    shellKind: LocalShellKind;
    shellLabel: string;
    workingDirectory: string;
  }>>({});
  let unlistenTerminal: UnlistenFn | null = null;
  let unlistenExternalLaunch: UnlistenFn | null = null;
  const externalLaunchQueue: ExternalLaunchEvent[] = [];
  let externalLaunchProcessing = false;
  const autoReconnectInFlight = new Set<string>();
  const suppressAutoReconnect = new Set<string>();
  const activeSession = computed(() => summaries.value.find((item) => item.id === activeSessionId.value) ?? null);
  const activeHistoryPersisted = computed(() => isPersistedHistorySession(activeSession.value));
  const commandHistoryEntries = computed<ProfileCommandHistoryEntry[]>(() => {
    const current = activeSession.value;
    if (!current) return ephemeralHistoryEntries.value['__default__'] ?? [];
    if (isPersistedHistorySession(current)) {
      return profileHistoryEntries.value[current.profileId] ?? [];
    }
    return ephemeralHistoryEntries.value[current.id] ?? [];
  });
  const commandHistory = computed<string[]>(() =>
    [...commandHistoryEntries.value].reverse().map((entry) => entry.command),
  );

  function profileForId(profileId: string | null | undefined): ConnectionProfile | null {
    if (!profileId) return null;
    return quickProfiles.value[profileId]
      ?? useConnectionsStore().profiles.find((profile) => profile.id === profileId)
      ?? null;
  }

  function profileForSession(session: SessionSummary | null | undefined): ConnectionProfile | null {
    if (!session || isLocalSession(session)) return null;
    return profileForId(session.profileId);
  }

  function localMetadataForSession(sessionId: string | null | undefined): {
    shellKind: LocalShellKind;
    shellLabel: string;
    workingDirectory: string;
  } | null {
    return sessionId ? localShellMetadata.value[sessionId] ?? null : null;
  }

  async function loadLocalShellOptions(): Promise<LocalShellOption[]> {
    const result = await listLocalShellOptions();
    if (!result.ok) {
      error.value = result.error;
      return [];
    }
    localShellOptions.value = result.data;
    return result.data;
  }

  async function openLocalSession(input: OpenLocalTerminalInput = {
    shellKind: null,
    workingDirectory: null,
    columns: 120,
    rows: 32,
  }): Promise<boolean> {
    if (busy.value) return false;
    busy.value = true;
    error.value = null;
    try {
      const result = await openLocalTerminal(input);
      if (!result.ok) {
        error.value = result.error;
        useEventsStore().record('session', result.error.code, 'error');
        return false;
      }
      localShellMetadata.value = {
        ...localShellMetadata.value,
        [result.data.session.id]: {
          shellKind: result.data.shell.kind,
          shellLabel: result.data.shell.label,
          workingDirectory: result.data.workingDirectory,
        },
      };
      upsert(result.data.session);
      setSessionCwd(result.data.session.id, result.data.workingDirectory);
      useEventsStore().record('session', 'LOCAL_TERMINAL_OPENED', 'success', {
        sessionId: result.data.session.id,
      });
      return true;
    } finally {
      busy.value = false;
    }
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

  function bindExternalLaunchProfile(
    profileId: string,
    request: ExternalLaunchRequest,
    fallbackName: string,
  ): void {
    const profile: ConnectionProfile = {
      id: profileId,
      name: externalLaunchProfileName(request, fallbackName),
      group: '',
      host: request.host.trim(),
      port: request.port,
      username: request.username.trim(),
      environment: 'development',
      favorite: false,
      tags: [],
      authenticationMethod: request.authenticationMethod,
      identityFile: request.identityFile,
      proxyJump: null,
      proxyJumpProfileIds: [],
      credentialRef: null,
      state: 'idle',
      latencyMs: null,
      lastUsedAt: null,
    };
    quickProfiles.value = { ...quickProfiles.value, [profileId]: profile };
    quickLaunchMeta.value = {
      ...quickLaunchMeta.value,
      [profileId]: {
        hasPresetPassword: request.hasPresetPassword,
        openSftp: request.openSftp,
      },
    };
  }

  function clearQuickProfile(profileId: string | null | undefined): void {
    if (!profileId) return;
    if (quickProfiles.value[profileId]) {
      const next = { ...quickProfiles.value };
      delete next[profileId];
      quickProfiles.value = next;
    }
    if (quickLaunchMeta.value[profileId]) {
      const nextMeta = { ...quickLaunchMeta.value };
      delete nextMeta[profileId];
      quickLaunchMeta.value = nextMeta;
    }
    useBookmarksStore().clearEphemeral(profileId);
  }

  function clearQuickProfileIfUnused(profileId: string | null | undefined): void {
    if (!profileId) return;
    if (summaries.value.some((item) => item.profileId === profileId)) return;
    clearQuickProfile(profileId);
  }

  function resolvePendingQuickSession(profileId: string): SessionSummary | undefined {
    return (pendingConnectionSessionId.value
      ? summaries.value.find((item) => item.id === pendingConnectionSessionId.value)
      : undefined)
      ?? summaries.value.find((item) => item.id === activeSessionId.value && item.profileId === profileId)
      ?? summaries.value.find((item) => item.profileId === profileId);
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

  function isPersistedHistorySession(session: SessionSummary | null | undefined): boolean {
    return Boolean(session && session.sessionKind === 'ssh' && !isQuickProfile(session.profileId));
  }

  async function loadCommandHistory(profileId: string, force = false): Promise<void> {
    if (!profileId || !isTauriRuntime()) return;
    if (!force && loadedHistoryProfiles.has(profileId)) return;
    loadedHistoryProfiles.add(profileId);
    const result = await listProfileCommandHistory(profileId);
    if (result.ok) {
      profileHistoryEntries.value = {
        ...profileHistoryEntries.value,
        [profileId]: result.data,
      };
    } else {
      loadedHistoryProfiles.delete(profileId);
    }
  }

  function profileSupportError(profile: ConnectionProfile): AppError | null {
    if (
      profile.authenticationMethod === 'private_key'
      && !profile.identityFile?.trim()
      && !profile.keyId?.trim()
    ) {
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
    if (isPersistedHistorySession(summary)) {
      void loadCommandHistory(summary.profileId);
    }
  }

  async function refreshSummary(sessionId: string): Promise<void> {
    const result = await listSessions();
    if (!result.ok) return;
    const refreshed = result.data.find((item) => item.id === sessionId);
    if (!refreshed) {
      summaries.value = summaries.value.filter((item) => item.id !== sessionId);
      if (pendingConnectionSessionId.value === sessionId) {
        clearQuickProfileIfUnused(challenge.value?.profileId);
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

  function canStartExternalLaunch(): boolean {
    return !busy.value
      && !challenge.value
      && !passwordProfileId.value
      && !privateKeyPassphraseProfileId.value;
  }

  function scheduleNextExternalLaunch(): void {
    if (externalLaunchQueue.length > 0 && canStartExternalLaunch() && !externalLaunchProcessing) {
      void processNextExternalLaunch();
    }
  }

  function enqueueExternalLaunch(event: ExternalLaunchEvent): void {
    externalLaunchQueue.push(event);
    scheduleNextExternalLaunch();
  }

  async function beginExternalLaunch(request: ExternalLaunchRequest): Promise<boolean> {
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
      const result = await probeExternalLaunchHostKey(request.launchId);
      if (!result.ok) {
        error.value = result.error;
        useEventsStore().record('session', result.error.code, 'error');
        useUiStore().notify(t(result.error.messageKey as Parameters<typeof t>[0]));
        return false;
      }
      bindExternalLaunchProfile(result.data.profileId, request, result.data.profileName);
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

  async function processNextExternalLaunch(): Promise<void> {
    if (externalLaunchProcessing) return;
    externalLaunchProcessing = true;
    try {
      while (externalLaunchQueue.length > 0 && canStartExternalLaunch()) {
        const next = externalLaunchQueue.shift();
        if (!next) break;
        if (next.kind === 'error') {
          error.value = next.error;
          useEventsStore().record('session', next.error.code, 'error');
          useUiStore().notify(t(next.error.messageKey as Parameters<typeof t>[0]));
          continue;
        }
        if (shouldPromptExternalLaunchUsername(next.request)) {
          await discardExternalLaunch(next.request.launchId);
          useUiStore().openQuickConnectWithPrefill({
            host: next.request.host,
            port: next.request.port,
          });
          continue;
        }
        await beginExternalLaunch(next.request);
      }
    } finally {
      externalLaunchProcessing = false;
    }
  }

  async function connectExternalLaunch(
    sessionId: string,
    profile: ConnectionProfile,
    passphrase?: string,
  ): Promise<void> {
    const meta = quickLaunchMeta.value[profile.id];
    const result = await connectExternalLaunchSession(sessionId, passphrase);
    if (!result.ok) {
      if (
        profile.authenticationMethod === 'private_key'
        && result.error.code === 'SSH_PRIVATE_KEY_PASSPHRASE_REQUIRED'
      ) {
        error.value = null;
        privateKeyPassphraseProfileId.value = profile.id;
        return;
      }
      if (
        profile.authenticationMethod === 'private_key'
        && result.error.code === 'SSH_PRIVATE_KEY_INVALID'
        && passphrase !== undefined
      ) {
        error.value = result.error;
        privateKeyPassphraseProfileId.value = profile.id;
        return;
      }
      if (
        profile.authenticationMethod === 'password'
        && result.error.code === 'CREDENTIAL_NOT_CONFIGURED'
      ) {
        error.value = null;
        passwordProfileId.value = profile.id;
        return;
      }
      suppressAutoReconnect.add(sessionId);
      removeSessionState(sessionId, profile.id);
      passwordProfileId.value = null;
      privateKeyPassphraseProfileId.value = null;
      challenge.value = null;
      currentRouteProfileId.value = null;
      pendingConnectionSessionId.value = null;
      error.value = result.error;
      useEventsStore().record('session', result.error.code, 'error', { sessionId });
      useUiStore().notify(t(result.error.messageKey as Parameters<typeof t>[0]));
      return;
    }
    upsert(result.data.session);
    markQuickProfileUsed(profile.id);
    if (meta) {
      quickLaunchMeta.value = {
        ...quickLaunchMeta.value,
        [profile.id]: { ...meta, hasPresetPassword: false },
      };
    }
    passwordProfileId.value = null;
    privateKeyPassphraseProfileId.value = null;
    challenge.value = null;
    currentRouteProfileId.value = null;
    pendingConnectionSessionId.value = null;
    useEventsStore().record('session', 'SSH_CONNECTED', 'success', {
      sessionId: result.data.session.id,
      generation: result.data.session.generation,
    });
    void useTunnelsStore().autoStartForSession(result.data.session.id, result.data.session.profileId);
    if (meta?.openSftp) {
      const settings = useSettingsStore();
      settings.value.fileBrowserOpen = true;
      settings.value.inspectorTab = 'files';
    }
  }

  async function reconnectActive(): Promise<void> {
    const session = activeSession.value;
    if (!session || isLocalSession(session) || busy.value) return;
    if (session.state === 'connected' && isQuickProfile(session.profileId)) {
      const profile = profileForId(session.profileId);
      if (!profile) {
        error.value = missingProfileError();
        return;
      }
      const previousId = session.id;
      const previousProfileId = session.profileId;
      const started = await beginQuick({
        host: profile.host,
        port: profile.port,
        username: profile.username,
      });
      if (started) {
        suppressAutoReconnect.add(previousId);
        await disconnectSession(previousId);
        removeSessionState(previousId, previousProfileId);
      }
      return;
    }
    await reconnectSession(session.id);
  }

  async function reconnectSession(sessionId: string, automatic = false): Promise<void> {
    const session = summaries.value.find((item) => item.id === sessionId);
    if (!session || isLocalSession(session) || busy.value) return;
    const canDisconnectInPlace = !automatic
      && session.state === 'connected'
      && !isQuickProfile(session.profileId);
    if (!canDisconnectInPlace && !['disconnected', 'failed'].includes(session.state)) return;
    if (!automatic && !canDisconnectInPlace) suppressAutoReconnect.delete(sessionId);
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
      if (canDisconnectInPlace) {
        suppressAutoReconnect.add(sessionId);
        const disconnected = await disconnectSession(sessionId);
        if (!disconnected.ok) {
          suppressAutoReconnect.delete(sessionId);
          error.value = disconnected.error;
          return;
        }
        upsert(disconnected.data);
        useEventsStore().record('session', 'SSH_DISCONNECTED', 'info', { sessionId });
      }
      const result = await reprobeSessionHostKey(session.id);
      if (canDisconnectInPlace) suppressAutoReconnect.delete(sessionId);
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
      scheduleNextExternalLaunch();
    }
  }

  async function requestAuthentication(profile: ConnectionProfile): Promise<void> {
    if (blockUnsupportedProfile(profile)) {
      await cancelPendingAttempt();
      return;
    }
    if (isQuickProfile(profile.id)) {
      const meta = quickLaunchMeta.value[profile.id];
      const sessionId = pendingConnectionSessionId.value ?? activeSessionId.value;
      if (
        sessionId
        && ((profile.authenticationMethod === 'password' && meta?.hasPresetPassword)
          || profile.authenticationMethod === 'private_key')
      ) {
        await connectExternalLaunch(sessionId, profile);
        return;
      }
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
      const session = resolvePendingQuickSession(profileId);
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
          removeSessionState(session.id, profileId);
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
        void useTunnelsStore().autoStartForSession(result.data.session.id, result.data.session.profileId);
        return;
      } finally {
        busy.value = false;
        scheduleNextExternalLaunch();
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
    if (isQuickProfile(profileId)) {
      const session = resolvePendingQuickSession(profileId);
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
        await connectExternalLaunch(session.id, profile, passphrase);
      } finally {
        busy.value = false;
        scheduleNextExternalLaunch();
      }
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
    const current = summaries.value.find((item) => item.id === disconnectedId);
    const quickProfileId = current?.profileId;
    const wasQuick = isQuickProfile(quickProfileId);
    const localSession = isLocalSession(current);
    suppressAutoReconnect.add(disconnectedId);
    busy.value = true;
    error.value = null;
    try {
      const result = localSession
        ? await closeLocalTerminal(activeSessionId.value)
        : await disconnectSession(activeSessionId.value);
      if (!result.ok) {
        suppressAutoReconnect.delete(disconnectedId);
        if (wasQuick) {
          removeSessionState(disconnectedId, quickProfileId);
        }
        error.value = result.error;
        return;
      }
      if (wasQuick) {
        removeSessionState(disconnectedId, quickProfileId);
        useUiStore().notify(t('quick.disconnectedRemoved'));
      } else {
        upsert(result.data);
      }
      useEventsStore().record('session', localSession ? 'LOCAL_TERMINAL_CLOSED' : 'SSH_DISCONNECTED', 'info', { sessionId: result.data.id });
    } finally {
      busy.value = false;
    }
  }

  async function duplicateSession(sourceSessionId?: string): Promise<boolean> {
    if (busy.value) return false;
    const source = sourceSessionId
      ? summaries.value.find((item) => item.id === sourceSessionId)
      : activeSession.value;
    if (!source) return false;
    if (isLocalSession(source)) {
      const meta = localMetadataForSession(source.id);
      return openLocalSession({
        shellKind: meta?.shellKind ?? null,
        workingDirectory: meta?.workingDirectory ?? null,
        columns: 120,
        rows: 32,
      });
    }
    const profile = profileForId(source.profileId);
    if (!profile) {
      error.value = missingProfileError();
      return false;
    }
    if (isQuickProfile(source.profileId)) {
      if (source.state === 'connected') {
        busy.value = true;
        error.value = null;
        try {
          const result = await duplicateConnectedSession(source.id);
          if (result.ok) {
            upsert(result.data);
            markQuickProfileUsed(result.data.profileId);
            useEventsStore().record('session', 'SSH_CONNECTED', 'success', {
              sessionId: result.data.id,
              generation: result.data.generation,
            });
            return true;
          }
          if (profile.authenticationMethod !== 'password') {
            error.value = result.error;
            return false;
          }
        } finally {
          busy.value = false;
        }
      }
      return beginQuick({
        host: profile.host,
        port: profile.port,
        username: profile.username,
      });
    }
    const previousId = activeSessionId.value;
    await begin(profile);
    return activeSessionId.value !== previousId;
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
    const found = summaries.value.find((item) => item.id === sessionId);
    if (!found) return;
    activeSessionId.value = sessionId;
    if (isPersistedHistorySession(found)) {
      void loadCommandHistory(found.profileId);
    }
  }

  /** Records the working directory reported by the session's shell. */
  function setSessionCwd(sessionId: string, cwd: string): void {
    const trimmed = cwd.trim();
    const session = summaries.value.find((item) => item.id === sessionId);
    const allowLocal = isLocalSession(session);
    if ((!allowLocal && !trimmed.startsWith('/')) || trimmed.length > 4096 || trimmed.includes('\0')) return;
    if (sessionCwds.value[sessionId] === trimmed) return;
    sessionCwds.value = { ...sessionCwds.value, [sessionId]: trimmed };
  }

  function sessionCwd(sessionId: string | null | undefined): string | null {
    return sessionId ? sessionCwds.value[sessionId] ?? null : null;
  }

  function upsertMemoryHistoryList(
    list: ProfileCommandHistoryEntry[],
    entry: ProfileCommandHistoryEntry,
  ): ProfileCommandHistoryEntry[] {
    const filtered = list.filter((item) => item.command !== entry.command);
    filtered.unshift(entry);
    if (filtered.length > MAX_PROFILE_COMMAND_HISTORY_ENTRIES) {
      filtered.length = MAX_PROFILE_COMMAND_HISTORY_ENTRIES;
    }
    return filtered;
  }

  /** Appends a sent command to persisted profile history or session-only memory, excluding secrets. */
  async function recordCommandHistory(command: string): Promise<boolean> {
    const trimmed = command.trim();
    if (!trimmed || shouldExcludeCommandFromHistory(trimmed)) return false;

    const current = activeSession.value;
    if (isPersistedHistorySession(current) && current) {
      const profileId = current.profileId;
      if (isTauriRuntime()) {
        const result = await appendProfileCommandHistory(profileId, trimmed);
        if (!result.ok || !result.data) return false;
        profileHistoryEntries.value = {
          ...profileHistoryEntries.value,
          [profileId]: upsertMemoryHistoryList(
            profileHistoryEntries.value[profileId] ?? [],
            result.data,
          ),
        };
        return true;
      }
      const entry: ProfileCommandHistoryEntry = {
        id: globalThis.crypto?.randomUUID?.() ?? `cmd-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        profileId,
        command: trimmed,
        createdAtMs: Date.now(),
      };
      profileHistoryEntries.value = {
        ...profileHistoryEntries.value,
        [profileId]: upsertMemoryHistoryList(profileHistoryEntries.value[profileId] ?? [], entry),
      };
      return true;
    }

    const bucketKey = current?.id ?? '__default__';
    const entry: ProfileCommandHistoryEntry = {
      id: globalThis.crypto?.randomUUID?.() ?? `cmd-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      profileId: current?.profileId ?? bucketKey,
      command: trimmed,
      createdAtMs: Date.now(),
    };
    ephemeralHistoryEntries.value = {
      ...ephemeralHistoryEntries.value,
      [bucketKey]: upsertMemoryHistoryList(ephemeralHistoryEntries.value[bucketKey] ?? [], entry),
    };
    return true;
  }

  async function clearCommandHistory(): Promise<void> {
    const current = activeSession.value;
    if (isPersistedHistorySession(current) && current) {
      const profileId = current.profileId;
      if (isTauriRuntime()) {
        const result = await clearProfileCommandHistory(profileId);
        if (!result.ok) {
          error.value = result.error;
          return;
        }
      }
      profileHistoryEntries.value = {
        ...profileHistoryEntries.value,
        [profileId]: [],
      };
      return;
    }
    const bucketKey = current?.id ?? '__default__';
    const next = { ...ephemeralHistoryEntries.value };
    delete next[bucketKey];
    ephemeralHistoryEntries.value = next;
  }

  async function removeCommandHistory(command: string): Promise<void> {
    const target = commandHistoryEntries.value.find((item) => item.command === command);
    if (!target) return;
    await removeCommandHistoryEntry(target.id);
  }

  async function removeCommandHistoryEntry(entryId: string): Promise<void> {
    const current = activeSession.value;
    if (isPersistedHistorySession(current) && current) {
      const profileId = current.profileId;
      if (isTauriRuntime()) {
        const result = await deleteProfileCommandHistoryEntry(profileId, entryId);
        if (!result.ok) {
          error.value = result.error;
          return;
        }
      }
      profileHistoryEntries.value = {
        ...profileHistoryEntries.value,
        [profileId]: (profileHistoryEntries.value[profileId] ?? []).filter((item) => item.id !== entryId),
      };
      return;
    }
    const bucketKey = current?.id ?? '__default__';
    ephemeralHistoryEntries.value = {
      ...ephemeralHistoryEntries.value,
      [bucketKey]: (ephemeralHistoryEntries.value[bucketKey] ?? []).filter((item) => item.id !== entryId),
    };
  }

  function removeSessionState(sessionId: string, profileId?: string | null): void {
    suppressAutoReconnect.delete(sessionId);
    summaries.value = summaries.value.filter((item) => item.id !== sessionId);
    clearQuickProfileIfUnused(profileId);
    const nextEphemeral = { ...ephemeralHistoryEntries.value };
    delete nextEphemeral[sessionId];
    ephemeralHistoryEntries.value = nextEphemeral;
    const nextBuffers = { ...outputBuffers.value };
    delete nextBuffers[sessionId];
    outputBuffers.value = nextBuffers;
    const nextBufferStarts = { ...outputBufferStarts.value };
    delete nextBufferStarts[sessionId];
    outputBufferStarts.value = nextBufferStarts;
    const nextCwds = { ...sessionCwds.value };
    delete nextCwds[sessionId];
    sessionCwds.value = nextCwds;
    const nextLocalMeta = { ...localShellMetadata.value };
    delete nextLocalMeta[sessionId];
    localShellMetadata.value = nextLocalMeta;
    if (activeSessionId.value === sessionId) {
      activeSessionId.value = summaries.value.at(-1)?.id ?? null;
    }
  }

  async function closeSession(sessionId: string): Promise<void> {
    const wasPending = pendingConnectionSessionId.value === sessionId;
    if (wasPending) await cancelPendingAttempt();
    const summary = summaries.value.find((item) => item.id === sessionId);
    const profileId = summary?.profileId;
    const localSession = isLocalSession(summary);
    if (summary?.state === 'connected') {
      activeSessionId.value = sessionId;
      await disconnectActive();
    }
    if (!wasPending && summary && !localSession && isTauriRuntime()) {
      await cancelSessionAttempt(sessionId);
    }
    removeSessionState(sessionId, profileId);
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
        const localSession = isLocalSession(current);
        useEventsStore().record('session', payload.kind === 'exit' ? 'PTY_EXITED' : 'PTY_CLOSED', 'warning', { sessionId: payload.sessionId, exitStatus: payload.exitStatus ?? -1 });
        if (quickSession && current) {
          removeSessionState(payload.sessionId, current.profileId);
          useUiStore().notify(t('quick.disconnectedRemoved'));
        } else {
          if (current && current.state === 'connected') {
            summaries.value[index] = { ...current, state: 'disconnected' };
          }
          if (payload.kind === 'closed' && current) {
            if (localSession) suppressAutoReconnect.add(payload.sessionId);
            else void autoReconnect(payload.sessionId);
          }
        }
      }
      outputRevision.value += 1;
    });
  }

  async function cancelPendingAttempt(): Promise<void> {
    const sessionId = pendingConnectionSessionId.value;
    const quickProfileId = challenge.value?.profileId ?? passwordProfileId.value ?? privateKeyPassphraseProfileId.value;
    challenge.value = null;
    currentRouteProfileId.value = null;
    pendingConnectionSessionId.value = null;
    passwordProfileId.value = null;
    privateKeyPassphraseProfileId.value = null;
    if (sessionId) {
      const result = await cancelSessionAttempt(sessionId);
      if (!result.ok) error.value = result.error;
      summaries.value = summaries.value.filter((item) => item.id !== sessionId);
      if (activeSessionId.value === sessionId) activeSessionId.value = summaries.value.at(-1)?.id ?? null;
    }
    clearQuickProfileIfUnused(quickProfileId);
    scheduleNextExternalLaunch();
  }

  async function initializeExternalLaunchEvents(): Promise<void> {
    if (!unlistenExternalLaunch) {
      unlistenExternalLaunch = await listenExternalLaunchEvents((event) => {
        enqueueExternalLaunch(event);
      });
    }
    const result = await drainExternalLaunchEvents();
    if (!result.ok) {
      error.value = result.error;
      return;
    }
    for (const event of result.data) {
      enqueueExternalLaunch(event);
    }
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

  function syncElevatedCapability(sessionId: string, elevated: boolean): void {
    const index = summaries.value.findIndex((item) => item.id === sessionId);
    const current = summaries.value[index];
    if (!current || current.sessionKind !== 'ssh') return;
    const nextCapabilities = elevated
      ? Array.from(new Set([...current.capabilities, 'elevated_file_access' as const]))
      : current.capabilities.filter((item) => item !== 'elevated_file_access');
    summaries.value[index] = {
      ...current,
      capabilities: nextCapabilities,
    };
  }

  async function refreshSummaries(): Promise<void> {
    if (!isTauriRuntime()) return;
    const result = await listSessions();
    if (!result.ok) return;
    const remoteById = new Map(result.data.map((item) => [item.id, item]));
    summaries.value = summaries.value.map((item) => remoteById.get(item.id) ?? item);
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
    commandHistoryEntries,
    activeHistoryPersisted,
    loadCommandHistory,
    recordCommandHistory,
    clearCommandHistory,
    removeCommandHistory,
    removeCommandHistoryEntry,
    localShellOptions,
    localShellMetadata,
    localMetadataForSession,
    loadLocalShellOptions,
    openLocalSession,
    profileForId,
    profileForSession,
    isQuickProfile,
    begin,
    beginQuick,
    duplicateSession,
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
    initializeExternalLaunchEvents,
    enqueueExternalLaunch,
    dismissChallenge,
    dismissPassword,
    dismissPrivateKeyPassphrase,
    syncElevatedCapability,
    refreshSummaries,
  };
});
