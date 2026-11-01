<script setup lang="ts">
import { reactive, ref } from 'vue';
import {
  Database,
  Palette,
  RefreshCw,
  Server,
  ShieldCheck,
  TerminalSquare,
  X,
} from 'lucide-vue-next';
import { t } from '@/i18n';
import { useSettingsStore } from '@/stores/settings';
import { useUiStore } from '@/stores/ui';
import type { SafeSettings } from '@/types/contracts';

type SettingsSection = 'appearance' | 'terminal' | 'connections' | 'security' | 'storage' | 'updates';

const settings = useSettingsStore();
const ui = useUiStore();
const activeSection = ref<SettingsSection>('appearance');
const draft = reactive<SafeSettings>({ ...settings.value });

const sections: { id: SettingsSection; label: Parameters<typeof t>[0]; icon: typeof Palette }[] = [
  { id: 'appearance', label: 'settings.appearance', icon: Palette },
  { id: 'terminal', label: 'settings.terminal', icon: TerminalSquare },
  { id: 'connections', label: 'settings.connections', icon: Server },
  { id: 'security', label: 'settings.security', icon: ShieldCheck },
  { id: 'storage', label: 'settings.storage', icon: Database },
  { id: 'updates', label: 'settings.updates', icon: RefreshCw },
];

function save(): void {
  settings.save({ ...draft });
  ui.closeSettings();
  ui.notify(t('settings.saved'));
}

function reset(): void {
  Object.assign(draft, settings.reset());
}
</script>

<template>
  <div class="dialog-layer" @mousedown.self="ui.closeSettings" @keydown.esc="ui.closeSettings">
    <section class="dialog settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title">
      <header class="dialog-header">
        <strong id="settings-title">{{ t('settings.title') }}</strong>
        <button type="button" class="icon-button" aria-label="Close" @click="ui.closeSettings"><X :size="14" /></button>
      </header>
      <div class="settings-body">
        <nav class="settings-nav" aria-label="Settings sections">
          <button
            v-for="(section, index) in sections"
            :key="section.id"
            type="button"
            :autofocus="index === 0"
            :aria-current="activeSection === section.id ? 'page' : undefined"
            @click="activeSection = section.id"
          >
            <component :is="section.icon" :size="14" />
            <span>{{ t(section.label) }}</span>
          </button>
        </nav>

        <div class="settings-content">
          <section v-if="activeSection === 'appearance'">
            <h2>{{ t('settings.appearance') }}</h2>
            <p>{{ t('settings.themeHelp') }}</p>
            <div class="setting-row">
              <div><strong>{{ t('settings.theme') }}</strong><small>{{ t('settings.themeHelp') }}</small></div>
              <div class="segmented">
                <button type="button" :aria-pressed="draft.theme === 'system'" @click="draft.theme = 'system'">{{ t('settings.system') }}</button>
                <button type="button" :aria-pressed="draft.theme === 'dark'" @click="draft.theme = 'dark'">{{ t('settings.dark') }}</button>
                <button type="button" :aria-pressed="draft.theme === 'light'" @click="draft.theme = 'light'">{{ t('settings.light') }}</button>
              </div>
            </div>
            <div class="setting-row">
              <div><strong>{{ t('settings.language') }}</strong></div>
              <select v-model="draft.locale"><option value="zh-CN">简体中文</option><option value="en-US">English</option></select>
            </div>
            <div class="setting-row">
              <div><strong>{{ t('settings.uiSize') }}</strong><small>11–20 px</small></div>
              <label class="range-control"><input v-model.number="draft.uiFontSize" type="range" min="11" max="20"><span>{{ draft.uiFontSize }} px</span></label>
            </div>
            <div class="setting-row">
              <div><strong>{{ t('settings.reduceMotion') }}</strong></div>
              <label class="switch"><input v-model="draft.reduceMotion" type="checkbox"><span /></label>
            </div>
          </section>

          <section v-else-if="activeSection === 'terminal'">
            <h2>{{ t('settings.terminal') }}</h2>
            <div class="setting-row"><div><strong>{{ t('settings.terminalFont') }}</strong></div><input v-model="draft.terminalFontFamily"></div>
            <div class="setting-row"><div><strong>{{ t('settings.terminalSize') }}</strong></div><label class="range-control"><input v-model.number="draft.terminalFontSize" type="range" min="11" max="24"><span>{{ draft.terminalFontSize }} px</span></label></div>
            <div class="setting-row"><div><strong>Scrollback</strong><small>Bounded per terminal instance</small></div><select><option>10,000 lines</option><option>25,000 lines</option></select></div>
            <div class="setting-row"><div><strong>Multiline paste protection</strong></div><label class="switch"><input type="checkbox" checked><span /></label></div>
          </section>

          <section v-else-if="activeSection === 'connections'">
            <h2>{{ t('settings.connections') }}</h2>
            <div class="setting-row"><div><strong>Connection timeout</strong></div><select><option>15 seconds</option><option>30 seconds</option></select></div>
            <div class="setting-row"><div><strong>Keepalive interval</strong></div><select><option>30 seconds</option><option>60 seconds</option><option>Off</option></select></div>
            <div class="setting-row"><div><strong>Automatic reconnect</strong><small>Bounded retries with jitter</small></div><select><option>Up to 3 attempts</option><option>Off</option></select></div>
          </section>

          <section v-else-if="activeSection === 'security'">
            <h2>{{ t('settings.security') }}</h2>
            <div class="setting-row"><div><strong>{{ t('settings.safeStorage') }}</strong></div><span class="status-pill pending">{{ t('settings.notProbed') }}</span></div>
            <div class="setting-row"><div><strong>{{ t('settings.hostKeyPolicy') }}</strong></div><select><option>{{ t('settings.hostKeyStrict') }}</option></select></div>
            <div class="setting-row"><div><strong>{{ t('settings.logging') }}</strong></div><select><option>{{ t('settings.loggingOff') }}</option></select></div>
          </section>

          <section v-else-if="activeSection === 'storage'">
            <h2>{{ t('settings.storage') }}</h2>
            <div class="setting-row"><div><strong>{{ t('settings.dataDirectory') }}</strong><small>{{ t('settings.localData') }}</small></div><input value="%APPDATA%\FILEX" readonly></div>
            <div class="setting-row"><div><strong>Automatic backup</strong><small>Non-secret configuration only</small></div><select><option>Daily</option><option>Weekly</option><option>Off</option></select></div>
          </section>

          <section v-else>
            <h2>{{ t('settings.updates') }}</h2>
            <div class="setting-row"><div><strong>{{ t('settings.updateChannel') }}</strong></div><select><option>{{ t('settings.stable') }}</option></select></div>
            <div class="setting-row"><div><strong>{{ t('settings.version') }}</strong></div><span class="mono">FILEX 0.1.0-foundation</span></div>
          </section>
        </div>
      </div>
      <footer class="dialog-footer settings-footer">
        <button type="button" class="button" @click="reset">{{ t('settings.reset') }}</button>
        <span class="spacer" />
        <button type="button" class="button" @click="ui.closeSettings">{{ t('settings.cancel') }}</button>
        <button type="button" class="button primary" @click="save">{{ t('settings.save') }}</button>
      </footer>
    </section>
  </div>
</template>
