<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { Network, ShieldAlert, X } from 'lucide-vue-next';
import { t } from '@/i18n';
import { useConnectionsStore } from '@/stores/connections';
import { useSessionsStore } from '@/stores/sessions';
import { useSettingsStore } from '@/stores/settings';
import { useTunnelsStore } from '@/stores/tunnels';
import { useUiStore } from '@/stores/ui';
import { isLoopbackAddress } from '@/utils/network';
import type { TunnelKind } from '@/types/contracts';

const ui = useUiStore();
const sessions = useSessionsStore();
const connections = useConnectionsStore();
const tunnels = useTunnelsStore();
const settings = useSettingsStore();
const exposureConfirmed = ref(false);
const selectedRuleId = ref('');
const profileRules = computed(() => tunnels.rules.filter((rule) => rule.profileId === connections.activeProfile?.id));
interface TunnelForm {
  name: string;
  kind: TunnelKind;
  bindHost: string;
  bindPort: number;
  targetHost: string;
  targetPort: number;
  autoStart: boolean;
}

const form = reactive<TunnelForm>({
  name: '',
  kind: 'local',
  bindHost: '127.0.0.1',
  bindPort: 8080,
  targetHost: '127.0.0.1',
  targetPort: 80,
  autoStart: false,
});
const exposesNetwork = computed(() => {
  return !isLoopbackAddress(form.bindHost);
});
const autoStartAllowed = computed(() => form.kind !== 'remote' && isLoopbackAddress(form.bindHost));

onMounted(async () => {
  await tunnels.loadRules();
  const requestedRule = tunnels.rules.find((rule) => rule.id === ui.tunnelDialogRuleId);
  if (requestedRule) {
    connections.select(requestedRule.profileId);
    selectedRuleId.value = requestedRule.id;
  }
});

watch(selectedRuleId, (id) => {
  const rule = profileRules.value.find((item) => item.id === id);
  if (!rule) return;
  form.name = rule.name;
  form.kind = rule.kind;
  form.bindHost = rule.bindHost;
  form.bindPort = rule.bindPort;
  form.targetHost = rule.targetHost ?? '';
  form.targetPort = rule.targetPort ?? 1;
  form.autoStart = rule.autoStart;
  exposureConfirmed.value = false;
});

watch([() => form.kind, () => form.bindHost], () => {
  if (!autoStartAllowed.value) form.autoStart = false;
});

function close(): void {
  if (!tunnels.loading) ui.closeTunnel();
}

async function submit(): Promise<void> {
  const session = sessions.activeSession;
  const profile = connections.activeProfile;
  if (!session || !profile || session.profileId !== profile.id) return;
  if (exposesNetwork.value && !exposureConfirmed.value) return;
  const started = await tunnels.start({
    sessionId: session.id,
    profileId: profile.id,
    name: form.name,
    kind: form.kind,
    bindHost: form.bindHost.trim(),
    bindPort: Number(form.bindPort),
    targetHost: form.kind === 'dynamic' ? null : form.targetHost.trim(),
    targetPort: form.kind === 'dynamic' ? null : Number(form.targetPort),
    allowNonLoopback: exposureConfirmed.value,
  });
  if (started) {
    settings.value.taskTab = 'tunnels';
    settings.value.taskDrawerOpen = true;
    ui.closeTunnel();
  }
}

async function saveRule(): Promise<void> {
  const profile = connections.activeProfile;
  if (!profile) return;
  const saved = await tunnels.saveRule({
    profileId: profile.id,
    name: form.name.trim(),
    kind: form.kind,
    bindHost: form.bindHost.trim(),
    bindPort: Number(form.bindPort),
    targetHost: form.kind === 'dynamic' ? null : form.targetHost.trim(),
    targetPort: form.kind === 'dynamic' ? null : Number(form.targetPort),
    autoStart: form.autoStart && autoStartAllowed.value,
  }, selectedRuleId.value || undefined);
  if (saved) {
    await tunnels.loadRules();
    const savedRule = profileRules.value.find((item) => item.name === form.name.trim());
    if (savedRule) selectedRuleId.value = savedRule.id;
  }
}

async function removeSelectedRule(): Promise<void> {
  if (!selectedRuleId.value) return;
  const ruleName = profileRules.value.find((rule) => rule.id === selectedRuleId.value)?.name ?? '';
  const accepted = await ui.confirm({
    title: t('tunnel.deleteRuleTitle'),
    message: t('tunnel.deleteRuleConfirm', { name: ruleName }),
    confirmLabel: t('tunnel.deleteRule'),
    danger: true,
  });
  if (!accepted) return;
  await tunnels.removeRule(selectedRuleId.value);
  selectedRuleId.value = '';
}
</script>

<template>
  <div class="dialog-layer" @mousedown.self="close" @keydown.esc="close">
    <form class="dialog tunnel-dialog" role="dialog" aria-modal="true" aria-labelledby="tunnel-title" @submit.prevent="submit">
      <header class="dialog-header"><div><Network :size="15" /><strong id="tunnel-title">{{ t(selectedRuleId ? 'tunnel.editTitle' : 'tunnel.title') }}</strong></div><button type="button" class="icon-button" aria-label="Close" @click="close"><X :size="14" /></button></header>
      <div class="dialog-body">
        <div class="form-grid">
          <label v-if="profileRules.length" class="field full"><span>{{ t('tunnel.savedRules') }}</span><div class="inline-field"><select v-model="selectedRuleId"><option value="">{{ t('tunnel.newRule') }}</option><option v-for="rule in profileRules" :key="rule.id" :value="rule.id">{{ rule.name }}</option></select><button v-if="selectedRuleId" type="button" class="button danger" @click="removeSelectedRule">{{ t('tunnel.deleteRule') }}</button></div></label>
          <label class="field full"><span>{{ t('tunnel.name') }}</span><input v-model="form.name" autocomplete="off"></label>
          <label class="field full"><span>{{ t('tunnel.kind') }}</span><select v-model="form.kind"><option value="local">{{ t('tunnel.local') }}</option><option value="dynamic">{{ t('tunnel.dynamic') }}</option><option value="remote">{{ t('tunnel.remote') }}</option></select></label>
          <label class="field"><span>{{ t(form.kind === 'remote' ? 'tunnel.remoteBindHost' : 'tunnel.bindHost') }}</span><input v-model="form.bindHost" spellcheck="false"></label>
          <label class="field"><span>{{ t(form.kind === 'remote' ? 'tunnel.remoteBindPort' : 'tunnel.bindPort') }}</span><input v-model.number="form.bindPort" type="number" :min="form.kind === 'remote' ? 1 : 0" max="65535"></label>
          <template v-if="form.kind !== 'dynamic'">
            <label class="field"><span>{{ t(form.kind === 'remote' ? 'tunnel.localTargetHost' : 'tunnel.targetHost') }}</span><input v-model="form.targetHost" spellcheck="false"></label>
            <label class="field"><span>{{ t(form.kind === 'remote' ? 'tunnel.localTargetPort' : 'tunnel.targetPort') }}</span><input v-model.number="form.targetPort" type="number" min="1" max="65535"></label>
          </template>
          <p v-else class="field full hint">{{ t('tunnel.dynamicHelp') }}</p>
        </div>
        <label v-if="exposesNetwork" class="trust-confirm overwrite-confirm"><input v-model="exposureConfirmed" type="checkbox"><ShieldAlert :size="13" /><span>{{ t(form.kind === 'remote' ? 'tunnel.confirmRemoteExposure' : 'tunnel.confirmExposure') }}</span></label>
        <label class="trust-confirm overwrite-confirm"><input v-model="form.autoStart" type="checkbox" :disabled="!autoStartAllowed"><span><strong>{{ t('tunnel.autoStart') }}</strong><small>{{ t('tunnel.autoStartHelp') }}</small></span></label>
        <p v-if="tunnels.error" class="form-error" role="alert">{{ t(tunnels.error.messageKey as Parameters<typeof t>[0]) }}</p>
      </div>
      <footer class="dialog-footer"><button type="button" class="button" @click="close">{{ t('profile.cancel') }}</button><button type="button" class="button" :disabled="tunnels.loading || !form.name.trim() || (form.kind !== 'dynamic' && (!form.targetHost.trim() || form.targetPort < 1)) || (form.kind === 'remote' && form.bindPort < 1)" @click="saveRule">{{ selectedRuleId ? t('tunnel.updateRule') : t('tunnel.saveRule') }}</button><button type="submit" class="button primary" :disabled="tunnels.loading || !form.name.trim() || (form.kind !== 'dynamic' && (!form.targetHost.trim() || form.targetPort < 1)) || (form.kind === 'remote' && form.bindPort < 1) || (exposesNetwork && !exposureConfirmed)">{{ t('tunnel.start') }}</button></footer>
    </form>
  </div>
</template>
