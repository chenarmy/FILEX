import { onScopeDispose, ref } from 'vue';
import { defineStore } from 'pinia';
import { createTunnelRule, deleteTunnelRule, listTunnelRules, listTunnels, startLocalTunnel, stopTunnel, updateTunnelRule } from '@/api/domain/tunnelsApi';
import { normalizeUnknownError } from '@/api/common';
import { isLoopbackAddress } from '@/utils/network';
import type { AppError, CreateLocalTunnelInput, CreateTunnelRuleInput, TunnelRule, TunnelSummary } from '@/types/contracts';
import { useEventsStore } from '@/stores/events';

const LIVE_TUNNEL_STATES = new Set<TunnelSummary['state']>(['starting', 'listening', 'stopping']);
const UNCERTAIN_REMOTE_CANCEL_CODES = new Set([
  'SSH_REMOTE_FORWARD_CANCEL_DENIED',
  'SSH_REMOTE_FORWARD_CANCEL_FAILED',
]);
const TUNNEL_REFRESH_INTERVAL_MS = 2_000;
const UNCERTAIN_TUNNEL_REFRESH_INTERVAL_MS = 5_000;

function isStaleTunnelTransition(current: TunnelSummary['state'], next: TunnelSummary['state']): boolean {
  if (current === 'stopped') return next !== 'stopped';
  if (current === 'failed') return next !== 'failed' && next !== 'stopped';
  if (current === 'stopping') return next === 'starting' || next === 'listening';
  return current === 'listening' && next === 'starting';
}

export const useTunnelsStore = defineStore('tunnels', () => {
  const tunnels = ref<TunnelSummary[]>([]);
  const rules = ref<TunnelRule[]>([]);
  const loading = ref(false);
  const error = ref<AppError | null>(null);
  const pendingStopIds = ref<string[]>([]);
  const autoStartInFlight = new Set<string>();
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;
  let refreshInFlight = false;
  let storeDisposed = false;

  function needsLiveRefresh(): boolean {
    return tunnels.value.some((tunnel) => (
      LIVE_TUNNEL_STATES.has(tunnel.state)
      || (tunnel.state === 'failed'
        && tunnel.lastError !== null
        && UNCERTAIN_REMOTE_CANCEL_CODES.has(tunnel.lastError.code))
    ));
  }

  function scheduleLiveRefresh(): void {
    if (storeDisposed || refreshTimer || refreshInFlight || !needsLiveRefresh()) return;
    const interval = tunnels.value.some((tunnel) => LIVE_TUNNEL_STATES.has(tunnel.state))
      ? TUNNEL_REFRESH_INTERVAL_MS
      : UNCERTAIN_TUNNEL_REFRESH_INTERVAL_MS;
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      void refreshLiveState();
    }, interval);
  }

  onScopeDispose(() => {
    storeDisposed = true;
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = null;
  });

  function upsert(tunnel: TunnelSummary): void {
    const index = tunnels.value.findIndex((item) => item.id === tunnel.id);
    const existing = index >= 0 ? tunnels.value[index] : undefined;
    if (existing && isStaleTunnelTransition(existing.state, tunnel.state)) return;
    const previousState = existing?.state ?? null;
    if (index >= 0) tunnels.value[index] = tunnel;
    else tunnels.value.unshift(tunnel);
    if (previousState !== tunnel.state) {
      useEventsStore().record('tunnel', `TUNNEL_${tunnel.state.toUpperCase()}`, tunnel.state === 'failed' ? 'error' : tunnel.state === 'listening' ? 'success' : 'info', { tunnelId: tunnel.id, bindPort: tunnel.bindPort, targetPort: tunnel.targetPort });
    }
    scheduleLiveRefresh();
  }

  function applySnapshot(snapshot: TunnelSummary[]): void {
    for (const tunnel of snapshot) upsert(tunnel);
  }

  async function refreshLiveState(): Promise<void> {
    if (refreshInFlight) return;
    refreshInFlight = true;
    try {
      const result = await listTunnels();
      if (!result.ok) {
        error.value = result.error;
        return;
      }
      applySnapshot(result.data);
    } catch (caught: unknown) {
      error.value = normalizeUnknownError(caught, 'TUNNEL_LIST_FAILED');
    } finally {
      refreshInFlight = false;
      scheduleLiveRefresh();
    }
  }

  async function load(): Promise<void> {
    const result = await listTunnels();
    if (result.ok) {
      applySnapshot(result.data);
      scheduleLiveRefresh();
    } else {
      error.value = result.error;
    }
  }

  async function loadRules(): Promise<void> {
    const result = await listTunnelRules();
    if (result.ok) rules.value = result.data;
    else error.value = result.error;
  }

  function matchesRule(tunnel: TunnelSummary, rule: TunnelRule): boolean {
    return ['starting', 'listening', 'stopping'].includes(tunnel.state)
      && tunnel.profileId === rule.profileId
      && tunnel.name === rule.name
      && tunnel.kind === rule.kind
      && tunnel.bindHost === rule.bindHost
      && (rule.bindPort === 0 || tunnel.bindPort === rule.bindPort)
      && tunnel.targetHost === rule.targetHost
      && tunnel.targetPort === rule.targetPort;
  }

  async function autoStartForSession(sessionId: string, profileId: string): Promise<void> {
    const requestKey = `${sessionId}:${profileId}`;
    if (autoStartInFlight.has(requestKey)) return;
    autoStartInFlight.add(requestKey);
    try {
      error.value = null;
      await load();
      const loadError = error.value as AppError | null;
      if (loadError) {
        useEventsStore().record('tunnel', 'TUNNEL_AUTO_START_STATE_FAILED', 'warning', {
          profileId,
          errorCode: loadError.code,
        });
        return;
      }
      const result = await listTunnelRules();
      if (!result.ok) {
        error.value = result.error;
        useEventsStore().record('tunnel', 'TUNNEL_AUTO_START_RULES_FAILED', 'warning', {
          profileId,
          errorCode: result.error.code,
        });
        return;
      }
      rules.value = result.data;
      for (const rule of result.data) {
        if (
          rule.profileId !== profileId
          || !rule.autoStart
          || rule.kind === 'remote'
          || !isLoopbackAddress(rule.bindHost)
          || tunnels.value.some((tunnel) => matchesRule(tunnel, rule))
        ) continue;
        const started = await start({
          sessionId,
          profileId,
          name: rule.name,
          kind: rule.kind,
          bindHost: rule.bindHost,
          bindPort: rule.bindPort,
          targetHost: rule.targetHost,
          targetPort: rule.targetPort,
          allowNonLoopback: false,
        });
        if (!started) {
          const startError = error.value as AppError | null;
          useEventsStore().record('tunnel', 'TUNNEL_AUTO_START_FAILED', 'warning', {
            profileId,
            ruleId: rule.id,
            errorCode: startError?.code ?? 'TUNNEL_START_FAILED',
          });
        }
      }
    } catch (caught: unknown) {
      const failure = normalizeUnknownError(caught, 'TUNNEL_AUTO_START_FAILED');
      error.value = failure;
      useEventsStore().record('tunnel', 'TUNNEL_AUTO_START_FAILED', 'warning', {
        profileId,
        errorCode: failure.code,
      });
    } finally {
      autoStartInFlight.delete(requestKey);
    }
  }

  async function saveRule(input: CreateTunnelRuleInput, id?: string): Promise<boolean> {
    loading.value = true;
    error.value = null;
    try {
      const result = id
        ? await updateTunnelRule({ ...input, id })
        : await createTunnelRule(input);
      if (!result.ok) { error.value = result.error; return false; }
      const index = rules.value.findIndex((item) => item.id === result.data.id);
      if (index >= 0) rules.value[index] = result.data;
      else rules.value.unshift(result.data);
      return true;
    } finally { loading.value = false; }
  }

  async function removeRule(id: string): Promise<void> {
    const result = await deleteTunnelRule(id);
    if (result.ok) rules.value = rules.value.filter((item) => item.id !== id);
    else error.value = result.error;
  }

  async function start(input: CreateLocalTunnelInput): Promise<boolean> {
    loading.value = true;
    error.value = null;
    try {
      const result = await startLocalTunnel(input);
      if (!result.ok) {
        error.value = result.error;
        return false;
      }
      upsert(result.data);
      return true;
    } finally {
      loading.value = false;
    }
  }

  async function stop(id: string): Promise<void> {
    if (pendingStopIds.value.includes(id)) return;
    const current = tunnels.value.find((tunnel) => tunnel.id === id);
    if (current && (current.state === 'starting' || current.state === 'listening')) {
      upsert({ ...current, state: 'stopping' });
    }
    pendingStopIds.value = [...pendingStopIds.value, id];
    error.value = null;
    try {
      const result = await stopTunnel(id);
      if (result.ok) {
        upsert(result.data);
      } else {
        error.value = result.error;
        await load();
      }
    } finally {
      pendingStopIds.value = pendingStopIds.value.filter((pendingId) => pendingId !== id);
    }
  }

  function isStopPending(id: string): boolean {
    return pendingStopIds.value.includes(id);
  }

  return {
    tunnels,
    rules,
    loading,
    error,
    load,
    loadRules,
    saveRule,
    removeRule,
    start,
    stop,
    autoStartForSession,
    isStopPending,
  };
});
