import { expect, test, type Page } from '@playwright/test';

interface BrowserDiagnostics {
  pageErrors: string[];
  failedRequests: string[];
  consoleErrors: string[];
}

const diagnosticsByPage = new WeakMap<Page, BrowserDiagnostics>();

test.beforeEach(async ({ page }) => {
  const diagnostics: BrowserDiagnostics = { pageErrors: [], failedRequests: [], consoleErrors: [] };
  diagnosticsByPage.set(page, diagnostics);
  page.on('pageerror', (error) => diagnostics.pageErrors.push(error.message));
  page.on('requestfailed', (request) => {
    const failure = request.failure()?.errorText ?? 'request failed';
    diagnostics.failedRequests.push(`${request.method()} ${sanitizeRequestUrl(request.url())}: ${failure}`);
  });
  page.on('console', (message) => {
    if (message.type() === 'error') diagnostics.consoleErrors.push(message.text());
  });
  await page.goto('/');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
});

test.afterEach(async ({ page }, testInfo) => {
  const diagnostics = diagnosticsByPage.get(page);
  if (!diagnostics) return;
  await testInfo.attach('browser-runtime-diagnostics.json', {
    body: JSON.stringify(diagnostics, null, 2),
    contentType: 'application/json',
  });
  expect(diagnostics.pageErrors, 'uncaught page errors').toEqual([]);
  expect(diagnostics.failedRequests, 'failed requests').toEqual([]);
  expect(diagnostics.consoleErrors, 'console errors').toEqual([]);
});

function sanitizeRequestUrl(value: string): string {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return '[invalid URL]';
  }
}

test('creates and restores a safe connection profile', async ({ page }) => {
  await page.getByRole('button', { name: '添加连接' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('名称').fill('e2e-node');
  await dialog.getByLabel('主机', { exact: true }).fill('192.0.2.50');
  await dialog.getByLabel('用户名').fill('operator');
  await dialog.getByRole('button', { name: '保存资料' }).click();
  const connectionRow = page.locator('.connection-row', { hasText: 'e2e-node' });
  await expect(connectionRow).toBeVisible();
  await page.reload();
  await expect(connectionRow).toBeVisible();
});

test('double-click and Enter start the selected connection', async ({ page }) => {
  await page.getByRole('button', { name: '添加连接' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('名称').fill('open-with-activation');
  await dialog.getByLabel('主机', { exact: true }).fill('192.0.2.61');
  await dialog.getByLabel('用户名').fill('operator');
  await dialog.getByRole('button', { name: '保存资料' }).click();

  const connectionRow = page.locator('.connection-row', { hasText: 'open-with-activation' });
  await connectionRow.dblclick();
  await expect(page.getByRole('alert')).toContainText('桌面应用');

  await page.getByRole('button', { name: '关闭提示' }).click();
  await connectionRow.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('alert')).toContainText('桌面应用');
});

test('supports keyboard shortcuts and accessible pane resizing', async ({ page }) => {
  await page.keyboard.press('Control+1');
  await expect(page.getByPlaceholder('筛选连接')).toBeFocused();
  await page.getByPlaceholder('筛选连接').blur();

  await page.keyboard.press('Control+J');
  await expect(page.locator('.task-drawer')).toBeVisible();
  await page.keyboard.press('Control+J');
  await expect(page.locator('.task-drawer')).toHaveCount(0);

  const separator = page.getByRole('separator', { name: 'Resize connections pane' });
  await separator.focus();
  await page.keyboard.press('ArrowRight');
  const width = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--connections-pane-width'));
  expect(Number.parseInt(width, 10)).toBeGreaterThan(244);
});

test('suppresses the WebView native context menu', async ({ page }) => {
  const defaultPrevented = await page.evaluate(() => {
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    document.body.dispatchEvent(event);
    return event.defaultPrevented;
  });

  expect(defaultPrevented).toBe(true);
});

test('exposes the local terminal context menu', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.locator('.command-input-bar')).toHaveCount(0);
  await expect(page.locator('.host-panel')).toHaveCount(0);
  await expect(page.locator('.terminal-quick-ops')).toBeVisible();
  await page.locator('.terminal-pane-surface').click({ button: 'right', position: { x: 80, y: 70 } });
  const menu = page.getByRole('menu', { name: '终端窗格' });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: '粘贴' })).toBeFocused();
  await expect(menu.getByRole('menuitem', { name: '全选' })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: '清空终端显示' })).toBeVisible();
  await page.screenshot({ path: 'test-results/terminal-context-menu-1440.png' });
  await menu.getByRole('menuitem', { name: '清空终端显示' }).click();
  await expect(menu).toHaveCount(0);
});

test('opens the assistant and configures provider presets in the shared settings surface', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(() => {
    const key = 'filex.safe-settings.v1';
    const current = JSON.parse(localStorage.getItem(key) || '{}') as Record<string, unknown>;
    localStorage.setItem(key, JSON.stringify({ ...current, theme: 'dark', locale: 'zh-CN' }));
  });
  await page.reload();

  await page.getByRole('button', { name: 'AI 助手', exact: true }).click();
  const assistantPanel = page.locator('.assistant-panel');
  await expect(assistantPanel).toBeVisible();
  await expect(assistantPanel.getByRole('button', { name: '配置助手' })).toBeVisible();
  await expect(assistantPanel.getByText('先配置 AI 提供商')).toBeVisible();
  await assistantPanel.locator('.assistant-title-button').click();
  const conversationMenu = assistantPanel.locator('.assistant-conversation-menu');
  await expect(conversationMenu).toBeVisible();
  await conversationMenu.getByRole('button', { name: '新建对话', exact: true }).click();
  await expect(conversationMenu).toHaveCount(0);
  await assistantPanel.getByRole('button', { name: '上下文' }).click();
  await expect(assistantPanel.getByText('上下文与数据范围')).toBeVisible();
  await assistantPanel.getByRole('button', { name: '收起菜单' }).click();
  const assistantSeparator = page.getByRole('separator', { name: '调整 AI 助手面板宽度' });
  await assistantSeparator.focus();
  await page.keyboard.press('ArrowLeft');
  const assistantWidth = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--assistant-pane-width'));
  expect(Number.parseInt(assistantWidth, 10)).toBeGreaterThan(360);
  await page.screenshot({ path: 'test-results/assistant-panel-dark-1440.png' });

  await assistantPanel.getByRole('button', { name: '打开 AI 设置' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'AI 助手' })).toBeVisible();
  const providerSelect = dialog.locator('[data-testid="assistant-provider-select"]');
  await expect(providerSelect).toHaveValue('openai');
  await providerSelect.selectOption('deepseek');
  await expect(dialog.getByLabel('服务地址')).toHaveValue('https://api.deepseek.com/v1');
  await expect(dialog.locator('input[list="assistant-model-suggestions"]')).toHaveValue('deepseek-chat');
  await expect(dialog.getByText('远程端点必须提供 API 密钥')).toBeVisible();

  await page.screenshot({ path: 'test-results/assistant-settings-dark.png' });
  await dialog.getByRole('button', { name: '取消' }).click();
  await expect(dialog).toHaveCount(0);
});

test('keeps the assistant workbench bounded at minimum size with enlarged text', async ({ page }) => {
  await page.setViewportSize({ width: 960, height: 640 });
  await page.evaluate(() => {
    const key = 'filex.safe-settings.v1';
    const current = JSON.parse(localStorage.getItem(key) || '{}') as Record<string, unknown>;
    localStorage.setItem(key, JSON.stringify({
      ...current,
      theme: 'light',
      locale: 'zh-CN',
      uiFontSize: 20,
    }));
  });
  await page.reload();

  await page.getByRole('button', { name: 'AI 助手', exact: true }).click();
  const panel = page.locator('.assistant-panel');
  await expect(panel).toBeVisible();
  const panelBox = await panel.boundingBox();
  expect(panelBox).not.toBeNull();
  expect(panelBox!.x).toBeGreaterThanOrEqual(0);
  expect(panelBox!.x + panelBox!.width).toBeLessThanOrEqual(960);
  expect(panelBox!.y + panelBox!.height).toBeLessThanOrEqual(640);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await expect(panel.getByRole('button', { name: '打开 AI 设置' })).toBeVisible();
  await expect(panel.locator('.assistant-compose textarea')).toBeVisible();
  await page.screenshot({ path: 'test-results/assistant-panel-light-960-font20.png' });

  await panel.getByRole('button', { name: '打开 AI 设置' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'AI 助手' })).toBeVisible();
  const dialogBox = await dialog.boundingBox();
  expect(dialogBox).not.toBeNull();
  expect(dialogBox!.x).toBeGreaterThanOrEqual(0);
  expect(dialogBox!.y).toBeGreaterThanOrEqual(0);
  expect(dialogBox!.x + dialogBox!.width).toBeLessThanOrEqual(960);
  expect(dialogBox!.y + dialogBox!.height).toBeLessThanOrEqual(640);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/assistant-settings-light-960-font20.png' });
});

test('previews and saves a terminal palette only after confirmation', async ({ page }) => {
  const storedTheme = () => page.evaluate(() => {
    const settings = JSON.parse(localStorage.getItem('filex.safe-settings.v1') ?? '{}') as {
      terminalTheme?: string;
    };
    return settings.terminalTheme;
  });

  const initialTheme = await storedTheme();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  let dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: '终端', exact: true }).click();

  const themeList = dialog.getByRole('listbox', { name: '终端配色方案' });
  await themeList.getByRole('option', { name: /^Dracula/ }).click();
  await expect(dialog.locator('.theme-preview-screen')).toHaveCSS('background-color', 'rgb(40, 42, 54)');
  expect(await storedTheme()).toBe(initialTheme);
  await page.screenshot({ path: 'test-results/terminal-theme-picker-dark.png' });

  await dialog.getByRole('button', { name: '取消' }).click();
  expect(await storedTheme()).toBe(initialTheme);

  await page.getByRole('button', { name: '设置', exact: true }).click();
  dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: '终端', exact: true }).click();
  await dialog.getByRole('listbox', { name: '终端配色方案' })
    .getByRole('option', { name: /^Nord/ })
    .click();
  await dialog.getByRole('button', { name: '应用并保存' }).click();

  await expect(dialog).toHaveCount(0);
  await expect.poll(storedTheme).toBe('nord');
  await page.reload();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: '终端', exact: true }).click();
  await expect(
    dialog.getByRole('listbox', { name: '终端配色方案' }).getByRole('option', { name: /^Nord/ }),
  ).toHaveAttribute('aria-selected', 'true');
});

test('keeps the terminal palette preview usable at minimum size in light theme', async ({ page }) => {
  await page.setViewportSize({ width: 960, height: 640 });
  await page.evaluate(() => {
    const key = 'filex.safe-settings.v1';
    const current = JSON.parse(localStorage.getItem(key) ?? '{}') as Record<string, unknown>;
    localStorage.setItem(key, JSON.stringify({
      ...current,
      theme: 'light',
      locale: 'zh-CN',
      uiFontSize: 20,
      terminalTheme: 'github-light',
    }));
  });
  await page.reload();

  await page.getByRole('button', { name: '设置', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: '终端', exact: true }).click();
  const preview = dialog.locator('.terminal-theme-preview');
  await expect(preview).toBeVisible();
  await expect(dialog.locator('.theme-preview-screen')).toHaveCSS('background-color', 'rgb(255, 255, 255)');

  const dialogBox = await dialog.boundingBox();
  const previewBox = await preview.boundingBox();
  expect(dialogBox).not.toBeNull();
  expect(previewBox).not.toBeNull();
  expect(previewBox!.x).toBeGreaterThanOrEqual(dialogBox!.x);
  expect(previewBox!.y).toBeGreaterThanOrEqual(dialogBox!.y);
  expect(previewBox!.x + previewBox!.width).toBeLessThanOrEqual(dialogBox!.x + dialogBox!.width);
  expect(previewBox!.y + previewBox!.height).toBeLessThanOrEqual(dialogBox!.y + dialogBox!.height);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  await page.screenshot({ path: 'test-results/terminal-theme-picker-light-960.png' });
});

test('keeps the context bar within bounds at minimum size and maximum font', async ({ page }) => {
  await page.setViewportSize({ width: 960, height: 640 });
  await page.evaluate(() => {
    const key = 'filex.safe-settings.v1';
    const current = JSON.parse(localStorage.getItem(key) || '{}') as Record<string, unknown>;
    localStorage.setItem(key, JSON.stringify({
      ...current,
      locale: 'zh-CN',
      uiFontFamily: '"HarmonyOS Sans SC", "HarmonyOS Sans", "PingFang SC", "Microsoft YaHei UI", "Noto Sans CJK SC", sans-serif',
      uiFontSize: 20,
    }));
  });
  await page.reload();

  const header = page.locator('.context-bar');
  const newSession = page.locator('.context-actions button.primary');
  const headerBox = await header.boundingBox();
  const buttonBox = await newSession.boundingBox();
  expect(headerBox).not.toBeNull();
  expect(buttonBox).not.toBeNull();
  expect(buttonBox!.y).toBeGreaterThanOrEqual(headerBox!.y);
  expect(buttonBox!.y + buttonBox!.height).toBeLessThanOrEqual(headerBox!.y + headerBox!.height);
  expect(await newSession.evaluate((element) => getComputedStyle(element).whiteSpace)).toBe('nowrap');
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).fontSize)).toBe('20px');
  expect(await page.evaluate(() => getComputedStyle(document.body).fontFamily)).toContain('HarmonyOS Sans SC');
  expect(await page.evaluate(async () => (await document.fonts.load('400 20px "HarmonyOS Sans SC"')).length > 0)).toBe(true);
  expect(await page.evaluate(async () => (await document.fonts.load('700 20px "HarmonyOS Sans SC"')).length > 0)).toBe(true);

  const fileBrowser = page.locator('.file-browser-panel');
  const emptyState = fileBrowser.locator('.task-empty').first();
  const fileBrowserBox = await fileBrowser.boundingBox();
  const emptyStateBox = await emptyState.boundingBox();
  expect(fileBrowserBox).not.toBeNull();
  expect(emptyStateBox).not.toBeNull();
  expect(emptyStateBox!.y).toBeGreaterThanOrEqual(fileBrowserBox!.y);
  expect(emptyStateBox!.y + emptyStateBox!.height).toBeLessThanOrEqual(fileBrowserBox!.y + fileBrowserBox!.height);
});

test('defaults to password authentication and shows all three authentication options', async ({ page }) => {
  await page.getByRole('button', { name: '添加连接' }).click();
  const dialog = page.getByRole('dialog');
  const authentication = dialog.getByLabel('认证方式');

  await expect(authentication).toHaveValue('password');
  await expect(authentication.locator('option')).toHaveCount(3);
});

test('aligns host and authentication controls at the same field baseline', async ({ page }) => {
  await page.setViewportSize({ width: 960, height: 640 });
  await page.evaluate(() => {
    const key = 'filex.safe-settings.v1';
    const current = JSON.parse(localStorage.getItem(key) || '{}') as Record<string, unknown>;
    localStorage.setItem(key, JSON.stringify({ ...current, uiFontSize: 20 }));
  });
  await page.reload();
  await page.getByRole('button', { name: '添加连接' }).click();

  const fields = page.getByRole('dialog').locator('.form-grid > .field');
  const hostInput = fields.nth(1).locator('input');
  const authenticationSelect = fields.nth(2).locator('select');
  const hostBox = await hostInput.boundingBox();
  const authenticationBox = await authenticationSelect.boundingBox();
  expect(hostBox).not.toBeNull();
  expect(authenticationBox).not.toBeNull();
  expect(Math.abs(hostBox!.y - authenticationBox!.y)).toBeLessThanOrEqual(1);
  expect(Math.abs(hostBox!.height - authenticationBox!.height)).toBeLessThanOrEqual(1);
});

test('blocks ProxyJump profiles before opening an SSH trust or password dialog', async ({ page }) => {
  // The app ships no seed profiles; each test installs its own fixture.
  await page.evaluate(() => {
    const fixture = [{
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
    }];
    localStorage.setItem('filex.connection-profiles.v1', JSON.stringify(fixture));
  });
  await page.reload();
  await page.evaluate(() => {
    const storageKey = 'filex.connection-profiles.v1';
    const profiles = JSON.parse(localStorage.getItem(storageKey) ?? '[]') as Array<{
      id: string;
      proxyJump: string | null;
    }>;
    const profile = profiles.find((item) => item.id === 'dev-sandbox');
    if (!profile) throw new Error('Browser fixture profile was not initialized');
    profile.proxyJump = 'bastion.internal';
    localStorage.setItem(storageKey, JSON.stringify(profiles));
  });
  await page.reload();

  await page.locator('.connection-row', { hasText: 'dev-sandbox' }).click();
  await page.getByRole('button', { name: '重新连接' }).click();

  await expect(page.getByRole('alert')).toContainText('ProxyJump');
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('allows SSH Agent profiles through preflight and reaches the desktop runtime boundary', async ({ page }) => {
  await page.evaluate(() => {
    const fixture = [{
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
      lastUsedAt: null,
    }];
    localStorage.setItem('filex.connection-profiles.v1', JSON.stringify(fixture));
  });
  await page.reload();

  await page.locator('.connection-row', { hasText: 'worker-canary' }).click();
  await page.getByRole('button', { name: '重新连接' }).click();

  await expect(page.getByRole('alert')).toContainText('桌面应用');
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('persists the file editing mode and exposes the external editor tool picker', async ({ page }) => {
  await page.getByRole('button', { name: '设置', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: '连接', exact: true }).click();
  await expect(dialog.getByText('文件编辑方式')).toBeVisible();
  await dialog.locator('.setting-row', { hasText: '文件编辑方式' }).locator('select').selectOption('external');
  await expect(dialog.getByRole('button', { name: '选择工具' })).toBeVisible();
  await dialog.getByRole('button', { name: '应用并保存' }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(async () => page.evaluate(() => {
    const settings = JSON.parse(localStorage.getItem('filex.safe-settings.v1') ?? '{}') as {
      textEditorPreference?: string;
    };
    return settings.textEditorPreference;
  })).toBe('external');
});

test('shows successful quick connections in both connection and recent views', async ({ page }) => {
  await page.waitForFunction(() => Boolean(
    (document.querySelector('#app') as HTMLElement & { __vue_app__?: unknown }).__vue_app__,
  ));
  await page.evaluate(() => {
    type Store = Record<string, unknown>;
    type Root = HTMLElement & {
      __vue_app__?: {
        config: { globalProperties: { $pinia?: { _s: Map<string, Store> } } };
      };
    };
    const pinia = (document.querySelector('#app') as Root).__vue_app__
      ?.config.globalProperties.$pinia;
    const connections = pinia?._s.get('connections');
    const sessions = pinia?._s.get('sessions');
    if (!connections || !sessions) throw new Error('Connection stores unavailable');
    const now = new Date().toISOString();
    const quickProfile = {
      id: 'quick-profile-live',
      name: 'root@10.24.1.42',
      group: '',
      host: '10.24.1.42',
      port: 22,
      username: 'root',
      environment: 'development',
      favorite: false,
      tags: [],
      authenticationMethod: 'password',
      identityFile: null,
      proxyJump: null,
      proxyJumpProfileIds: [],
      credentialRef: null,
      state: 'connected',
      latencyMs: null,
      lastUsedAt: now,
    };
    connections.profiles = [];
    connections.activeProfileId = quickProfile.id;
    sessions.quickProfiles = { [quickProfile.id]: quickProfile };
    sessions.summaries = [{
      id: 'quick-session-live',
      generation: 1,
      profileId: quickProfile.id,
      state: 'connected',
      host: quickProfile.host,
      port: quickProfile.port,
      username: quickProfile.username,
      lastError: null,
    }];
    sessions.activeSessionId = 'quick-session-live';
  });

  await expect(page.getByText('临时连接', { exact: true })).toBeVisible();
  const quickRow = page.locator('.connections-pane .connection-row', { hasText: 'root@10.24.1.42' });
  await expect(quickRow).toBeVisible();
  await quickRow.click();
  await expect(page.locator('.connections-pane .state-dot.connected').first()).toBeVisible();

  await page.locator('.nav-mode').getByRole('button', { name: '最近', exact: true }).click();
  await expect(page.locator('.recent-row', { hasText: 'root@10.24.1.42' })).toBeVisible();
  await expect(page.locator('.recent-row')).toContainText('最近连接：');
  await expect(page.getByText('还没有成功连接过的主机。')).toHaveCount(0);
  await page.screenshot({ path: 'test-results/quick-connection-recent-1440.png' });
});

test('exposes the keyboard-accessible file menu and recursive permission controls', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForFunction(() => Boolean(
    (document.querySelector('#app') as HTMLElement & { __vue_app__?: unknown }).__vue_app__,
  ));
  await page.evaluate(() => {
    type Store = Record<string, unknown>;
    type Root = HTMLElement & {
      __vue_app__?: {
        config: { globalProperties: { $pinia?: { _s: Map<string, Store> } } };
      };
    };
    const pinia = (document.querySelector('#app') as Root).__vue_app__
      ?.config.globalProperties.$pinia;
    const sessions = pinia?._s.get('sessions');
    const sftp = pinia?._s.get('sftp');
    const settings = pinia?._s.get('settings');
    const localFiles = pinia?._s.get('local-files');
    if (!sessions || !sftp || !settings || !localFiles) {
      throw new Error('File browser fixture stores were not initialized');
    }
    const session = {
      id: 'session-file-menu',
      generation: 1,
      profileId: 'profile-file-menu',
      state: 'connected',
      host: '10.24.1.42',
      port: 22,
      username: 'operator',
      lastError: null,
    };
    sessions.summaries = [session];
    sessions.activeSessionId = session.id;
    sessions.isQuickProfile = () => false;
    sftp.load = () => Promise.resolve();
    sftp.sessionId = session.id;
    sftp.path = '/srv/releases';
    sftp.entries = [
      {
        name: 'current',
        path: '/srv/releases/current',
        isDirectory: true,
        isSymlink: false,
        size: null,
        modifiedAtMs: Date.now(),
        permissionsMode: 0o755,
        uid: 0,
        gid: 0,
      },
      {
        name: 'release.env',
        path: '/srv/releases/release.env',
        isDirectory: false,
        isSymlink: false,
        size: 128,
        modifiedAtMs: Date.now(),
        permissionsMode: 0o640,
        uid: 0,
        gid: 0,
      },
    ];
    Object.assign(settings.value as Record<string, unknown>, {
      fileBrowserOpen: true,
      focusMode: false,
      dualPaneSftp: false,
      taskDrawerOpen: false,
      locale: 'zh-CN',
      fileBrowserHeight: 260,
      textEditorPreference: 'internal',
      externalEditorPath: 'C:\\Tools\\editor.exe',
    });
  });

  const resize = page.getByRole('separator', { name: 'Resize file browser' });
  await resize.focus();
  for (let index = 0; index < 30; index += 1) await resize.press('ArrowUp');
  const browserHeight = await page.locator('.file-browser-panel-slot').evaluate((element) => {
    return element.getBoundingClientRect().height;
  });
  expect(browserHeight).toBeGreaterThan(480);

  const folder = page.locator('.file-row', { hasText: 'current' });
  await folder.click({ button: 'right' });
  const menu = page.getByRole('menu', { name: '文件操作' });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: '刷新' })).toBeFocused();
  for (const label of ['上传文件…', '上传文件夹…', '快速删除（递归）', '文件权限…']) {
    await expect(menu.getByRole('menuitem', { name: label })).toBeVisible();
  }
  await page.screenshot({ path: 'test-results/file-context-menu-1440.png' });

  await menu.getByRole('menuitem', { name: '文件权限…' }).click();
  const permissionDialog = page.getByRole('dialog', { name: '修改权限' });
  await expect(permissionDialog).toBeVisible();
  await permissionDialog.getByLabel('应用到子目录内容').check();
  await expect(permissionDialog.getByRole('radiogroup', { name: '应用范围' })).toBeVisible();
  await permissionDialog.getByRole('radio', { name: '仅文件', exact: true }).check();
  await expect(permissionDialog.getByText('递归修改会先检查最多 5,000 项和 16 层目录；符号链接不会被跟随。')).toBeVisible();
  await page.screenshot({ path: 'test-results/file-context-permission-1440.png' });
  await permissionDialog.getByRole('button', { name: '取消' }).click();

  const file = page.locator('.file-row', { hasText: 'release.env' });
  await file.focus();
  await page.keyboard.press('Shift+F10');
  await expect(menu).toBeVisible();
  await menu.getByRole('menuitem', { name: '选择文本编辑器' }).hover();
  await menu.getByRole('menuitemradio', { name: '外部编辑器' }).click();
  await expect.poll(async () => page.evaluate(() => {
    const settings = JSON.parse(localStorage.getItem('filex.safe-settings.v1') ?? '{}') as {
      textEditorPreference?: string;
    };
    return settings.textEditorPreference;
  })).toBe('external');

  await page.setViewportSize({ width: 960, height: 640 });
  await file.click({ button: 'right' });
  const compactMenu = page.getByRole('menu', { name: '文件操作' });
  await expect(compactMenu).toBeVisible();
  const menuBox = await compactMenu.boundingBox();
  expect(menuBox).not.toBeNull();
  expect(menuBox!.x).toBeGreaterThanOrEqual(0);
  expect(menuBox!.y).toBeGreaterThanOrEqual(0);
  expect(menuBox!.x + menuBox!.width).toBeLessThanOrEqual(960);
  expect(menuBox!.y + menuBox!.height).toBeLessThanOrEqual(640);
  await page.screenshot({ path: 'test-results/file-context-menu-960x640.png' });
});

test('inspects complete session-scoped process, network, interface and route views', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForFunction(() => Boolean(
    (document.querySelector('#app') as HTMLElement & { __vue_app__?: unknown }).__vue_app__,
  ));
  await page.evaluate(() => {
    type StoreLike = Record<string, unknown> & {
      $patch?: (value: Record<string, unknown>) => void;
    };
    type AppRoot = HTMLElement & {
      __vue_app__?: {
        _context: { provides: Record<PropertyKey, unknown> };
        config: { globalProperties: { $pinia?: PiniaLike } };
      };
    };
    type PiniaLike = {
      _s: Map<string, StoreLike>;
    };

    const root = document.querySelector('#app') as AppRoot;
    const app = root.__vue_app__;
    if (!app) throw new Error('Vue application was not available for the monitoring fixture');
    const pinia = app.config.globalProperties.$pinia;
    if (!pinia) throw new Error('Pinia store registry was not available for the monitoring fixture');

    const sessions = pinia._s.get('sessions');
    const settings = pinia._s.get('settings');
    if (!sessions || !settings) {
      throw new Error('Core monitoring fixture stores were not initialized');
    }

    Object.assign(settings.value as Record<string, unknown>, {
      hostPanelOpen: true,
      focusMode: false,
      locale: 'zh-CN',
      theme: 'dark',
    });
    (settings.apply as (() => void) | undefined)?.();
    sessions.summaries = [
      {
        id: 'session-alpha',
        generation: 1,
        profileId: 'profile-alpha',
        state: 'connected',
        host: '10.24.1.33',
        port: 22,
        username: 'ops',
        lastError: null,
      },
      {
        id: 'session-beta',
        generation: 1,
        profileId: 'profile-beta',
        state: 'connected',
        host: '10.24.1.34',
        port: 22,
        username: 'ops',
        lastError: null,
      },
    ];
    sessions.activeSessionId = 'session-alpha';
  });

  await expect(page.locator('.host-panel')).toHaveCount(0);
  const quickOps = page.locator('.terminal-quick-ops');
  await expect(quickOps).toBeVisible();
  await page.evaluate(() => {
    const root = document.querySelector('#app') as HTMLElement & {
      __vue_app__?: {
        config: {
          globalProperties: {
            $pinia?: { _s: Map<string, Record<string, unknown>> };
          };
        };
      };
    };
    const pinia = root.__vue_app__?.config.globalProperties.$pinia;
    const processes = pinia?._s.get('processes');
    const monitor = pinia?._s.get('monitor');
    if (!processes || !monitor) throw new Error('Monitor polling stores were not initialized');

    processes.collect = () => Promise.resolve();
    monitor.collect = () => Promise.resolve();
    (processes.clear as (() => void) | undefined)?.();
    (monitor.clear as (() => void) | undefined)?.();
    processes.snapshot = {
      state: 'live',
      platform: 'posix',
      collectedAtMs: Date.now(),
      snapshotId: 'process-snapshot-alpha',
      truncated: true,
      processes: [
        {
          pid: 4242,
          parentPid: 1,
          name: 'filex-agent',
          user: 'ops',
          cpuPercent: 12.5,
          cpuTimeSeconds: 62,
          memoryBytes: 268_435_456,
          state: 'S',
          startedAtMs: Date.parse('2026-11-10T09:30:00+08:00'),
          canTerminate: true,
        },
        {
          pid: 1919,
          parentPid: 1,
          name: 'nginx',
          user: 'www-data',
          cpuPercent: 2.1,
          cpuTimeSeconds: 9,
          memoryBytes: 67_108_864,
          state: 'S',
          startedAtMs: Date.parse('2026-11-09T08:00:00+08:00'),
          canTerminate: true,
        },
      ],
    };
  });

  await quickOps.getByRole('button', { name: '网络', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '主机监控详情' });
  await expect(dialog).toBeVisible();
  await page.evaluate(() => {
    const root = document.querySelector('#app') as HTMLElement & {
      __vue_app__?: {
        config: {
          globalProperties: {
            $pinia?: { _s: Map<string, Record<string, unknown>> };
          };
        };
      };
    };
    const pinia = root.__vue_app__?.config.globalProperties.$pinia;
    const network = pinia?._s.get('network');
    if (!network) throw new Error('Network store was not initialized');

    network.collect = () => Promise.resolve();
    (network.clear as (() => void) | undefined)?.();
    network.snapshot = {
      state: 'live',
      platform: 'linux',
      collectedAtMs: Date.now(),
      interfaces: [
        {
          name: 'eth0',
          state: 'up',
          addresses: ['10.24.1.33/24', 'fe80::21/64'],
          mtu: 1500,
          receivedBytes: 8_589_934_592,
          transmittedBytes: 4_294_967_296,
          loopback: false,
        },
        {
          name: 'eth1',
          state: 'up',
          addresses: ['10.24.2.33/24'],
          mtu: 9000,
          receivedBytes: 2_147_483_648,
          transmittedBytes: 1_073_741_824,
          loopback: false,
        },
        {
          name: 'lo',
          state: 'unknown',
          addresses: ['127.0.0.1/8', '::1/128'],
          mtu: 65536,
          receivedBytes: 4096,
          transmittedBytes: 2048,
          loopback: true,
        },
      ],
      endpoints: [
        {
          protocol: 'tcp',
          localAddress: '0.0.0.0',
          localPort: 22,
          remoteAddress: null,
          remotePort: null,
          state: 'LISTEN',
          pid: 4242,
          processName: 'sshd',
        },
        {
          protocol: 'tcp',
          localAddress: '10.24.2.33',
          localPort: 8080,
          remoteAddress: null,
          remotePort: null,
          state: 'LISTEN',
          pid: 1919,
          processName: 'nginx',
        },
        {
          protocol: 'tcp',
          localAddress: '127.0.0.1',
          localPort: 5432,
          remoteAddress: null,
          remotePort: null,
          state: 'LISTEN',
          pid: 3306,
          processName: 'postgres',
        },
      ],
      routes: [
        {
          destination: 'default',
          gateway: '10.24.1.1',
          interfaceName: 'eth0',
          metric: 100,
          protocol: 'dhcp',
        },
        {
          destination: '10.24.2.0/24',
          gateway: null,
          interfaceName: 'eth1',
          metric: 200,
          protocol: 'static',
        },
      ],
      endpointsTruncated: false,
      routesTruncated: false,
    };
  });

  const interfaceSelect = dialog.getByLabel('网口');
  await expect(interfaceSelect).toHaveValue('');
  await expect(interfaceSelect.locator('option').first()).toHaveText('全部网口');
  await expect(dialog.getByRole('cell', { name: '127.0.0.1:5432' })).toBeVisible();
  await page.screenshot({ path: 'test-results/monitor-details-network-all-1440.png' });

  await interfaceSelect.selectOption('eth1');
  await expect(dialog.getByRole('cell', { name: '10.24.2.33:8080' })).toBeVisible();
  await expect(dialog.getByRole('cell', { name: '127.0.0.1:5432' })).toHaveCount(0);
  await dialog.getByRole('row', { name: /nginx/ }).click();
  await expect(dialog.getByText('网络记录详情')).toBeVisible();
  await page.screenshot({ path: 'test-results/monitor-details-network-detail-1440.png' });

  await dialog.getByRole('tab', { name: '路由' }).click();
  await expect(dialog.getByRole('cell', { name: '10.24.2.0/24' })).toBeVisible();
  await expect(dialog.getByRole('cell', { name: 'eth1' })).toBeVisible();
  await page.screenshot({ path: 'test-results/monitor-details-routes-1440.png' });

  await dialog.getByRole('tab', { name: '进程' }).click();
  await expect(dialog.getByText('进程较多，仅显示前 100 项。')).toBeVisible();
  await expect(dialog.getByRole('cell', { name: 'filex-agent' })).toBeVisible();
  await expect(dialog.getByText('启动时间')).toBeVisible();
  await page.screenshot({ path: 'test-results/monitor-details-process-1440.png' });

  await dialog.getByRole('tab', { name: '网络' }).click();
  await page.setViewportSize({ width: 960, height: 640 });
  await page.evaluate(() => {
    const key = 'filex.safe-settings.v1';
    const current = JSON.parse(localStorage.getItem(key) ?? '{}') as Record<string, unknown>;
    localStorage.setItem(key, JSON.stringify({ ...current, theme: 'light', locale: 'zh-CN', uiFontSize: 20 }));
    const root = document.querySelector('#app') as HTMLElement & {
      __vue_app__?: {
        config: { globalProperties: { $pinia?: { _s: Map<string, Record<string, unknown>> } } };
      };
    };
    const pinia = root.__vue_app__?.config.globalProperties.$pinia;
    const settings = pinia?._s.get('settings');
    if (settings) {
      Object.assign(settings.value as Record<string, unknown>, {
        theme: 'light',
        locale: 'zh-CN',
        uiFontSize: 20,
      });
      const apply = settings.apply;
      if (typeof apply === 'function') apply.call(settings);
    }
  });
  const box = await dialog.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(960);
  expect(box!.y + box!.height).toBeLessThanOrEqual(640);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/monitor-details-network-light-960-font20.png' });

  await page.evaluate(() => {
    const root = document.querySelector('#app') as HTMLElement & {
      __vue_app__?: {
        config: { globalProperties: { $pinia?: { _s: Map<string, Record<string, unknown>> } } };
      };
    };
    const pinia = root.__vue_app__?.config.globalProperties.$pinia;
    const sessions = pinia?._s.get('sessions');
    if (sessions) sessions.activeSessionId = 'session-beta';
  });
  await expect(dialog).toHaveCount(0);
});

test('surfaces an automatic signed update and preserves a skipped version', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForFunction(() => Boolean(
    (document.querySelector('#app') as HTMLElement & { __vue_app__?: unknown }).__vue_app__,
  ));
  await page.evaluate(() => {
    const root = document.querySelector('#app') as HTMLElement & {
      __vue_app__?: {
        config: { globalProperties: { $pinia?: { _s: Map<string, Record<string, unknown>> } } };
      };
    };
    const pinia = root.__vue_app__?.config.globalProperties.$pinia;
    const updates = pinia?._s.get('updates');
    const settings = pinia?._s.get('settings');
    if (!updates || !settings) throw new Error('Update fixture stores were not initialized');

    updates.check = () => Promise.resolve(true);
    updates.initialize = () => Promise.resolve();
    updates.status = {
      currentVersion: '0.1.0',
      channel: 'stable',
      configured: true,
      availableVersion: '0.1.1',
      publishedAt: '2026-11-10T16:24:19Z',
      releaseNotes: '### Added\r\n\r\n- Session-scoped process, network and route inspection.\r\n\r\n### Fixed\r\n\r\n- Signed automatic update discovery.\r\n',
    };
    updates.phase = 'available';
    updates.dialogOpen = false;
    updates.skippedVersion = null;
    Object.assign(settings.value as Record<string, unknown>, {
      theme: 'dark',
      locale: 'zh-CN',
    });
    const apply = settings.apply;
    if (typeof apply === 'function') apply.call(settings);
  });

  const updateButton = page.getByRole('button', { name: 'FILEX 0.1.1 可更新' });
  await expect(updateButton).toBeVisible();
  await updateButton.click();

  let dialog = page.getByRole('dialog', { name: '发现新版本' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: '关闭更新提示' })).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(dialog.getByRole('button', { name: '下载并安装' })).toBeFocused();
  await expect(dialog.getByText('FILEX 0.1.1 已发布，当前版本为 0.1.0。')).toBeVisible();
  await expect(dialog.getByText('Session-scoped process, network and route inspection.')).toBeVisible();
  await expect(dialog.getByText('取消、关闭或跳过后将不再提示此版本；后续新版本仍会自动提示。')).toBeVisible();
  await page.screenshot({ path: 'test-results/update-available-dark-1440.png' });

  await dialog.getByRole('button', { name: '取消' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(updateButton).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => localStorage.getItem('filex.update-preferences.v1'))).toContain('"skippedVersion":"0.1.1"');

  await page.setViewportSize({ width: 960, height: 640 });
  await page.evaluate(() => {
    const root = document.querySelector('#app') as HTMLElement & {
      __vue_app__?: {
        config: { globalProperties: { $pinia?: { _s: Map<string, Record<string, unknown>> } } };
      };
    };
    const pinia = root.__vue_app__?.config.globalProperties.$pinia;
    const updates = pinia?._s.get('updates');
    const settings = pinia?._s.get('settings');
    if (!updates || !settings) throw new Error('Update fixture stores were not initialized');
    updates.dialogOpen = true;
    updates.phase = 'downloading';
    updates.downloadedBytes = 50;
    updates.contentLength = 100;
    Object.assign(settings.value as Record<string, unknown>, {
      theme: 'light',
      locale: 'zh-CN',
      uiFontSize: 20,
    });
    const apply = settings.apply;
    if (typeof apply === 'function') apply.call(settings);
  });

  dialog = page.getByRole('dialog', { name: '发现新版本' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('签名发布', { exact: true })).toBeVisible();
  await expect(dialog.getByText('正在下载：50%')).toBeVisible();
  const box = await dialog.boundingBox();
  const versionBox = await dialog.locator('.update-version-summary').boundingBox();
  const notesHeadingBox = await dialog.locator('.update-section-heading').boundingBox();
  const notesBox = await dialog.locator('.update-notes-scroll').boundingBox();
  const footerBox = await dialog.locator('.update-dialog-footer').boundingBox();
  const secondaryActionsBox = await dialog.locator('.update-footer-secondary').boundingBox();
  const primaryActionsBox = await dialog.locator('.update-footer-primary').boundingBox();
  expect(box).not.toBeNull();
  expect(versionBox).not.toBeNull();
  expect(notesHeadingBox).not.toBeNull();
  expect(notesBox).not.toBeNull();
  expect(footerBox).not.toBeNull();
  expect(secondaryActionsBox).not.toBeNull();
  expect(primaryActionsBox).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(960);
  expect(box!.y + box!.height).toBeLessThanOrEqual(640);
  expect(Math.abs(versionBox!.x - notesBox!.x)).toBeLessThanOrEqual(1);
  expect(notesHeadingBox!.y - (versionBox!.y + versionBox!.height)).toBeGreaterThanOrEqual(12);
  expect(notesBox!.y - (notesHeadingBox!.y + notesHeadingBox!.height)).toBeGreaterThanOrEqual(6);
  expect(footerBox!.y).toBeGreaterThan(notesBox!.y + notesBox!.height);
  expect(secondaryActionsBox!.x).toBeGreaterThan(footerBox!.x);
  expect(primaryActionsBox!.x + primaryActionsBox!.width).toBeLessThan(footerBox!.x + footerBox!.width);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/update-download-light-960-font20.png' });

  await page.evaluate(() => {
    const root = document.querySelector('#app') as HTMLElement & {
      __vue_app__?: {
        config: { globalProperties: { $pinia?: { _s: Map<string, Record<string, unknown>> } } };
      };
    };
    const updates = root.__vue_app__?.config.globalProperties.$pinia?._s.get('updates');
    if (updates) {
      updates.phase = 'available';
      updates.downloadedBytes = 0;
      updates.contentLength = null;
    }
  });
  await dialog.getByRole('button', { name: '跳过此版本' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(updateButton).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => localStorage.getItem('filex.update-preferences.v1'))).toContain('"skippedVersion":"0.1.1"');
});

test('opens process context menu with signal actions and inspects Docker and DevOps modals', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForFunction(() => Boolean(
    (document.querySelector('#app') as HTMLElement & { __vue_app__?: unknown }).__vue_app__,
  ));

  await page.evaluate(() => {
    const root = document.querySelector('#app') as HTMLElement & {
      __vue_app__?: {
        config: { globalProperties: { $pinia?: { _s: Map<string, Record<string, unknown>> } } };
      };
    };
    const pinia = root.__vue_app__?.config.globalProperties.$pinia;
    const settings = pinia?._s.get('settings') as ({ value?: Record<string, unknown>; apply?: () => void } | undefined);
    const connections = pinia?._s.get('connections') as ({ profiles?: Array<Record<string, unknown>> } | undefined);
    const sessions = pinia?._s.get('sessions') as ({
      summaries?: Array<Record<string, unknown>>;
      activeSessionId?: string | null;
    } | undefined);
    const monitor = pinia?._s.get('monitor');
    const processes = pinia?._s.get('processes');
    const docker = pinia?._s.get('docker');
    const ops = pinia?._s.get('ops');
    if (!settings || !connections || !sessions || !monitor || !processes || !docker || !ops) {
      throw new Error('Pinia stores were not initialized');
    }

    Object.assign(settings.value ?? {}, { theme: 'dark', locale: 'zh-CN', uiFontSize: 14 });
    settings.apply?.call(settings);

    const profile = {
      id: 'profile-prod',
      name: 'prod-docker',
      host: '10.0.0.18',
      port: 22,
      username: 'ops',
      authMethod: 'agent',
      keyPath: null,
      proxy: null,
      jumpHost: null,
      environment: 'production',
      colorTag: 'blue',
      tags: ['docker'],
      defaultRemotePath: '/srv/app',
    };
    connections.profiles = [profile];
    sessions.summaries = [{
      id: 'session-ops',
      profileId: 'profile-prod',
      title: 'prod-docker',
      host: '10.0.0.18',
      port: 22,
      username: 'ops',
      state: 'connected',
      remoteCwd: '/srv/app',
      fingerprint: 'SHA256:mock',
      lastError: null,
    }];
    sessions.activeSessionId = 'session-ops';

    monitor.collect = () => Promise.resolve();
    monitor.snapshot = {
      state: 'live',
      collectedAtMs: Date.now(),
      hostname: 'prod-docker-01',
      osName: 'Ubuntu 24.04 LTS',
      uptimeSeconds: 185_400,
      loadOne: 0.42,
      loadFive: 0.39,
      loadFifteen: 0.35,
      cpuPercent: 34,
      memoryTotalKib: 8_388_608,
      memoryAvailableKib: 5_242_880,
      swapTotalKib: 2_097_152,
      swapUsedKib: 131_072,
      mounts: [{ path: '/', totalKib: 104_857_600, availableKib: 62_914_560 }],
      networkReceiveBytesPerSecond: 12_400,
      networkTransmitBytesPerSecond: 4_800,
    };
    monitor.history = [
      { atMs: Date.now() - 2000, receive: 8000, transmit: 3200 },
      { atMs: Date.now(), receive: 12400, transmit: 4800 },
    ];

    processes.collect = () => Promise.resolve();
    processes.snapshot = {
      state: 'live',
      platform: 'posix',
      collectedAtMs: Date.now(),
      snapshotId: 'snap-ops-1',
      processes: [
        {
          pid: 1248,
          name: 'node-worker',
          user: 'ops',
          cpuPercent: 18.4,
          cpuTimeSeconds: 92.1,
          memoryBytes: 268_435_456,
          state: 'S',
          startedAtMs: Date.now() - 600_000,
          canTerminate: true,
        },
        {
          pid: 1,
          name: 'systemd',
          user: 'root',
          cpuPercent: 0.1,
          cpuTimeSeconds: 14.0,
          memoryBytes: 12_582_912,
          state: 'S',
          startedAtMs: Date.now() - 185_400_000,
          canTerminate: false,
        },
      ],
      truncated: false,
    };

    docker.collect = () => Promise.resolve();
    docker.fetchLogs = () => Promise.resolve();
    docker.performAction = () => Promise.resolve(true);
    docker.snapshot = {
      availability: 'available',
      collectedAtMs: Date.now(),
      serverVersion: '26.1.4',
      containers: [
        {
          id: 'a1b2c3d4e5f6',
          name: 'filex-gateway',
          image: 'nginx:1.27-alpine',
          state: 'running',
          status: 'Up 3 days (healthy)',
          ports: '0.0.0.0:443->443/tcp',
          createdAt: '2026-11-11 08:00:00',
          cpuPercent: '0.84%',
          memoryUsage: '38.2MiB / 2GiB',
          pids: '6',
        },
        {
          id: 'f6e5d4c3b2a1',
          name: 'worker-batch',
          image: 'redis:7.4',
          state: 'exited',
          status: 'Exited (0) 2 hours ago',
          ports: '',
          createdAt: '2026-11-12 09:30:00',
          cpuPercent: null,
          memoryUsage: null,
          pids: null,
        },
      ],
      images: [
        {
          id: 'sha256:9f8e7d6c',
          repository: 'nginx',
          tag: '1.27-alpine',
          size: '42.6MB',
          createdSince: '2 weeks ago',
        },
      ],
      truncated: false,
      detailNote: null,
    };
    docker.logs = {
      containerId: 'a1b2c3d4e5f6',
      lines: ['2026/11/14 11:30:00 [notice] nginx ready on :443'],
      truncated: false,
    };

    ops.collect = () => Promise.resolve();
    ops.snapshots = {
      ports: {
        state: 'live',
        collectedAtMs: Date.now(),
        category: 'ports',
        hostname: 'prod-docker-01',
        kernel: '6.8.0-45-generic',
        osRelease: 'Ubuntu 24.04 LTS',
        sections: [
          {
            id: 'listening',
            titleKey: 'opsDialog.sectionListeningPorts',
            commandLabel: 'ss -tulpen',
            lines: ['tcp LISTEN 0 511 0.0.0.0:443 0.0.0.0:* users:(("nginx",pid=901,fd=6))'],
            truncated: false,
          },
        ],
      },
    };
  });

  const quickOps = page.locator('.terminal-quick-ops');
  await expect(quickOps).toBeVisible();

  await quickOps.getByRole('button', { name: '进程', exact: true }).click();
  const monitorDialog = page.getByRole('dialog', { name: '主机监控详情' });
  await expect(monitorDialog).toBeVisible();

  const processRow = monitorDialog.locator('tbody tr', { hasText: 'node-worker' });
  await processRow.click({ button: 'right' });
  const processMenu = page.getByRole('menu', { name: '进程操作菜单' });
  await expect(processMenu).toBeVisible();
  await expect(processMenu.getByRole('menuitem', { name: '强制结束 (SIGKILL)' })).toBeVisible();
  await expect(processMenu.getByRole('menuitem', { name: '结束进程 (SIGTERM)' })).toBeVisible();
  await expect(processMenu.getByRole('menuitem', { name: '重载配置 (SIGHUP)' })).toBeVisible();
  await processMenu.getByRole('menuitem', { name: '强制结束 (SIGKILL)' }).click();

  const confirmDialog = page.getByRole('alertdialog');
  await expect(confirmDialog).toBeVisible();
  await expect(confirmDialog).toContainText('10.0.0.18:22');
  await expect(confirmDialog).toContainText('SIGKILL');
  await confirmDialog.getByRole('button', { name: '取消' }).last().click();
  await monitorDialog.getByRole('button', { name: '关闭监控详情' }).click();

  await quickOps.getByRole('button', { name: 'Docker', exact: true }).click();
  const dockerDialog = page.getByRole('dialog', { name: 'Docker 管理' });
  await expect(dockerDialog).toBeVisible();
  await expect(dockerDialog.getByText('filex-gateway')).toBeVisible();
  await expect(dockerDialog.getByText('Engine 26.1.4')).toBeVisible();
  await page.screenshot({ path: 'test-results/docker-modal-dark-1440.png' });

  await dockerDialog.locator('tbody tr', { hasText: 'filex-gateway' }).getByRole('button', { name: '日志', exact: true }).click();
  await expect(dockerDialog.getByText('nginx ready on :443')).toBeVisible();
  await dockerDialog.getByRole('button', { name: '关闭 Docker 窗口' }).click();

  await page.setViewportSize({ width: 960, height: 640 });
  await page.evaluate(() => {
    const root = document.querySelector('#app') as HTMLElement & {
      __vue_app__?: {
        config: { globalProperties: { $pinia?: { _s: Map<string, Record<string, unknown>> } } };
      };
    };
    const settings = root.__vue_app__?.config.globalProperties.$pinia?._s.get('settings') as ({
      value?: Record<string, unknown>;
      apply?: () => void;
    } | undefined);
    if (settings) {
      Object.assign(settings.value ?? {}, { theme: 'light', locale: 'zh-CN', uiFontSize: 20 });
      settings.apply?.call(settings);
    }
  });

  await quickOps.getByRole('button', { name: '监听端口', exact: true }).click();
  const opsDialog = page.getByRole('dialog', { name: '开发运维命令面板' });
  await expect(opsDialog).toBeVisible();
  await expect(opsDialog.getByText('ss -tulpen')).toBeVisible();
  const opsBox = await opsDialog.boundingBox();
  expect(opsBox).not.toBeNull();
  expect(opsBox!.x).toBeGreaterThanOrEqual(0);
  expect(opsBox!.x + opsBox!.width).toBeLessThanOrEqual(960);
  expect(opsBox!.y + opsBox!.height).toBeLessThanOrEqual(640);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/ops-modal-light-960-font20.png' });
  await opsDialog.getByRole('button', { name: '关闭运维面板' }).click();
});

test('selects terminal text without auto-opening context menu and populates initial remote directory tree', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(() => {
    type Root = HTMLElement & {
      __vue_app__?: {
        config: { globalProperties: { $pinia?: { _s: Map<string, Record<string, unknown>> } } };
      };
    };
    const pinia = (document.querySelector('#app') as Root).__vue_app__?.config.globalProperties.$pinia;
    const sessions = pinia?._s.get('sessions') as {
      summaries: Array<Record<string, unknown>>;
      activeSessionId: string | null;
      outputBuffers: Record<string, Uint8Array[]>;
      outputBufferStarts: Record<string, number>;
      outputRevision: number;
      isQuickProfile: (id?: string | null) => boolean;
      resizeSession: () => Promise<void>;
    } | undefined;
    const sftp = pinia?._s.get('sftp') as {
      sessionId: string | null;
      path: string;
      entries: Array<Record<string, unknown>>;
      directoryChildren: Record<string, Array<{ name: string; path: string }>>;
      directoryLoadingPaths: string[];
      directoryErrorPaths: string[];
      load: (sessionId: string, path: string) => Promise<boolean>;
      loadTreeDirectory: (treePath: string) => Promise<void>;
      clear: () => void;
    } | undefined;
    const settings = pinia?._s.get('settings') as {
      value: Record<string, unknown>;
      apply?: () => void;
    } | undefined;
    if (!sessions || !sftp || !settings) throw new Error('Stores unavailable');

    Object.assign(settings.value, {
      theme: 'light',
      terminalTheme: 'filex-light',
      locale: 'zh-CN',
      fileBrowserOpen: true,
      focusMode: false,
      dualPaneSftp: false,
    });
    settings.apply?.call(settings);

    const treeEntries: Record<string, Array<{ name: string; path: string }>> = {
      '/': [
        { name: 'etc', path: '/etc' },
        { name: 'root', path: '/root' },
        { name: 'var', path: '/var' },
      ],
      '/root': [
        { name: '.cache', path: '/root/.cache' },
        { name: '.docker', path: '/root/.docker' },
      ],
    };
    sftp.load = (sessionId: string, requestedPath: string) => {
      const resolved = requestedPath === '.' ? '/root' : requestedPath;
      sftp.sessionId = sessionId;
      sftp.path = resolved;
      sftp.entries = (treeEntries[resolved] ?? []).map((item) => ({
        name: item.name,
        path: item.path,
        isDirectory: true,
        isSymlink: false,
        size: null,
        modifiedAtMs: Date.now(),
        permissionsMode: 0o755,
        uid: 0,
        gid: 0,
      }));
      sftp.directoryChildren = {
        ...sftp.directoryChildren,
        [resolved]: treeEntries[resolved] ?? [],
      };
      return Promise.resolve(true);
    };
    sftp.loadTreeDirectory = (treePath: string) => {
      sftp.directoryChildren = {
        ...sftp.directoryChildren,
        [treePath]: treeEntries[treePath] ?? [],
      };
      return Promise.resolve();
    };

    const sessionId = 'session-tree-and-select';
    sessions.isQuickProfile = () => false;
    sessions.resizeSession = () => Promise.resolve();
    sessions.summaries = [{
      id: sessionId,
      generation: 1,
      profileId: 'profile-tree-and-select',
      state: 'connected',
      host: '10.0.0.25',
      port: 22,
      username: 'root',
      lastError: null,
    }];
    sessions.activeSessionId = sessionId;

    const ansiTop = [
      '\x1b[7m  PID USER      PR  NI    VIRT    RES    SHR S  %CPU  %MEM     TIME+ COMMAND          \x1b[0m\r\n',
      ' 1550 root      20   0 1236448  59120   1704 S   0.3   0.1  16:23.35 containerd-shim\r\n',
      ' 1698 root      20   0  118648   9152   3200 S   0.0   0.0   0:05.29 AliYunDun\r\n',
    ].join('');
    sessions.outputBuffers[sessionId] = [new TextEncoder().encode(ansiTop)];
    sessions.outputBufferStarts[sessionId] = 0;
    sessions.outputRevision += 1;
  });

  // Initial remote connection to `.` canonicalizing to `/root` populates `/` children automatically.
  const directoryTree = page.locator('.directory-tree[aria-label="目录导航"]');
  await expect(directoryTree.locator('.directory-tree-label', { hasText: /^etc$/ })).toBeVisible();
  await expect(directoryTree.locator('.directory-tree-label', { hasText: /^root$/ })).toBeVisible();
  await expect(directoryTree.locator('.directory-tree-label', { hasText: /^var$/ })).toBeVisible();

  // Plain left-click shows clicked-cell indicator without opening the context menu.
  const screenBox = await page.locator('.terminal-pane-surface .xterm-screen').boundingBox();
  expect(screenBox).not.toBeNull();
  await page.mouse.click(screenBox!.x + 40, screenBox!.y + 22);
  await expect(page.getByRole('menu', { name: '终端窗格' })).toHaveCount(0);
  await expect(page.locator('.terminal-click-reticle')).toBeVisible();

  // Drag-selecting text in the terminal highlights selection without auto-opening a popup menu or leaving a reticle box.
  const rows = page.locator('.terminal-pane-surface .xterm-rows > div');
  await expect(rows.nth(1)).toContainText('containerd-shim');
  const startX = screenBox!.x + 120;
  const startY = screenBox!.y + 22;
  const endX = screenBox!.x + 420;
  const endY = screenBox!.y + 40;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(endX, endY, { steps: 6 });
  await page.mouse.up();

  await expect(page.getByRole('menu', { name: '终端窗格' })).toHaveCount(0);
  await expect(page.locator('.terminal-click-reticle')).toHaveCount(0);
  await expect(page.locator('.terminal-pane-status')).toContainText('已选');
  await page.screenshot({ path: 'test-results/terminal-selection-and-tree-1440.png' });

  // Right-click while text is selected opens the full terminal context menu.
  await page.locator('.terminal-pane-surface').click({ button: 'right', position: { x: 220, y: 36 } });
  const menu = page.getByRole('menu', { name: '终端窗格' });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: '复制选中内容' })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: '复制并输入' })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: '粘贴' })).toBeVisible();
});

test('renders semantic terminal colors, monospace grid alignment, and transparent selection spans', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(() => {
    type Root = HTMLElement & {
      __vue_app__?: {
        config: { globalProperties: { $pinia?: { _s: Map<string, Record<string, unknown>> } } };
      };
    };
    const pinia = (document.querySelector('#app') as Root).__vue_app__?.config.globalProperties.$pinia;
    const sessions = pinia?._s.get('sessions') as {
      summaries: Array<Record<string, unknown>>;
      activeSessionId: string | null;
      outputBuffers: Record<string, Uint8Array[]>;
      outputBufferStarts: Record<string, number>;
      outputRevision: number;
      isQuickProfile: (id?: string | null) => boolean;
      resizeSession: () => Promise<void>;
    } | undefined;
    const settings = pinia?._s.get('settings') as {
      value: Record<string, unknown>;
      apply?: () => void;
    } | undefined;
    if (!sessions || !settings) throw new Error('Stores unavailable');

    Object.assign(settings.value, {
      theme: 'light',
      terminalTheme: 'filex-light',
      locale: 'zh-CN',
      fileBrowserOpen: false,
      focusMode: false,
    });
    settings.apply?.call(settings);

    const sessionId = 'session-color-and-align';
    sessions.isQuickProfile = () => false;
    sessions.resizeSession = () => Promise.resolve();
    sessions.summaries = [{
      id: sessionId,
      generation: 1,
      profileId: 'profile-color-and-align',
      state: 'connected',
      host: '123.57.91.172',
      port: 22,
      username: 'root',
      lastError: null,
    }];
    sessions.activeSessionId = sessionId;

    const sampleOutput = [
      '连接主机...\r\n',
      '连接主机成功\r\n',
      'Last login: Sat Nov 14 19:19:42 2026 from 27.8.49.120\r\n',
      '\r\n',
      'Welcome to Alibaba Cloud Elastic Compute Service !\r\n',
      '\r\n',
      '[root@iZ2zeiwvlu7t0gzfwkugs0Z ~]# docker ps\r\n',
      'CONTAINER ID   IMAGE\r\n',
      'ea23eaf54d65   keking/kkfileview:v4.1.0\r\n',
      'b87cfc5ded3b   nocodb/nocodb:0.263.4\r\n',
    ].join('');
    sessions.outputBuffers[sessionId] = [new TextEncoder().encode(sampleOutput)];
    sessions.outputBufferStarts[sessionId] = 0;
    sessions.outputRevision += 1;
  });

  const rows = page.locator('.terminal-pane-surface .xterm-rows > div');
  await expect(rows.nth(2)).toContainText('Last login: Sat Nov 14 19:19:42 2026 from 27.8.49.120');
  await expect(rows.nth(8)).toContainText('ea23eaf54d65   keking/kkfileview:v4.1.0');

  // Verify semantic colors were applied to Last login row (timestamp, IP address, etc.).
  const coloredSpanCount = await rows.nth(2).locator('span[style*="color"]').count();
  expect(coloredSpanCount).toBeGreaterThanOrEqual(3);

  // Verify monospace alignment between row 8 (`keking/kkfileview:v4.1.0`) and row 9 (`nocodb/nocodb:0.263.4`).
  const alignment = await page.evaluate(() => {
    const rowEls = document.querySelectorAll('.terminal-pane-surface .xterm-rows > div');
    const charLeft = (rowEl: Element, index: number): number => {
      const walker = document.createTreeWalker(rowEl, NodeFilter.SHOW_TEXT);
      let seen = 0;
      while (walker.nextNode()) {
        const text = walker.currentNode.textContent ?? '';
        if (seen + text.length > index) {
          const range = document.createRange();
          const localIndex = index - seen;
          range.setStart(walker.currentNode, localIndex);
          range.setEnd(walker.currentNode, localIndex + 1);
          return range.getBoundingClientRect().left;
        }
        seen += text.length;
      }
      return -1;
    };
    const row8 = rowEls[8];
    const row9 = rowEls[9];
    if (!row8 || !row9) return { col15Delta: Number.POSITIVE_INFINITY, col35Delta: Number.POSITIVE_INFINITY };
    const col15Row8 = charLeft(row8, 15);
    const col15Row9 = charLeft(row9, 15);
    const col35Row8 = charLeft(row8, 35);
    const col35Row9 = charLeft(row9, 35);
    return {
      col15Delta: Math.abs(col15Row8 - col15Row9),
      col35Delta: Math.abs(col35Row8 - col35Row9),
    };
  });
  expect(alignment.col15Delta).toBeLessThan(0.5);
  expect(alignment.col35Delta).toBeLessThan(0.5);

  // Drag-select `.1.0` at the end of `ea23eaf54d65   keking/kkfileview:v4.1.0` and ensure
  // no `.xterm-decoration-top` span retains an opaque background covering `:v4`.
  const targetBox = await page.evaluate(() => {
    const rowEl = document.querySelectorAll('.terminal-pane-surface .xterm-rows > div')[8];
    if (!rowEl) return { startLeft: 0, endRight: 0, midY: 0 };
    const walker = document.createTreeWalker(rowEl, NodeFilter.SHOW_TEXT);
    let seen = 0;
    let startLeft = 0;
    let endRight = 0;
    let midY = 0;
    while (walker.nextNode()) {
      const text = walker.currentNode.textContent ?? '';
      if (seen <= 35 && seen + text.length > 35) {
        const r = document.createRange();
        r.setStart(walker.currentNode, 35 - seen);
        r.setEnd(walker.currentNode, 35 - seen + 1);
        const rect = r.getBoundingClientRect();
        startLeft = rect.left + 1;
        midY = rect.top + rect.height / 2;
      }
      if (seen <= 38 && seen + text.length > 38) {
        const r = document.createRange();
        r.setStart(walker.currentNode, 38 - seen);
        r.setEnd(walker.currentNode, 38 - seen + 1);
        endRight = r.getBoundingClientRect().right;
      }
      seen += text.length;
    }
    return { startLeft, endRight, midY };
  });

  await page.mouse.move(targetBox.startLeft, targetBox.midY);
  await page.mouse.down();
  await page.mouse.move(targetBox.endRight, targetBox.midY, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(80);

  const opaqueDecorationSpans = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.xterm-rows > div > .xterm-decoration-top'))
      .filter((span) => {
        const el = span as HTMLElement;
        return !el.classList.contains('xterm-cursor') && el.style.backgroundColor !== 'transparent';
      })
      .map((span) => span.textContent),
  );
  expect(opaqueDecorationSpans).toEqual([]);
  await expect(rows.nth(8)).toContainText('keking/kkfileview:v4.1.0');
  await page.screenshot({ path: 'test-results/terminal-color-and-selection-1440.png' });
});

test('opens local terminal dialog with desktop notice and restores focus on Escape', async ({ page }) => {
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 960, height: 640 },
  ]) {
    await page.setViewportSize(viewport);
    const trigger = page.locator('.context-actions button[aria-label="本地终端"]');
    await expect(trigger).toBeVisible();
    await trigger.focus();
    await trigger.click();

    const dialog = page.getByRole('dialog', { name: '本地终端' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('status')).toContainText('本地 PTY 终端仅在 FILEX 桌面应用中可用。');
    await expect(dialog.getByRole('button', { name: '打开本地终端' })).toBeDisabled();

    const dialogBox = await dialog.boundingBox();
    expect(dialogBox).not.toBeNull();
    expect(dialogBox!.x).toBeGreaterThanOrEqual(0);
    expect(dialogBox!.x + dialogBox!.width).toBeLessThanOrEqual(viewport.width);
    expect(dialogBox!.y + dialogBox!.height).toBeLessThanOrEqual(viewport.height);

    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
  }
});

test('opens elevated access dialog, renders amber lease badge with countdown, and revokes on click', async ({ page }) => {
  await page.evaluate(() => {
    type Root = HTMLElement & {
      __vue_app__?: {
        config: { globalProperties: { $pinia?: { _s: Map<string, Record<string, unknown>> } } };
      };
    };
    const pinia = (document.querySelector('#app') as Root).__vue_app__?.config.globalProperties.$pinia;
    const sessions = pinia?._s.get('sessions') as {
      summaries: Array<Record<string, unknown>>;
      activeSessionId: string | null;
      isQuickProfile: (id?: string | null) => boolean;
      resizeSession: () => Promise<void>;
    } | undefined;
    const sftp = pinia?._s.get('sftp') as { sessionId: string | null; path: string } | undefined;
    const settings = pinia?._s.get('settings') as { value: Record<string, unknown> } | undefined;
    if (!sessions || !sftp || !settings) throw new Error('Stores unavailable');

    settings.value.fileBrowserOpen = true;
    settings.value.focusMode = false;
    sessions.isQuickProfile = () => false;
    sessions.resizeSession = () => Promise.resolve();
    sessions.summaries = [{
      id: 'sess-elevated-e2e',
      generation: 1,
      profileId: 'prof-elevated-e2e',
      sessionKind: 'ssh',
      capabilities: ['remote_shell', 'sftp', 'remote_edit', 'host_monitoring', 'tunneling', 'remote_jobs'],
      state: 'connected',
      host: '10.24.0.8',
      port: 22,
      username: 'ops',
      lastError: null,
    }];
    sessions.activeSessionId = 'sess-elevated-e2e';
    sftp.sessionId = 'sess-elevated-e2e';
    sftp.path = '/etc';
  });

  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 960, height: 640 },
  ]) {
    await page.setViewportSize(viewport);
    const trigger = page.locator('.file-browser-panel button[aria-label="启用文件提权"]');
    await expect(trigger).toBeVisible();
    await expect(trigger).toBeEnabled();
    await trigger.focus();
    await trigger.click();

    const dialog = page.getByRole('dialog', { name: '临时文件提权访问' });
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('input[readonly]')).toHaveValue('ops@10.24.0.8:22');
    await expect(dialog.locator('select option')).toHaveCount(3);
    await expect(dialog.getByRole('note')).toContainText('提权租约');

    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
  }

  await page.evaluate(() => {
    type Root = HTMLElement & {
      __vue_app__?: {
        config: { globalProperties: { $pinia?: { _s: Map<string, Record<string, unknown>> } } };
      };
    };
    const pinia = (document.querySelector('#app') as Root).__vue_app__?.config.globalProperties.$pinia;
    const privilege = pinia?._s.get('privilege') as {
      leases: Record<string, unknown>;
    } | undefined;
    if (!privilege) throw new Error('Privilege store unavailable');
    const now = Date.now();
    privilege.leases = {
      'sess-elevated-e2e': {
        sessionId: 'sess-elevated-e2e',
        generation: 1,
        state: 'elevated',
        username: 'ops',
        host: '10.24.0.8',
        port: 22,
        grantedAtMs: now,
        expiresAtMs: now + 300_000,
        ttlSeconds: 300,
      },
    };
  });

  await expect(page.locator('.terminal-pane .elevated-badge')).toBeVisible();
  await expect(page.locator('.file-browser-panel .elevated-badge')).toBeVisible();
  await expect(page.locator('.terminal-pane .elevated-badge')).toContainText('提权');

  await page.locator('.file-browser-panel .elevated-badge-revoke').click();
  await expect(page.locator('.terminal-pane .elevated-badge')).toHaveCount(0);
  await expect(page.locator('.file-browser-panel .elevated-badge')).toHaveCount(0);
});

test('central SSH key and outbound proxy library modal and profile selectors are keyboard accessible across viewports and themes', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => {
    localStorage.clear();
  });
  await page.reload();

  for (const [theme, viewport] of [
    ['dark', { width: 1440, height: 900 }],
    ['light', { width: 960, height: 640 }],
  ] as const) {
    await page.evaluate((targetTheme) => {
      type Root = HTMLElement & {
        __vue_app__?: {
          config: { globalProperties: { $pinia?: { _s: Map<string, Record<string, unknown>> } } };
        };
      };
      const pinia = (document.querySelector('#app') as Root).__vue_app__?.config.globalProperties.$pinia;
      const settings = pinia?._s.get('settings') as { value: Record<string, unknown> } | undefined;
      if (settings) settings.value.theme = targetTheme;
    }, theme);
    await page.setViewportSize(viewport);

    const libraryTrigger = page.locator('.context-actions button[aria-label="密钥与代理库"]');
    await expect(libraryTrigger).toBeVisible();
    await libraryTrigger.focus();
    await libraryTrigger.click();

    const dialog = page.getByRole('dialog', { name: 'SSH 密钥与出站代理库' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('tab', { name: /SSH 密钥/ })).toHaveAttribute('aria-selected', 'true');
    await expect(dialog.locator('.key-proxy-form')).toBeVisible();
    const bodyHeight = await dialog.locator('.key-proxy-library-body').evaluate((el) => el.getBoundingClientRect().height);
    expect(bodyHeight).toBeGreaterThanOrEqual(240);

    await dialog.getByRole('tab', { name: /出站代理/ }).click();
    await expect(dialog.getByRole('tab', { name: /出站代理/ })).toHaveAttribute('aria-selected', 'true');
    await expect(dialog.locator('select option')).toHaveCount(2);

    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(libraryTrigger).toBeFocused();
  }

  // Verify AddProfileDialog displays central key and outbound proxy selectors and keeps compact composer closed by default.
  await expect(page.locator('.command-input-bar')).toHaveCount(0);
  await page.getByRole('button', { name: '添加连接' }).click();
  const profileDialog = page.getByRole('dialog', { name: '添加连接资料' });
  await expect(profileDialog).toBeVisible();
  await expect(profileDialog.locator('label:has-text("出站网络代理")')).toBeVisible();
  await profileDialog.locator('select').first().selectOption('private_key');
  await expect(profileDialog.locator('#profile-central-key')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(profileDialog).toHaveCount(0);
});

test('compact command composer stays hidden by default and manages confirmed replay and secret exclusion when enabled', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => {
    localStorage.clear();
  });
  await page.reload();

  // Hidden on default initial load
  await expect(page.locator('.command-input-bar')).toHaveCount(0);

  // Inject a connected saved SSH session in browser preview
  await page.evaluate(() => {
    type Root = HTMLElement & {
      __vue_app__?: {
        config: { globalProperties: { $pinia?: { _s: Map<string, Record<string, unknown>> } } };
      };
    };
    const pinia = (document.querySelector('#app') as Root).__vue_app__?.config.globalProperties.$pinia;
    const sessions = pinia?._s.get('sessions') as {
      summaries: Array<Record<string, unknown>>;
      activeSessionId: string | null;
      isQuickProfile: (id: string) => boolean;
      resizeSession: () => Promise<void>;
      writeToSession: () => Promise<boolean>;
    } | undefined;
    if (!sessions) throw new Error('Sessions store unavailable');

    sessions.isQuickProfile = () => false;
    sessions.resizeSession = () => Promise.resolve();
    sessions.writeToSession = () => Promise.resolve(true);
    sessions.summaries = [{
      id: 'sess-composer-e2e',
      generation: 1,
      profileId: 'prof-composer-e2e',
      sessionKind: 'ssh',
      capabilities: ['remote_shell', 'sftp', 'remote_edit', 'host_monitoring', 'tunneling', 'remote_jobs'],
      state: 'connected',
      host: '10.90.0.12',
      port: 22,
      username: 'ops',
      lastError: null,
    }];
    sessions.activeSessionId = 'sess-composer-e2e';
  });

  // Enable compact composer in Settings -> Terminal
  await page.locator('.context-actions button[aria-label="设置"]').click();
  const settingsDialog = page.getByRole('dialog', { name: '设置' });
  await settingsDialog.getByRole('button', { name: '终端' }).click();
  const composerToggle = settingsDialog.locator('.setting-row:has-text("紧凑命令输入栏") input[type="checkbox"]');
  await composerToggle.check();
  await settingsDialog.getByRole('button', { name: '应用并保存' }).click();
  await expect(settingsDialog).toHaveCount(0);

  for (const [theme, viewport] of [
    ['dark', { width: 1440, height: 900 }],
    ['light', { width: 960, height: 640 }],
  ] as const) {
    await page.evaluate((targetTheme) => {
      type Root = HTMLElement & {
        __vue_app__?: {
          config: { globalProperties: { $pinia?: { _s: Map<string, Record<string, unknown>> } } };
        };
      };
      const pinia = (document.querySelector('#app') as Root).__vue_app__?.config.globalProperties.$pinia;
      const settings = pinia?._s.get('settings') as { value: Record<string, unknown> } | undefined;
      if (settings) settings.value.theme = targetTheme;
    }, theme);
    await page.setViewportSize(viewport);
    await expect(page.locator('.command-input-bar')).toBeVisible();
  }

  const input = page.locator('.command-input-bar textarea');
  await input.fill('systemctl status nginx');
  await input.press('Enter');

  // Sensitive command is sent but never saved to history
  await input.fill('export API_TOKEN=supersecret123');
  await input.press('Enter');

  await page.locator('.command-input-bar button[aria-label="历史"]').click();
  const historyPanel = page.locator('.command-history-panel');
  await expect(historyPanel).toBeVisible();
  await expect(historyPanel).toContainText('systemctl status nginx');
  await expect(historyPanel).not.toContainText('supersecret123');
  await expect(historyPanel).toContainText('最多 200 条');

  // Direct execution requires explicit confirmation
  await historyPanel.locator('button[aria-label="立即执行"]').first().click();
  const confirmDialog = page.getByRole('alertdialog', { name: '确认重新执行历史命令' });
  await expect(confirmDialog).toBeVisible();
  await expect(confirmDialog).toContainText('ops@10.90.0.12:22');
  await page.keyboard.press('Escape');
  await expect(confirmDialog).toHaveCount(0);

  // Toggle closed cleanly from tab bar button
  await page.locator('.terminal-tabs button[aria-label="显示或隐藏命令输入栏"]').click();
  await expect(page.locator('.command-input-bar')).toHaveCount(0);
});

test('per-profile path bookmarks and transfer history filter are keyboard accessible', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => {
    type Root = HTMLElement & {
      __vue_app__?: {
        config: { globalProperties: { $pinia?: { _s: Map<string, Record<string, unknown>> } } };
      };
    };
    const pinia = (document.querySelector('#app') as Root).__vue_app__?.config.globalProperties.$pinia;
    const settings = pinia?._s.get('settings') as { value: Record<string, unknown> } | undefined;
    const sessions = pinia?._s.get('sessions');
    if (!settings || !sessions) throw new Error('Base stores unavailable');

    settings.value.inspectorTab = 'files';
    settings.value.fileBrowserOpen = true;
    settings.value.dualPaneSftp = true;
    settings.value.taskDrawerOpen = true;
    settings.value.taskTab = 'transfers';
    sessions.isQuickProfile = () => false;
    sessions.summaries = [{
      id: 'sess-bookmark-e2e',
      generation: 1,
      profileId: 'prof-bookmark-e2e',
      sessionKind: 'ssh',
      capabilities: ['remote_shell', 'sftp', 'remote_edit', 'host_monitoring', 'tunneling', 'remote_jobs'],
      state: 'connected',
      host: '10.90.0.18',
      port: 22,
      username: 'ops',
      lastError: null,
    }];
    sessions.activeSessionId = 'sess-bookmark-e2e';
  });

  await page.locator('.task-drawer').waitFor({ state: 'visible' });
  await page.locator('.file-browser-pane').first().waitFor({ state: 'visible' });

  await page.evaluate(() => {
    type Root = HTMLElement & {
      __vue_app__?: {
        config: { globalProperties: { $pinia?: { _s: Map<string, Record<string, unknown>> } } };
      };
    };
    const pinia = (document.querySelector('#app') as Root).__vue_app__?.config.globalProperties.$pinia;
    const transfers = pinia?._s.get('transfers');
    const localFiles = pinia?._s.get('local-files');
    if (!transfers || !localFiles) throw new Error('Drawer/file stores unavailable');

    localFiles.listing = {
      path: 'C:\\deploy',
      parentPath: 'C:\\',
      entries: [],
      truncated: false,
    };
    transfers.tasks = [
      {
        id: 't-active',
        profileId: 'prof-bookmark-e2e',
        sessionId: 'sess-bookmark-e2e',
        direction: 'upload',
        localPath: 'C:\\deploy\\app.tar.gz',
        remotePath: '/srv/app.tar.gz',
        destinationProfileId: null,
        destinationSessionId: null,
        destinationRemotePath: null,
        state: 'paused',
        bytesTransferred: 128,
        totalBytes: 1024,
        conflictPolicy: 'ask',
        remoteSizeBytes: 1024,
        remoteMtimeMs: 1700000000000,
        stagingPath: 'C:\\deploy\\.filex-part-t-active',
        resumeState: 'safe_to_resume',
        error: null,
        createdAtMs: 1000,
        updatedAtMs: 2000,
      },
      {
        id: 't-history',
        profileId: 'prof-bookmark-e2e',
        sessionId: null,
        direction: 'download',
        localPath: 'C:\\deploy\\nginx.conf',
        remotePath: '/etc/nginx/nginx.conf',
        destinationProfileId: null,
        destinationSessionId: null,
        destinationRemotePath: null,
        state: 'completed',
        bytesTransferred: 512,
        totalBytes: 512,
        conflictPolicy: 'ask',
        remoteSizeBytes: 512,
        remoteMtimeMs: 1700000000000,
        stagingPath: null,
        resumeState: 'not_applicable',
        error: null,
        createdAtMs: 500,
        updatedAtMs: 1500,
      },
    ];
  });

  // Transfer filter separates Active Queue (paused/resumable) vs Transfer History (completed)
  await page.getByRole('button', { name: /传输历史/ }).click();
  await expect(page.locator('.transfer-row')).toHaveCount(1);
  await expect(page.locator('.transfer-row').first()).toContainText('/etc/nginx/nginx.conf');

  await page.getByRole('button', { name: /进行中队列/ }).click();
  await expect(page.locator('.transfer-row')).toHaveCount(1);
  await expect(page.locator('.transfer-row').first()).toContainText('app.tar.gz');

  // Toggle dual-pane local bookmark and inspect bookmarks popover
  const localAddBtn = page.locator('.file-browser-pane').first().getByRole('button', { name: '收藏当前路径' });
  await expect(localAddBtn).toBeEnabled();
  await localAddBtn.click();
  await page.locator('.file-browser-pane').first().getByRole('button', { name: '路径书签列表' }).click();
  const popover = page.locator('.path-bookmarks-popover');
  await expect(popover).toBeVisible();
  await expect(popover).toContainText('deploy');
  await page.keyboard.press('Escape');
  await expect(popover).toHaveCount(0);
});

test('supports remote-to-remote SFTP relay dialog with endpoint disclosure and confirmation', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(() => {
    const profiles = [
      {
        id: 'prof-relay-a',
        name: 'prod-a',
        group: '生产环境',
        host: '10.10.0.10',
        port: 22,
        username: 'deploy',
        environment: 'production',
        favorite: true,
        tags: ['relay'],
        authenticationMethod: 'agent',
        identityFile: null,
        sshKeyId: null,
        proxyJump: null,
        proxyJumpProfileIds: [],
        proxyProfileId: null,
        credentialRef: null,
        state: 'idle',
        latencyMs: null,
        lastUsedAt: String(Date.now()),
      },
      {
        id: 'prof-relay-b',
        name: 'prod-b',
        group: '生产环境',
        host: '10.10.0.20',
        port: 2222,
        username: 'ops',
        environment: 'production',
        favorite: false,
        tags: ['relay'],
        authenticationMethod: 'agent',
        identityFile: null,
        sshKeyId: null,
        proxyJump: null,
        proxyJumpProfileIds: [],
        proxyProfileId: null,
        credentialRef: null,
        state: 'idle',
        latencyMs: null,
        lastUsedAt: String(Date.now() - 10_000),
      },
    ];
    localStorage.setItem('filex.connection-profiles.v1', JSON.stringify(profiles));
  });
  await page.reload();
  await page.waitForFunction(() => Boolean(
    (document.querySelector('#app') as HTMLElement & { __vue_app__?: unknown }).__vue_app__,
  ));

  await page.evaluate(() => {
    type Root = HTMLElement & {
      __vue_app__?: {
        config: { globalProperties: { $pinia?: { _s: Map<string, Record<string, unknown>> } } };
      };
    };
    const pinia = (document.querySelector('#app') as Root).__vue_app__?.config.globalProperties.$pinia;
    const settings = pinia?._s.get('settings') as { value: Record<string, unknown> } | undefined;
    const sessions = pinia?._s.get('sessions');
    const sftp = pinia?._s.get('sftp');
    const transfers = pinia?._s.get('transfers');
    if (!settings || !sessions || !sftp || !transfers) throw new Error('Relay stores unavailable');

    settings.value.inspectorTab = 'files';
    settings.value.fileBrowserOpen = true;
    settings.value.dualPaneSftp = false;
    sessions.isQuickProfile = () => false;
    sessions.summaries = [
      {
        id: 'sess-relay-a',
        generation: 1,
        profileId: 'prof-relay-a',
        sessionKind: 'ssh',
        capabilities: ['remote_shell', 'sftp', 'remote_edit', 'host_monitoring', 'tunneling', 'remote_jobs'],
        state: 'connected',
        host: '10.10.0.10',
        port: 22,
        username: 'deploy',
        lastError: null,
      },
      {
        id: 'sess-relay-b',
        generation: 1,
        profileId: 'prof-relay-b',
        sessionKind: 'ssh',
        capabilities: ['remote_shell', 'sftp', 'remote_edit', 'host_monitoring', 'tunneling', 'remote_jobs'],
        state: 'connected',
        host: '10.10.0.20',
        port: 2222,
        username: 'ops',
        lastError: null,
      },
    ];
    sessions.activeSessionId = 'sess-relay-a';
    sessions.sessionCwds = {
      'sess-relay-a': '/srv/releases',
      'sess-relay-b': '/srv/incoming',
    };
    sftp.load = () => Promise.resolve();
    sftp.error = null;
    sftp.sessionId = 'sess-relay-a';
    sftp.path = '/srv/releases';
    sftp.entries = [
      {
        name: 'bundle.tar.gz',
        path: '/srv/releases/bundle.tar.gz',
        isDirectory: false,
        isSymlink: false,
        size: 8192,
        modifiedAtMs: Date.now(),
        permissionsMode: 0o644,
        uid: 0,
        gid: 0,
      },
    ];
    transfers.tasks = [
      {
        id: 't-relay-1',
        profileId: 'prof-relay-a',
        sessionId: 'sess-relay-a',
        direction: 'remote_to_remote',
        localPath: '',
        remotePath: '/srv/releases/bundle.tar.gz',
        destinationProfileId: 'prof-relay-b',
        destinationSessionId: 'sess-relay-b',
        destinationRemotePath: '/srv/incoming/bundle.tar.gz',
        state: 'running',
        bytesTransferred: 2048,
        totalBytes: 8192,
        conflictPolicy: 'ask',
        remoteSizeBytes: 8192,
        remoteMtimeMs: 1700000000000,
        stagingPath: '/srv/incoming/.filex-part-t-relay-1',
        resumeState: 'not_applicable',
        error: null,
        createdAtMs: 1000,
        updatedAtMs: 2000,
      },
    ];
  });

  const remoteRow = page.locator('.file-row', { hasText: 'bundle.tar.gz' });
  await expect(remoteRow).toBeVisible();
  await remoteRow.click({ button: 'right' });

  const menu = page.getByRole('menu', { name: '文件操作' });
  await expect(menu).toBeVisible();
  await menu.getByRole('menuitem', { name: '中转至其他主机…' }).click();

  const dialog = page.getByRole('dialog', { name: '远端主机间中转传输' });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('.relay-note')).toContainText('不经过本地磁盘落盘');
  await expect(dialog).toContainText('prod-a (deploy@10.10.0.10:22)');
  await expect(dialog.locator('input').nth(1)).toHaveValue('/srv/releases/bundle.tar.gz');
  await expect(dialog.locator('input').nth(2)).toHaveValue('/srv/incoming/bundle.tar.gz');

  const submitBtn = dialog.getByRole('button', { name: '加入队列' });
  await expect(submitBtn).toBeDisabled();

  // Choosing identical host and identical path blocks submission explicitly
  await dialog.locator('select').first().selectOption('prof-relay-a');
  await dialog.locator('input').nth(2).fill('/srv/releases/bundle.tar.gz');
  await expect(dialog.getByRole('alert')).toContainText('源端点与目标端点（主机与路径）不能相同。');
  await expect(submitBtn).toBeDisabled();

  // Switch back to distinct destination host and confirm endpoint notice
  await dialog.locator('select').first().selectOption('prof-relay-b');
  await dialog.locator('input').nth(2).fill('/srv/incoming/bundle.tar.gz');
  await dialog.getByLabel(/我确认将文件从/).check();
  await expect(submitBtn).toBeEnabled();
  await page.screenshot({ path: 'test-results/remote-relay-dialog-1440.png' });

  await submitBtn.click();
  await expect(dialog.getByRole('alert')).toContainText('传输队列仅可在 FILEX 桌面应用中使用。');
  await dialog.getByRole('button', { name: '取消' }).click();
  await expect(dialog).toHaveCount(0);

  // Verify relay badge and both endpoints appear cleanly in the Activity drawer
  await page.getByRole('button', { name: '活动中心' }).click();
  const drawer = page.locator('.task-drawer');
  await expect(drawer).toBeVisible();
  await expect(drawer.locator('.transfer-relay-badge')).toContainText('中转');
  await expect(drawer).toContainText('prod-a:/srv/releases/bundle.tar.gz');
  await expect(drawer).toContainText('prod-b:/srv/incoming/bundle.tar.gz');
});

test('renders workbench overview, unified activity center, and bounded remote jobs across themes and viewports', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(() => {
    const profiles = [
      {
        id: 'prof-ov-1',
        name: 'edge-gateway',
        group: '生产环境',
        host: '10.80.1.15',
        port: 22,
        username: 'ops',
        environment: 'production',
        favorite: true,
        tags: ['edge'],
        authenticationMethod: 'agent',
        identityFile: null,
        sshKeyId: null,
        proxyJump: null,
        proxyJumpProfileIds: [],
        proxyProfileId: null,
        credentialRef: null,
        state: 'idle',
        latencyMs: null,
        lastUsedAt: String(Date.now()),
      },
    ];
    localStorage.setItem('filex.connection-profiles.v1', JSON.stringify(profiles));
  });
  await page.reload();

  await page.evaluate(() => {
    type Root = HTMLElement & {
      __vue_app__?: {
        config: { globalProperties: { $pinia?: { _s: Map<string, Record<string, unknown>> } } };
      };
    };
    const pinia = (document.querySelector('#app') as Root).__vue_app__?.config.globalProperties.$pinia;
    const settings = pinia?._s.get('settings') as { value: Record<string, unknown> } | undefined;
    const sessions = pinia?._s.get('sessions');
    const transfers = pinia?._s.get('transfers');
    const tunnels = pinia?._s.get('tunnels');
    const remoteJobs = pinia?._s.get('remoteJobs');
    const events = pinia?._s.get('events');
    if (!settings || !sessions || !transfers || !tunnels || !remoteJobs || !events) {
      throw new Error('Activity/Overview stores unavailable');
    }

    settings.value.theme = 'dark';
    sessions.isQuickProfile = () => false;
    sessions.summaries = [
      {
        id: 'sess-ov-1',
        generation: 3,
        profileId: 'prof-ov-1',
        sessionKind: 'ssh',
        capabilities: ['remote_shell', 'sftp', 'remote_edit', 'host_monitoring', 'tunneling', 'remote_jobs'],
        state: 'connected',
        host: '10.80.1.15',
        port: 22,
        username: 'ops',
        lastError: null,
      },
    ];
    sessions.activeSessionId = 'sess-ov-1';
    transfers.tasks = [
      {
        id: 't-act-1',
        profileId: 'prof-ov-1',
        sessionId: 'sess-ov-1',
        direction: 'download',
        localPath: 'C:\\logs\\edge.log',
        remotePath: '/var/log/edge.log',
        destinationProfileId: null,
        destinationSessionId: null,
        destinationRemotePath: null,
        state: 'completed',
        bytesTransferred: 1024,
        totalBytes: 1024,
        conflictPolicy: 'ask',
        remoteSizeBytes: 1024,
        remoteMtimeMs: 1700000000000,
        stagingPath: null,
        resumeState: 'not_applicable',
        error: null,
        createdAtMs: Date.now() - 12_000,
        updatedAtMs: Date.now() - 8_000,
      },
    ];
    tunnels.rules = [
      {
        id: 'rule-ov-1',
        profileId: 'prof-ov-1',
        name: 'metrics',
        kind: 'local',
        bindHost: '127.0.0.1',
        bindPort: 9100,
        targetHost: '127.0.0.1',
        targetPort: 9100,
        autoStart: false,
      },
    ];
    tunnels.tunnels = [
      {
        id: 'tun-act-1',
        sessionId: 'sess-ov-1',
        profileId: 'prof-ov-1',
        name: 'metrics',
        kind: 'local',
        bindHost: '127.0.0.1',
        bindPort: 9100,
        targetHost: '127.0.0.1',
        targetPort: 9100,
        allowNonLoopback: false,
        state: 'listening',
        lastError: null,
      },
    ];
    remoteJobs.jobs = [
      {
        id: 'job-run-1',
        sessionId: 'sess-ov-1',
        sessionGeneration: 3,
        profileId: 'prof-ov-1',
        targetHost: '10.80.1.15',
        targetPort: 22,
        targetUsername: 'ops',
        kind: 'tail_system_log',
        commandLabel: 'journalctl -n 100',
        targetDetail: null,
        riskClass: 'read_only',
        state: 'running',
        createdAtMs: Date.now() - 5_000,
        startedAtMs: Date.now() - 4_800,
        finishedAtMs: null,
        exitCode: null,
        exitSignal: null,
        outputStartOffset: 128,
        outputEndOffset: 262272,
        outputRetainedBytes: 262144,
        outputTruncated: true,
        error: null,
      },
      {
        id: 'job-uncertain-2',
        sessionId: 'sess-ov-1',
        sessionGeneration: 3,
        profileId: 'prof-ov-1',
        targetHost: '10.80.1.15',
        targetPort: 22,
        targetUsername: 'ops',
        kind: 'check_system_health',
        commandLabel: 'system-health-check',
        targetDetail: null,
        riskClass: 'read_only',
        state: 'outcome_uncertain',
        createdAtMs: Date.now() - 25_000,
        startedAtMs: Date.now() - 24_000,
        finishedAtMs: Date.now() - 18_000,
        exitCode: null,
        exitSignal: null,
        outputStartOffset: 0,
        outputEndOffset: 42,
        outputRetainedBytes: 42,
        outputTruncated: false,
        error: {
          code: 'REMOTE_JOB_OUTCOME_UNCERTAIN',
          messageKey: 'errors.remoteJobOutcomeUncertain',
          retryable: false,
          remoteState: 'unknown',
        },
      },
    ];
    remoteJobs.outputByJob = {
      'job-run-1': {
        jobId: 'job-run-1',
        startOffset: 128,
        endOffset: 262272,
        retainedStartOffset: 128,
        retainedEndOffset: 262272,
        truncated: true,
        content: '2026-11-15T12:00:00Z edge systemd: nginx worker ready\n',
        state: 'running',
      },
      'job-uncertain-2': {
        jobId: 'job-uncertain-2',
        startOffset: 0,
        endOffset: 42,
        retainedStartOffset: 0,
        retainedEndOffset: 42,
        truncated: false,
        content: 'Linux edge 6.8.0-generic\n',
        state: 'outcome_uncertain',
      },
    };
    events.entries = [
      {
        id: 'evt-act-1',
        occurredAt: new Date().toISOString(),
        category: 'session',
        severity: 'warning',
        code: 'remote_job.outcome_uncertain',
        details: { host: '10.80.1.15', command: 'system-health-check' },
      },
    ];
  });

  // Open Workbench Overview from the FILEX product mark
  await page.getByRole('button', { name: '打开工作台概览' }).click();
  const overview = page.getByRole('dialog', { name: '工作台概览' });
  await expect(overview).toBeVisible();
  await expect(overview).toContainText('edge-gateway');
  await expect(overview).toContainText('ops@10.80.1.15:22');
  await page.screenshot({ path: 'test-results/overview-1440-dark.png' });
  await page.keyboard.press('Escape');
  await expect(overview).toHaveCount(0);

  // Also reachable from Command Palette
  await page.getByRole('button', { name: '命令面板' }).click();
  await page.getByRole('option', { name: '打开工作台概览' }).click();
  await expect(overview).toBeVisible();
  await overview.getByRole('button', { name: '打开活动中心' }).click();
  await expect(overview).toHaveCount(0);

  // Unified Activity drawer stays visible without replacing the terminal workspace
  const drawer = page.locator('.task-drawer');
  await expect(drawer).toBeVisible();
  await expect(drawer.locator('.activity-row')).toHaveCount(5);

  // Selecting uncertain job opens details pane without hiding terminal
  await drawer.locator('.activity-row-button', { hasText: 'system-health-check' }).click();
  await expect(page.locator('.terminal-workspace')).toBeVisible();
  const detail = drawer.locator('.activity-detail-pane');
  await expect(detail).toBeVisible();
  await expect(detail).toContainText('结果未知');
  await expect(detail).toContainText('REMOTE_JOB_OUTCOME_UNCERTAIN');

  // Selecting running streaming job displays ring-buffer truncation notice & output
  await drawer.locator('.activity-row-button', { hasText: 'journalctl -n 100' }).click();
  await expect(detail).toContainText('256 KiB');
  await expect(detail.locator('.activity-output-pre')).toContainText('nginx worker ready');

  // Active-only filter narrows unified list cleanly
  await drawer.getByRole('button', { name: '仅看进行中' }).click();
  await expect(drawer.locator('.activity-row')).toHaveCount(2);

  // Switch to Remote Jobs tab and verify bounded structured preset controls
  await drawer.getByRole('tab', { name: /远程作业/ }).click();
  const launcherSelect = drawer.locator('#remote-job-kind');
  await launcherSelect.selectOption('inspect_disk_usage');
  await expect(drawer.getByPlaceholder('目录路径（例如 /var/log）')).toBeVisible();
  await expect(drawer.locator('.transfer-row')).toHaveCount(2);

  // Light theme + compact 960x640 layout check
  await page.setViewportSize({ width: 960, height: 640 });
  await page.evaluate(() => {
    type Root = HTMLElement & {
      __vue_app__?: {
        config: { globalProperties: { $pinia?: { _s: Map<string, Record<string, unknown>> } } };
      };
    };
    const pinia = (document.querySelector('#app') as Root).__vue_app__?.config.globalProperties.$pinia;
    const settings = pinia?._s.get('settings') as {
      value: Record<string, unknown>;
      apply?: () => void;
    } | undefined;
    if (settings) {
      settings.value.theme = 'light';
      settings.apply?.();
    }
  });
  await expect(drawer).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.classList.contains('light'))).toBe(true);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(960);
  await page.screenshot({ path: 'test-results/activity-960-light.png', animations: 'disabled' });

  await page.getByRole('button', { name: '打开工作台概览' }).click();
  await expect(overview).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(960);
  await page.screenshot({ path: 'test-results/overview-960-light.png', animations: 'disabled' });
  await page.keyboard.press('Escape');
});

test('locates folders and files by typing letters in virtualized and standard folder lists', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForFunction(() => Boolean(
    (document.querySelector('#app') as HTMLElement & { __vue_app__?: unknown }).__vue_app__,
  ));
  await page.evaluate(() => {
    type Store = Record<string, unknown>;
    type Root = HTMLElement & {
      __vue_app__?: {
        config: { globalProperties: { $pinia?: { _s: Map<string, Store> } } };
      };
    };
    const pinia = (document.querySelector('#app') as Root).__vue_app__
      ?.config.globalProperties.$pinia;
    const sessions = pinia?._s.get('sessions');
    const sftp = pinia?._s.get('sftp');
    const settings = pinia?._s.get('settings');
    if (!sessions || !sftp || !settings) throw new Error('File browser fixture stores unavailable');

    const now = Date.now();
    const entries: Array<Record<string, unknown>> = [];
    for (let i = 0; i < 230; i += 1) {
      const code = String(i).padStart(3, '0');
      entries.push({
        name: `dir-${code}`,
        path: `/srv/releases/dir-${code}`,
        isDirectory: true,
        isSymlink: false,
        size: null,
        modifiedAtMs: now,
        permissionsMode: 0o755,
        uid: 0,
        gid: 0,
      });
    }
    entries.push(
      {
        name: 'zebra-dir',
        path: '/srv/releases/zebra-dir',
        isDirectory: true,
        isSymlink: false,
        size: null,
        modifiedAtMs: now,
        permissionsMode: 0o755,
        uid: 0,
        gid: 0,
      },
      {
        name: 'alpha.txt',
        path: '/srv/releases/alpha.txt',
        isDirectory: false,
        isSymlink: false,
        size: 64,
        modifiedAtMs: now,
        permissionsMode: 0o644,
        uid: 0,
        gid: 0,
      },
      {
        name: 'readme.md',
        path: '/srv/releases/readme.md',
        isDirectory: false,
        isSymlink: false,
        size: 128,
        modifiedAtMs: now,
        permissionsMode: 0o644,
        uid: 0,
        gid: 0,
      },
      {
        name: 'release.env',
        path: '/srv/releases/release.env',
        isDirectory: false,
        isSymlink: false,
        size: 256,
        modifiedAtMs: now,
        permissionsMode: 0o640,
        uid: 0,
        gid: 0,
      },
      {
        name: 'zeta.log',
        path: '/srv/releases/zeta.log',
        isDirectory: false,
        isSymlink: false,
        size: 512,
        modifiedAtMs: now,
        permissionsMode: 0o644,
        uid: 0,
        gid: 0,
      },
    );

    const session = {
      id: 'session-typeahead-e2e',
      generation: 1,
      profileId: 'profile-typeahead-e2e',
      sessionKind: 'ssh',
      capabilities: ['remote_shell', 'sftp', 'remote_edit'],
      state: 'connected',
      host: '10.24.1.42',
      port: 22,
      username: 'operator',
      lastError: null,
    };
    sessions.summaries = [session];
    sessions.activeSessionId = session.id;
    sessions.isQuickProfile = () => false;
    sftp.load = () => Promise.resolve(true);
    sftp.sessionId = session.id;
    sftp.path = '/srv/releases';
    sftp.entries = entries;
    Object.assign(settings.value as Record<string, unknown>, {
      theme: 'dark',
      fileBrowserOpen: true,
      focusMode: false,
      dualPaneSftp: false,
      locale: 'zh-CN',
      fileBrowserHeight: 260,
    });
    (settings as { apply?: () => void }).apply?.();
  });

  await expect.poll(() => page.evaluate(() => document.documentElement.classList.contains('dark'))).toBe(true);
  await page.setViewportSize({ width: 1440, height: 900 });

  // Focus the file list area (clicking the non-row column header focuses .file-list)
  const fileList = page.locator('.file-browser-panel .file-list').first();
  await fileList.locator('.file-table-header').click();

  // Single-letter jump in a >200 virtualized list locates zebra-dir far below initial viewport
  await page.keyboard.press('z');
  const zebraRow = page.locator('.file-row', { hasText: 'zebra-dir' });
  await expect(zebraRow).toBeVisible();
  await expect(zebraRow).toHaveClass(/selected/);
  await expect(zebraRow).toBeFocused();
  await expect(fileList.locator('.file-typeahead-pill')).toContainText('定位: z');
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1440);
  await page.screenshot({ path: 'test-results/file-typeahead-1440-dark.png', animations: 'disabled' });

  // Repeated same-letter press cycles to zeta.log
  await page.keyboard.press('z');
  const zetaRow = page.locator('.file-row', { hasText: 'zeta.log' });
  await expect(zetaRow).toBeVisible();
  await expect(zetaRow).toHaveClass(/selected/);
  await expect(zetaRow).toBeFocused();

  // Escape dismisses the typeahead pill cleanly
  await page.keyboard.press('Escape');
  await expect(fileList.locator('.file-typeahead-pill')).toHaveCount(0);

  // Rapid multi-letter prefix jumps from readme.md -> release.env
  await page.keyboard.type('rel', { delay: 30 });
  const releaseRow = page.locator('.file-row', { hasText: 'release.env' });
  await expect(releaseRow).toBeVisible();
  await expect(releaseRow).toHaveClass(/selected/);
  await expect(releaseRow).toBeFocused();
  await expect(fileList.locator('.file-typeahead-pill')).toContainText('定位: rel');

  // ArrowUp navigates cleanly to the previous entry (readme.md)
  await page.keyboard.press('ArrowUp');
  const readmeRow = page.locator('.file-row', { hasText: 'readme.md' });
  await expect(readmeRow).toHaveClass(/selected/);
  await expect(readmeRow).toBeFocused();

  // Typing inside the path input does NOT trigger file list typeahead
  const pathInput = page.getByLabel('当前目录路径');
  await pathInput.click();
  await pathInput.press('a');
  await expect(readmeRow).toHaveClass(/selected/);
});

test('supports Ctrl+C and Ctrl+V upload from local pane and desktop clipboard', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForFunction(() => Boolean(
    (document.querySelector('#app') as HTMLElement & { __vue_app__?: unknown }).__vue_app__,
  ));
  await page.evaluate(() => {
    type Store = Record<string, unknown>;
    type Root = HTMLElement & {
      __vue_app__?: {
        config: { globalProperties: { $pinia?: { _s: Map<string, Store> } } };
      };
    };
    const pinia = (document.querySelector('#app') as Root).__vue_app__
      ?.config.globalProperties.$pinia;
    const sessions = pinia?._s.get('sessions');
    const sftp = pinia?._s.get('sftp');
    const settings = pinia?._s.get('settings');
    const localFiles = pinia?._s.get('local-files');
    if (!sessions || !sftp || !settings || !localFiles) {
      throw new Error('File browser fixture stores unavailable');
    }
    const now = Date.now();
    const session = {
      id: 'session-copy-upload-e2e',
      generation: 1,
      profileId: 'profile-copy-upload-e2e',
      sessionKind: 'ssh',
      capabilities: ['remote_shell', 'sftp', 'remote_edit'],
      state: 'connected',
      host: '10.24.1.50',
      port: 22,
      username: 'deploy',
      lastError: null,
    };
    sessions.summaries = [session];
    sessions.activeSessionId = session.id;
    sessions.isQuickProfile = () => false;
    sftp.load = () => Promise.resolve(true);
    sftp.sessionId = session.id;
    sftp.path = '/srv/www';
    sftp.entries = [
      {
        name: 'current',
        path: '/srv/www/current',
        isDirectory: true,
        isSymlink: false,
        size: null,
        modifiedAtMs: now,
        permissionsMode: 0o755,
        uid: 0,
        gid: 0,
      },
    ];
    localFiles.load = () => Promise.resolve(true);
    localFiles.listing = {
      path: 'C:\\workspace',
      parentPath: 'C:\\',
      truncated: false,
      entries: [
        {
          name: 'dist',
          path: 'C:\\workspace\\dist',
          isDirectory: true,
          isSymlink: false,
          size: null,
          modifiedAtMs: now,
          permissionsMode: null,
        },
        {
          name: 'bundle.zip',
          path: 'C:\\workspace\\bundle.zip',
          isDirectory: false,
          isSymlink: false,
          size: 2048,
          modifiedAtMs: now,
          permissionsMode: null,
        },
      ],
    };
    Object.assign(settings.value as Record<string, unknown>, {
      fileBrowserOpen: true,
      focusMode: false,
      dualPaneSftp: true,
      taskDrawerOpen: false,
      locale: 'zh-CN',
      fileBrowserHeight: 260,
    });
  });

  const localPane = page.getByRole('region', { name: '本机目录' });
  const remotePane = page.getByRole('region', { name: '远端目录' });
  await expect(localPane).toBeVisible();
  await expect(remotePane).toBeVisible();

  // Context menus expose copyForUpload on local and pasteUpload on remote
  const distRow = localPane.locator('.file-row', { hasText: 'dist' });
  await distRow.click({ button: 'right' });
  const menu = page.getByRole('menu', { name: '文件操作' });
  await expect(menu.getByRole('menuitem', { name: '复制以供上传' })).toBeVisible();
  await page.keyboard.press('Escape');

  await remotePane.locator('.file-table-header').click({ button: 'right' });
  await expect(menu.getByRole('menuitem', { name: '粘贴上传' })).toBeVisible();
  await page.keyboard.press('Escape');

  // Ctrl+C on local entry + Ctrl+V on remote pane hits the desktop boundary cleanly in browser mode
  await distRow.click();
  await page.keyboard.press('Control+c');
  await expect(page.locator('.toast')).toContainText('已复制「dist」，可在远端目录按 Ctrl+V 上传。');

  await remotePane.locator('.file-table-header').click();
  await page.keyboard.press('Control+v');
  await expect(page.locator('.toast')).toContainText('仅在 FILEX 桌面应用中可用');

  // Mock desktop IPC to verify full OS clipboard Ctrl+V upload queueing end-to-end
  await page.evaluate(() => {
    const enqueued: Array<Record<string, unknown>> = [];
    const win = window as Window & {
      __TEST_ENQUEUED__?: Array<Record<string, unknown>>;
      __TAURI_INTERNALS__?: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };
    };
    win.__TEST_ENQUEUED__ = enqueued;
    win.__TAURI_INTERNALS__ = {
      invoke(cmd: string, args?: Record<string, unknown>) {
        if (cmd === 'read_clipboard_file_paths') {
          return Promise.resolve({
            ok: true,
            requestId: 'req-clip',
            data: {
              paths: ['C:\\workspace\\dist', 'C:\\workspace\\bundle.zip'],
              sequence: 99,
              supported: true,
            },
          });
        }
        if (cmd === 'inspect_local_entry') {
          const path = typeof args?.path === 'string' ? args.path : '';
          if (path.endsWith('dist')) {
            return Promise.resolve({
              ok: true,
              requestId: 'req-inspect-1',
              data: {
                name: 'dist',
                path: 'C:\\workspace\\dist',
                isDirectory: true,
                isSymlink: false,
                size: null,
                modifiedAtMs: Date.now(),
                permissionsMode: null,
              },
            });
          }
          return Promise.resolve({
            ok: true,
            requestId: 'req-inspect-2',
            data: {
              name: 'bundle.zip',
              path: 'C:\\workspace\\bundle.zip',
              isDirectory: false,
              isSymlink: false,
              size: 2048,
              modifiedAtMs: Date.now(),
              permissionsMode: null,
            },
          });
        }
        if (cmd === 'enqueue_transfer') {
          const input = (args?.input ?? {}) as Record<string, unknown>;
          enqueued.push(input);
          const idx = enqueued.length;
          return Promise.resolve({
            ok: true,
            requestId: `req-xfer-${idx}`,
            data: {
              id: `xfer-${idx}`,
              profileId: input.profileId,
              sessionId: args?.sessionId ?? null,
              direction: input.direction,
              localPath: input.localPath,
              remotePath: input.remotePath,
              destinationProfileId: null,
              destinationSessionId: null,
              destinationRemotePath: null,
              state: 'queued',
              bytesTransferred: 0,
              totalBytes: input.totalBytes ?? null,
              conflictPolicy: input.conflictPolicy ?? 'ask',
              remoteSizeBytes: null,
              remoteMtimeMs: null,
              stagingPath: null,
              resumeState: 'not_applicable',
              error: null,
              createdAtMs: Date.now(),
              updatedAtMs: Date.now(),
            },
          });
        }
        if (cmd === 'save_safe_settings') {
          return Promise.resolve({ ok: true, requestId: 'req-save', data: args?.settings ?? {} });
        }
        return Promise.resolve({ ok: true, requestId: 'req-noop', data: null });
      },
    };
  });

  await remotePane.locator('.file-table-header').click();
  await page.keyboard.press('Control+v');
  await expect(page.locator('.toast')).toContainText('已将 2 个粘贴上传任务加入传输队列。');
  await expect(page.locator('.task-drawer')).toBeVisible();
  await expect(page.locator('.transfer-row')).toHaveCount(2);
  await expect(page.locator('.task-drawer')).toContainText('/srv/www/dist');
  await expect(page.locator('.task-drawer')).toContainText('/srv/www/bundle.zip');

  // Compact 960x640 light-theme visual & overflow check
  await page.setViewportSize({ width: 960, height: 640 });
  await page.evaluate(() => {
    const root = document.querySelector('#app') as HTMLElement & {
      __vue_app__?: {
        config: { globalProperties: { $pinia?: { _s: Map<string, Record<string, unknown>> } } };
      };
    };
    const settings = root.__vue_app__?.config.globalProperties.$pinia?._s.get('settings') as ({
      value?: Record<string, unknown>;
      apply?: () => void;
    } | undefined);
    if (settings?.value) {
      settings.value.theme = 'light';
      settings.apply?.call(settings);
    }
  });
  await expect.poll(() => page.evaluate(() => document.documentElement.classList.contains('light'))).toBe(true);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(960);
  await page.screenshot({ path: 'test-results/file-clipboard-upload-960-light.png', animations: 'disabled' });

  await page.evaluate(() => {
    delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });
});

test('preserves terminal, SFTP, composer draft, and monitor state when duplicating and switching sessions', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(() => {
    const profiles = [
      {
        id: 'prof-persist-a',
        name: 'prod-persist',
        group: '生产环境',
        host: '10.90.0.10',
        port: 22,
        username: 'deploy',
        environment: 'production',
        favorite: true,
        tags: ['persist'],
        authenticationMethod: 'agent',
        identityFile: null,
        sshKeyId: null,
        proxyJump: null,
        proxyJumpProfileIds: [],
        proxyProfileId: null,
        credentialRef: null,
        state: 'idle',
        latencyMs: null,
        lastUsedAt: String(Date.now()),
      },
      {
        id: 'prof-persist-b',
        name: 'other-host',
        group: '生产环境',
        host: '10.90.0.20',
        port: 22,
        username: 'ops',
        environment: 'staging',
        favorite: false,
        tags: [],
        authenticationMethod: 'agent',
        identityFile: null,
        sshKeyId: null,
        proxyJump: null,
        proxyJumpProfileIds: [],
        proxyProfileId: null,
        credentialRef: null,
        state: 'idle',
        latencyMs: null,
        lastUsedAt: String(Date.now() - 5_000),
      },
    ];
    localStorage.setItem('filex.connection-profiles.v1', JSON.stringify(profiles));
  });
  await page.reload();
  await page.waitForFunction(() => Boolean(
    (document.querySelector('#app') as HTMLElement & { __vue_app__?: unknown }).__vue_app__,
  ));

  await page.evaluate(() => {
    type Root = HTMLElement & {
      __vue_app__?: {
        config: { globalProperties: { $pinia?: { _s: Map<string, Record<string, unknown>> } } };
      };
    };
    const w = window as unknown as {
      __sftpLoads: Array<{ sessionId: string; path: string }>;
      __resizeCalls: string[];
    };
    w.__sftpLoads = [];
    w.__resizeCalls = [];

    const pinia = (document.querySelector('#app') as Root).__vue_app__?.config.globalProperties.$pinia;
    const settings = pinia?._s.get('settings') as { value: Record<string, unknown>; apply?: () => void } | undefined;
    const sessions = pinia?._s.get('sessions') as {
      summaries: Array<Record<string, unknown>>;
      activeSessionId: string | null;
      outputBuffers: Record<string, Uint8Array[]>;
      outputBufferStarts: Record<string, number>;
      outputRevision: number;
      sessionCwds: Record<string, string>;
      isQuickProfile: (id?: string | null) => boolean;
      resizeSession: (id: string, cols: number, rows: number) => Promise<void>;
      begin: (profile: Record<string, unknown>) => Promise<void>;
      selectSession: (id: string) => void;
    } | undefined;
    const sftp = pinia?._s.get('sftp') as {
      sessionId: string | null;
      path: string;
      entries: Array<Record<string, unknown>>;
      directoryChildren: Record<string, Array<{ name: string; path: string }>>;
      loading: boolean;
      error: unknown;
      selectedPath: string | null;
      load: (sessionId: string, path: string) => Promise<boolean>;
      loadTreeDirectory: (treePath: string) => Promise<void>;
      select: (entry: Record<string, unknown>) => void;
    } | undefined;
    const monitor = pinia?._s.get('monitor') as {
      snapshot: Record<string, unknown> | null;
      collect: () => Promise<void>;
    } | undefined;
    if (!settings || !sessions || !sftp || !monitor) {
      throw new Error('Persistence E2E stores unavailable');
    }

    Object.assign(settings.value, {
      theme: 'dark',
      locale: 'zh-CN',
      fileBrowserOpen: true,
      compactComposerOpen: true,
      followTerminalCwd: true,
      dualPaneSftp: false,
      focusMode: false,
    });
    settings.apply?.();

    const fsBySession: Record<string, Record<string, Array<{ name: string; path: string; isDirectory: boolean }>>> = {
      'sess-orig': {
        '/': [
          { name: 'srv', path: '/srv', isDirectory: true },
          { name: 'var', path: '/var', isDirectory: true },
        ],
        '/srv': [{ name: 'app', path: '/srv/app', isDirectory: true }],
        '/srv/app': [{ name: 'README.md', path: '/srv/app/README.md', isDirectory: false }],
        '/var': [{ name: 'log', path: '/var/log', isDirectory: true }],
        '/var/log': [{ name: 'nginx', path: '/var/log/nginx', isDirectory: true }],
        '/var/log/nginx': [{ name: 'access.log', path: '/var/log/nginx/access.log', isDirectory: false }],
      },
      'sess-dup': {
        '/': [{ name: 'root', path: '/root', isDirectory: true }],
        '/root': [{ name: 'dup-home.txt', path: '/root/dup-home.txt', isDirectory: false }],
      },
      'sess-other': {
        '/': [{ name: 'opt', path: '/opt', isDirectory: true }],
        '/opt': [{ name: 'service.conf', path: '/opt/service.conf', isDirectory: false }],
      },
    };

    const originalLoad = sftp.load.bind(sftp);
    void originalLoad;
    sftp.load = (sessionId: string, requestedPath: string) => {
      w.__sftpLoads.push({ sessionId, path: requestedPath });
      const resolved = requestedPath === '.'
        ? (sessionId === 'sess-orig' ? '/srv/app' : sessionId === 'sess-dup' ? '/root' : '/opt')
        : requestedPath;
      const map = fsBySession[sessionId] ?? {};
      const items = (map[resolved] ?? []).map((item) => ({
        name: item.name,
        path: item.path,
        isDirectory: item.isDirectory,
        isSymlink: false,
        size: item.isDirectory ? null : 256,
        modifiedAtMs: 1_700_000_000_000,
        permissionsMode: item.isDirectory ? 0o755 : 0o644,
        uid: 0,
        gid: 0,
      }));
      sftp.loading = false;
      sftp.error = null;
      sftp.sessionId = sessionId;
      sftp.path = resolved;
      sftp.entries = items;
      sftp.selectedPath = null;
      sftp.directoryChildren = {
        ...sftp.directoryChildren,
        [resolved]: items.filter((item) => item.isDirectory).map((item) => ({ name: item.name, path: item.path })),
      };
      return Promise.resolve(true);
    };
    sftp.loadTreeDirectory = (treePath: string) => {
      const sid = sftp.sessionId ?? '';
      const map = fsBySession[sid] ?? {};
      const dirs = (map[treePath] ?? []).filter((item) => item.isDirectory).map((item) => ({ name: item.name, path: item.path }));
      sftp.directoryChildren = { ...sftp.directoryChildren, [treePath]: dirs };
      return Promise.resolve();
    };

    monitor.collect = () => Promise.resolve();
    sessions.isQuickProfile = () => false;
    sessions.resizeSession = (id: string, cols: number, rows: number) => {
      w.__resizeCalls.push(`${id}:${cols}x${rows}`);
      return Promise.resolve();
    };
    sessions.begin = () => {
      const dup = {
        id: 'sess-dup',
        generation: 1,
        profileId: 'prof-persist-a',
        sessionKind: 'ssh',
        capabilities: ['remote_shell', 'sftp', 'remote_edit', 'host_monitoring', 'tunneling', 'remote_jobs'],
        state: 'connected',
        host: '10.90.0.10',
        port: 22,
        username: 'deploy',
        lastError: null,
      };
      sessions.summaries = [...sessions.summaries, dup];
      sessions.activeSessionId = 'sess-dup';
      const bytes = new TextEncoder().encode('DUP_SESSION_READY\r\n');
      sessions.outputBuffers = { ...sessions.outputBuffers, 'sess-dup': [bytes] };
      sessions.outputBufferStarts = { ...sessions.outputBufferStarts, 'sess-dup': 0 };
      sessions.outputRevision += 1;
      return Promise.resolve();
    };

    sessions.summaries = [
      {
        id: 'sess-orig',
        generation: 1,
        profileId: 'prof-persist-a',
        sessionKind: 'ssh',
        capabilities: ['remote_shell', 'sftp', 'remote_edit', 'host_monitoring', 'tunneling', 'remote_jobs'],
        state: 'connected',
        host: '10.90.0.10',
        port: 22,
        username: 'deploy',
        lastError: null,
      },
      {
        id: 'sess-other',
        generation: 1,
        profileId: 'prof-persist-b',
        sessionKind: 'ssh',
        capabilities: ['remote_shell', 'sftp', 'remote_edit', 'host_monitoring', 'tunneling', 'remote_jobs'],
        state: 'connected',
        host: '10.90.0.20',
        port: 22,
        username: 'ops',
        lastError: null,
      },
    ];
    sessions.activeSessionId = 'sess-orig';
    sessions.sessionCwds = { 'sess-orig': '/srv/app' };
    sessions.outputBuffers = {
      'sess-orig': [new TextEncoder().encode('ALPHA_MARKER_OUTPUT\r\n')],
      'sess-other': [new TextEncoder().encode('OTHER_HOST_OUTPUT\r\n')],
    };
    sessions.outputBufferStarts = { 'sess-orig': 0, 'sess-other': 0 };
    sessions.outputRevision += 1;
    monitor.snapshot = {
      state: 'live',
      collectedAtMs: Date.now(),
      hostname: 'alpha-prod-01',
      osName: 'Ubuntu 24.04',
      uptimeSeconds: 3600,
      loadOne: 0.2,
      cpuPercent: 10,
      memoryTotalKib: 4096,
      memoryAvailableKib: 2048,
      swapTotalKib: 1024,
      swapUsedKib: 0,
      rootTotalKib: 10000,
      rootAvailableKib: 5000,
      networkReceiveBytesPerSecond: 120,
      networkTransmitBytesPerSecond: 40,
    };
  });

  // 1) Prepare Session A state: navigate manually to /var/log/nginx, select access.log,
  //    open terminal search, type composer draft, and tag the live xterm DOM node.
  const remotePane = page.locator('.file-browser-pane');
  await expect(remotePane.locator('.file-row', { hasText: 'README.md' })).toBeVisible();
  const pathInput = remotePane.getByLabel('当前目录路径');
  await pathInput.fill('/var/log/nginx');
  await pathInput.press('Enter');
  const accessRow = remotePane.locator('.file-row', { hasText: 'access.log' });
  await expect(accessRow).toBeVisible();
  await accessRow.click();
  await expect(accessRow).toHaveClass(/selected/);

  await expect(page.locator('.terminal-pane:visible .xterm-rows')).toContainText('ALPHA_MARKER_OUTPUT');
  await page.locator('.terminal-tabs button[aria-label="搜索终端"]').click();
  const searchInput = page.locator('.terminal-search input');
  await searchInput.fill('ALPHA_MARKER_OUTPUT');
  await expect(page.locator('.terminal-search-position')).toContainText('1 / 1');

  const composer = page.locator('.command-input-bar textarea');
  await composer.fill('sudo systemctl status nginx');
  await page.evaluate(() => document.fonts?.ready);
  await page.waitForTimeout(160);

  await page.evaluate(() => {
    const visibleXterm = document.querySelector<HTMLElement>('.terminal-pane:not([style*="display: none"]) .xterm');
    if (!visibleXterm) throw new Error('Expected visible xterm for sess-orig');
    visibleXterm.dataset.persistToken = 'orig-xterm-instance';
  });

  // 2) Duplicate session (`复制会话`) -> opens sess-dup and populates its independent state
  await page.locator('button[aria-label="复制会话"]').click();
  await expect(page.locator('.terminal-tab')).toHaveCount(3);
  await expect(page.locator('.terminal-pane:visible .xterm-rows')).toContainText('DUP_SESSION_READY');
  await expect(remotePane.locator('.file-row', { hasText: 'dup-home.txt' })).toBeVisible();
  await expect(composer).toHaveValue('');
  await composer.fill('tail -n 50 /var/log/syslog');
  await expect(page.evaluate(() => {
    type Root = HTMLElement & {
      __vue_app__?: { config: { globalProperties: { $pinia?: { _s: Map<string, Record<string, unknown>> } } } };
    };
    const monitor = (document.querySelector('#app') as Root).__vue_app__?.config.globalProperties.$pinia?._s.get('monitor');
    return (monitor as { snapshot: unknown } | undefined)?.snapshot;
  })).resolves.toBeNull();

  // 3) Also switch to a different host tab (sess-other)
  await page.locator('.terminal-tab', { hasText: 'other-host' }).click();
  await expect(page.locator('.terminal-pane:visible .xterm-rows')).toContainText('OTHER_HOST_OUTPUT');
  await expect(remotePane.locator('.file-row', { hasText: 'service.conf' })).toBeVisible();
  await page.waitForTimeout(160);

  // Record call counters right before returning to Session A and Session B
  const countsBeforeSwitchBack = await page.evaluate(() => {
    const w = window as unknown as {
      __sftpLoads: Array<{ sessionId: string; path: string }>;
      __resizeCalls: string[];
    };
    return {
      sftpLoadCount: w.__sftpLoads.length,
      resizeCalls: [...w.__resizeCalls],
    };
  });

  // 4) Switch back to original Session A (`prod-persist` first tab)
  await page.locator('.terminal-tab').nth(0).click();
  await expect(page.locator('.terminal-pane:visible .xterm-rows')).toContainText('ALPHA_MARKER_OUTPUT');
  await expect(accessRow).toBeVisible();
  await expect(accessRow).toHaveClass(/selected/);
  await expect(pathInput).toHaveValue('/var/log/nginx');
  await expect(composer).toHaveValue('sudo systemctl status nginx');
  await expect(page.locator('.terminal-search input')).toHaveValue('ALPHA_MARKER_OUTPUT');
  await expect(page.locator('.terminal-search-position')).toContainText('1 / 1');

  await page.waitForTimeout(200);
  const restoredOrigCheck = await page.evaluate(() => {
    type Root = HTMLElement & {
      __vue_app__?: { config: { globalProperties: { $pinia?: { _s: Map<string, Record<string, unknown>> } } } };
    };
    const w = window as unknown as {
      __sftpLoads: Array<{ sessionId: string; path: string }>;
      __resizeCalls: string[];
    };
    const monitor = (document.querySelector('#app') as Root).__vue_app__?.config.globalProperties.$pinia?._s.get('monitor') as {
      snapshot: { hostname?: string } | null;
    } | undefined;
    const visibleXterm = document.querySelector<HTMLElement>('.terminal-pane:not([style*="display: none"]) .xterm');
    return {
      persistToken: visibleXterm?.dataset.persistToken ?? null,
      monitorHostname: monitor?.snapshot?.hostname ?? null,
      sftpLoadCount: w.__sftpLoads.length,
      resizeCalls: [...w.__resizeCalls],
    };
  });
  expect(restoredOrigCheck.persistToken).toBe('orig-xterm-instance');
  expect(restoredOrigCheck.monitorHostname).toBe('alpha-prod-01');
  expect(restoredOrigCheck.sftpLoadCount).toBe(countsBeforeSwitchBack.sftpLoadCount);
  expect(restoredOrigCheck.resizeCalls).toEqual(countsBeforeSwitchBack.resizeCalls);

  // 5) Switch back to duplicated session (`sess-dup`, third tab) -> also preserved without reloading
  await page.locator('.terminal-tab').nth(2).click();
  await expect(page.locator('.terminal-pane:visible .xterm-rows')).toContainText('DUP_SESSION_READY');
  await expect(remotePane.locator('.file-row', { hasText: 'dup-home.txt' })).toBeVisible();
  await expect(composer).toHaveValue('tail -n 50 /var/log/syslog');
  await page.waitForTimeout(200);
  const afterDupSwitchCounts = await page.evaluate(() => {
    const w = window as unknown as {
      __sftpLoads: Array<{ sessionId: string; path: string }>;
      __resizeCalls: string[];
    };
    return {
      sftpLoadCount: w.__sftpLoads.length,
      resizeCalls: [...w.__resizeCalls],
    };
  });
  expect(afterDupSwitchCounts.sftpLoadCount).toBe(countsBeforeSwitchBack.sftpLoadCount);
  expect(afterDupSwitchCounts.resizeCalls).toEqual(countsBeforeSwitchBack.resizeCalls);
});
