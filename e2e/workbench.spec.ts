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

test('exposes the local terminal context menu', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.locator('.terminal-pane-surface').click({ button: 'right', position: { x: 80, y: 70 } });
  const menu = page.getByRole('menu', { name: '终端窗格' });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: '清空终端显示' })).toBeFocused();
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

  const hostPanel = page.locator('.host-panel');
  await expect(hostPanel).toBeVisible();
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

  await hostPanel.getByRole('button', { name: '网络', exact: true }).click();
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
