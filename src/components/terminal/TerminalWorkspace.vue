<script setup lang="ts">
import { computed } from 'vue';
import { Circle, Ellipsis, LockKeyhole, Plus, X } from 'lucide-vue-next';
import { t } from '@/i18n';
import { useConnectionsStore } from '@/stores/connections';

const connections = useConnectionsStore();
const profile = computed(() => connections.activeProfile);
const prompt = computed(() => profile.value
  ? `${profile.value.username}@${profile.value.name}:~$`
  : 'filex:~$');
</script>

<template>
  <section class="terminal-workspace" aria-label="Terminal workspace">
    <div class="terminal-tabs" role="tablist">
      <button type="button" class="terminal-tab active" role="tab" aria-selected="true">
        <span class="state-dot" :class="profile?.state ?? 'idle'" />
        <span>{{ profile?.name ?? 'No session' }}</span>
        <LockKeyhole :size="11" aria-label="Host trust not verified" />
        <X :size="12" aria-hidden="true" />
      </button>
      <button type="button" class="icon-button" aria-label="New terminal tab" disabled>
        <Plus :size="13" />
      </button>
      <span class="terminal-tabs-spacer" />
      <button type="button" class="icon-button" aria-label="More terminal actions">
        <Ellipsis :size="14" />
      </button>
    </div>

    <div class="terminal-surface" tabindex="0">
      <div class="terminal-line muted">FILEX foundation · local profile mode</div>
      <div class="terminal-line success">✓ {{ t('terminal.shellReady') }}</div>
      <div class="terminal-line warning">! {{ t('terminal.capabilityPending') }}</div>
      <div class="terminal-line muted">{{ t('terminal.prompt') }}</div>
      <div class="terminal-line prompt">
        <span>{{ prompt }}</span>
        <span class="terminal-cursor" aria-hidden="true" />
      </div>
    </div>

    <div class="terminal-context-strip">
      <span><Circle :size="8" fill="currentColor" />{{ profile?.environment ?? 'local' }}</span>
      <span class="mono">{{ profile ? `${profile.host}:${profile.port}` : '—' }}</span>
      <span>{{ profile?.latencyMs ? `${profile.latencyMs} ms` : '— ms' }}</span>
      <span>UTF-8</span>
      <span>120 × 32</span>
    </div>
  </section>
</template>
