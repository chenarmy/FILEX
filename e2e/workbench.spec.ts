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
  await expect(page.getByRole('button', { name: /e2e-node/ })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: /e2e-node/ })).toBeVisible();
});

test('supports keyboard shortcuts and accessible pane resizing', async ({ page }) => {
  await page.keyboard.press('Control+K');
  await expect(page.getByPlaceholder('搜索连接或输入 user@host')).toBeFocused();

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

test('defaults to password authentication and shows all three authentication options', async ({ page }) => {
  await page.getByRole('button', { name: '添加连接' }).click();
  const dialog = page.getByRole('dialog');
  const authentication = dialog.getByLabel('认证方式');

  await expect(authentication).toHaveValue('password');
  await expect(authentication.locator('option')).toHaveCount(3);
});

test('blocks ProxyJump profiles before opening an SSH trust or password dialog', async ({ page }) => {
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

  await page.getByRole('button', { name: /dev-sandbox/ }).click();
  await page.getByRole('button', { name: '重新连接' }).click();

  await expect(page.getByRole('alert')).toContainText('ProxyJump');
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('allows SSH Agent profiles through preflight and reaches the desktop runtime boundary', async ({ page }) => {
  await page.getByRole('button', { name: /worker-canary/ }).click();
  await page.getByRole('button', { name: '重新连接' }).click();

  await expect(page.getByRole('alert')).toContainText('desktop app');
  await expect(page.getByRole('dialog')).toHaveCount(0);
});
