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
