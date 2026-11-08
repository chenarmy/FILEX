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
  await expect(page.locator('.task-drawer')).toHaveCount(0);
  await page.keyboard.press('Control+J');
  await expect(page.locator('.task-drawer')).toBeVisible();

  const separator = page.getByRole('separator', { name: 'Resize connections pane' });
  await separator.focus();
  await page.keyboard.press('ArrowRight');
  const width = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--connections-pane-width'));
  expect(Number.parseInt(width, 10)).toBeGreaterThan(244);
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
