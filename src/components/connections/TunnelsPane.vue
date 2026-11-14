<script setup lang="ts">
import { computed, onMounted } from 'vue';
import { CircleAlert, Network, Pencil, Play, Plus, Square, Trash2 } from 'lucide-vue-next';
import { t } from '@/i18n';
import { useConnectionsStore } from '@/stores/connections';
import { useSessionsStore } from '@/stores/sessions';
import { useSettingsStore } from '@/stores/settings';
import { useTunnelsStore } from '@/stores/tunnels';
import { useUiStore } from '@/stores/ui';
import { isLoopbackAddress } from '@/utils/network';
import type { TunnelRule, TunnelSummary } from '@/types/contracts';

const connections = useConnectionsStore();
const sessions = useSessionsStore();
const settings = useSettingsStore();
const tunnels = useTunnelsStore();
const ui = useUiStore();
const activeTunnels = computed(() => tunnels.tunnels.filter((tunnel) => tunnel.state !== 'stopped'));

onMounted(() => {
  void tunnels.load();
  void tunnels.loadRules();
});

function profileName(profileId: string): string {
  return connections.profiles.find((profile) => profile.id === profileId)?.name ?? t('tunnel.unknownProfile');
}

function tunnelTarget(tunnel: Pick<TunnelRule, 'kind' | 'targetHost' | 'targetPort'>): string {
  return tunnel.kind === 'dynamic' ? 'SOCKS5' : `${tunnel.targetHost}:${tunnel.targetPort}`;
}

function stateText(tunnel: TunnelSummary): string {
  if (tunnel.state === 'listening') return t('tunnel.stateListening');
  if (tunnel.state === 'starting') return t('tunnel.stateStarting');
  if (tunnel.state === 'stopping') return t('tunnel.stateStopping');
  if (tunnel.state === 'failed') return t('tunnel.stateFailed');
  return t('tunnel.stateStopped');
}

function matchingRunningTunnel(rule: TunnelRule): boolean {
  return activeTunnels.value.some((tunnel) => (
    (tunnel.state === 'starting' || tunnel.state === 'listening' || tunnel.state === 'stopping')
      && tunnel.profileId === rule.profileId
      && tunnel.name === rule.name
      && tunnel.kind === rule.kind
      && tunnel.bindHost === rule.bindHost
      && (rule.bindPort === 0 || tunnel.bindPort === rule.bindPort)
      && tunnel.targetHost === rule.targetHost
      && tunnel.targetPort === rule.targetPort
  ));
}

function editRule(rule: TunnelRule): void {
  connections.select(rule.profileId);
  ui.openTunnel(rule.id);
}

async function removeRule(rule: TunnelRule): Promise<void> {
  const accepted = await ui.confirm({
    title: t('tunnel.deleteRuleTitle'),
    message: t('tunnel.deleteRuleConfirm', { name: rule.name }),
    confirmLabel: t('tunnel.deleteRule'),
    danger: true,
  });
  if (accepted) await tunnels.removeRule(rule.id);
}

async function startRule(rule: TunnelRule): Promise<void> {
  const profile = connections.profiles.find((item) => item.id === rule.profileId);
  if (!profile) {
    ui.notify(t('tunnel.unknownProfile'));
    return;
  }
  const session = [...sessions.summaries].reverse().find((item) => item.profileId === rule.profileId && item.state === 'connected');
  if (!session) {
    connections.select(profile.id);
    if (!sessions.busy) await sessions.begin(profile);
    ui.notify(t('tunnel.connectToStart'));
    return;
  }

  const exposed = !isLoopbackAddress(rule.bindHost);
  if (exposed) {
    const target = tunnelTarget(rule);
    const disclosure = rule.kind === 'remote'
      ? t('tunnel.confirmRemoteExposure')
      : t('tunnel.confirmExposure');
    const details = rule.kind === 'remote'
      ? t('tunnel.remoteExposureDetails', { profile: profile.name, bind: `${rule.bindHost}:${rule.bindPort}`, target })
      : t('tunnel.exposureDetails', { profile: profile.name, bind: `${rule.bindHost}:${rule.bindPort}`, target });
    const accepted = await ui.confirm({
      title: t('tunnel.exposureTitle'),
      message: `${disclosure}\n\n${details}`,
      confirmLabel: t('tunnel.start'),
      danger: true,
    });
    if (!accepted) return;
  }

  const started = await tunnels.start({
    sessionId: session.id,
    profileId: profile.id,
    name: rule.name,
    kind: rule.kind,
    bindHost: rule.bindHost,
    bindPort: rule.bindPort,
    targetHost: rule.targetHost,
    targetPort: rule.targetPort,
    allowNonLoopback: exposed,
  });
  if (started) {
    settings.value.taskTab = 'tunnels';
    settings.value.taskDrawerOpen = true;
  }
}
</script>

<template>
  <section class="tunnels-pane" :aria-label="t('nav.tunnels')">
    <header class="tunnels-heading">
      <strong>{{ t('tunnel.savedRules') }}</strong>
      <button type="button" class="icon-button" :disabled="!connections.activeProfile" :aria-label="t('nav.tunnelAddRule')" :title="t('nav.tunnelAddRule')" @click="ui.openTunnel()"><Plus :size="14" /></button>
    </header>
    <p v-if="tunnels.error" class="tunnel-error" role="alert"><CircleAlert :size="13" />{{ t(tunnels.error.messageKey as Parameters<typeof t>[0]) }}</p>

    <div class="tunnel-rules-list">
      <p v-if="tunnels.rules.length === 0" class="tunnel-empty">{{ t('nav.tunnelsEmptyRules') }}</p>
      <article v-for="rule in tunnels.rules" :key="rule.id" class="tunnel-rule">
        <div class="tunnel-rule-main">
          <Network :size="13" class="tunnel-icon" />
          <span class="tunnel-copy"><strong>{{ rule.name }}</strong><small>{{ profileName(rule.profileId) }} · {{ rule.bindHost }}:{{ rule.bindPort }}</small><small>{{ t(`tunnel.${rule.kind}` as Parameters<typeof t>[0]) }} → {{ tunnelTarget(rule) }}</small><small v-if="rule.autoStart">{{ t('tunnel.autoStart') }}</small></span>
        </div>
        <div class="tunnel-actions">
          <button type="button" class="icon-button" :disabled="tunnels.loading || sessions.busy || matchingRunningTunnel(rule)" :aria-label="t(matchingRunningTunnel(rule) ? 'tunnel.alreadyRunning' : 'tunnel.start')" :title="t(matchingRunningTunnel(rule) ? 'tunnel.alreadyRunning' : 'tunnel.start')" @click="startRule(rule)"><Play :size="12" /></button>
          <button type="button" class="icon-button" :aria-label="t('tunnel.updateRule')" :title="t('tunnel.updateRule')" @click="editRule(rule)"><Pencil :size="12" /></button>
          <button type="button" class="icon-button danger" :aria-label="t('tunnel.deleteRule')" :title="t('tunnel.deleteRule')" @click="removeRule(rule)"><Trash2 :size="12" /></button>
        </div>
      </article>
    </div>

    <header class="tunnels-heading active-heading"><strong>{{ t('nav.tunnelsRunning') }}</strong><small>{{ activeTunnels.length }}</small></header>
    <div class="tunnel-rules-list active-list">
      <p v-if="activeTunnels.length === 0" class="tunnel-empty">{{ t('nav.tunnelsEmptyRunning') }}</p>
      <article v-for="tunnel in activeTunnels" :key="tunnel.id" class="tunnel-rule">
        <div class="tunnel-rule-main">
          <span class="tunnel-state-dot" :class="tunnel.state" />
          <span class="tunnel-copy"><strong>{{ tunnel.name }}</strong><small>{{ profileName(tunnel.profileId) }} · {{ tunnel.bindHost }}:{{ tunnel.bindPort }}</small><small>{{ tunnelTarget(tunnel) }} · {{ stateText(tunnel) }}</small><small v-if="tunnel.lastError" class="tunnel-error-text">{{ t(tunnel.lastError.messageKey as Parameters<typeof t>[0]) }}</small></span>
        </div>
        <button v-if="tunnel.state === 'listening' || tunnel.state === 'starting' || tunnel.state === 'stopping'" type="button" class="icon-button" :disabled="tunnels.isStopPending(tunnel.id)" :aria-label="t('tunnel.stop')" :title="t('tunnel.stop')" @click="tunnels.stop(tunnel.id)"><Square :size="12" /></button>
      </article>
    </div>
  </section>
</template>

<style scoped>
.tunnels-pane {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-height: 0;
  color: hsl(var(--foreground));
  font-size: 0.8571rem;
}
.tunnels-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px 8px;
  border-bottom: 1px solid hsl(var(--border-subtle));
}
.tunnels-heading small { color: hsl(var(--muted-foreground)); font-size: 0.75rem; }
.active-heading { margin-top: auto; border-top: 1px solid hsl(var(--border-subtle)); }
.tunnel-rules-list { min-height: 0; max-height: 55%; overflow: auto; }
.active-list { max-height: 40%; }
.tunnel-rule {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 6px;
  padding: 8px 10px;
  border-bottom: 1px solid hsl(var(--border-subtle));
  transition: background var(--duration-micro) var(--ease-arco);
}
.tunnel-rule:hover { background: hsl(var(--fill-subtle)); }
.tunnel-rule-main { display: flex; min-width: 0; align-items: flex-start; gap: 8px; }
.tunnel-icon { flex: none; margin-top: 2px; color: hsl(var(--muted-foreground)); }
.tunnel-copy { display: grid; min-width: 0; gap: 3px; }
.tunnel-copy strong, .tunnel-copy small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tunnel-copy strong { font-size: 0.8571rem; font-weight: 600; }
.tunnel-copy small { color: hsl(var(--muted-foreground)); font-size: 0.75rem; }
.tunnel-actions { display: flex; flex: none; gap: 2px; }
.tunnel-empty { margin: 0; padding: 12px; color: hsl(var(--muted-foreground)); font-size: 0.7857rem; }
.tunnel-error { display: flex; align-items: flex-start; gap: 5px; margin: 6px 10px 0; color: hsl(var(--destructive)); font-size: 0.7857rem; }
.tunnel-error-text { color: hsl(var(--destructive)) !important; }
.tunnel-state-dot { flex: none; width: 7px; height: 7px; margin: 5px 3px 0; border-radius: 50%; background: hsl(var(--muted-foreground)); }
.tunnel-state-dot.listening { background: hsl(var(--success)); }
.tunnel-state-dot.starting { background: hsl(var(--warning)); }
.tunnel-state-dot.stopping { background: hsl(var(--warning)); }
.tunnel-state-dot.failed { background: hsl(var(--destructive)); }
</style>
