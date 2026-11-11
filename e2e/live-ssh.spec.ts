import { mkdir, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium, expect, test } from '@playwright/test';

const host = process.env.SSH_TEST_HOST?.trim();
const password = process.env.SSH_TEST_PASSWORD;
const username = process.env.SSH_TEST_USER?.trim() || 'root';
const port = Number(process.env.SSH_TEST_PORT || '22');
const cdpUrl = process.env.FILEX_CDP_URL || 'http://127.0.0.1:9222';

test('live SSH trust, authentication, terminal, SFTP and monitoring', async ({ browserName }, testInfo) => {
  test.skip(browserName !== 'chromium', 'The live WebView2 smoke test requires Chromium');
  test.skip(!host || !password, 'SSH_TEST_HOST and SSH_TEST_PASSWORD are required');
  test.skip(!Number.isInteger(port) || port < 1 || port > 65_535, 'SSH_TEST_PORT must be valid');

  await mkdir(resolve('test-results'), { recursive: true });
  const browser = await chromium.connectOverCDP(cdpUrl);
  const context = browser.contexts()[0];
  if (!context) throw new Error('No WebView2 browser context is available');
  const page = context.pages().find((candidate) => candidate.url().includes('localhost:1420'))
    ?? context.pages()[0];
  if (!page) throw new Error('No FILEX WebView page is available');

  const diagnostics = { pageErrors: [] as string[], consoleErrors: [] as string[], failedRequests: [] as string[] };
  page.on('pageerror', (error) => diagnostics.pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') diagnostics.consoleErrors.push(message.text());
  });
  page.on('requestfailed', (request) => {
    diagnostics.failedRequests.push(`${request.method()} ${request.url()} ${request.failure()?.errorText || ''}`);
  });

  const stages: string[] = [];
  const marker = `FILEX_LIVE_${Date.now()}`;
  const auditRoot = `/tmp/filex-live-audit-${Date.now()}`;
  let activeSessionId: string | null = null;

  async function waitForAny(selectors: string[], timeoutMs: number): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      for (const selector of selectors) {
        if (await page.locator(selector).first().isVisible().catch(() => false)) return selector;
      }
      await page.waitForTimeout(200);
    }
    throw new Error(`Timed out waiting for ${selectors.join(', ')}`);
  }

  async function capture(name: string): Promise<void> {
    await page.screenshot({ path: resolve('test-results', name), fullPage: false });
  }

  try {
    await page.locator('.workbench-shell').waitFor({ state: 'visible', timeout: 15_000 });
    stages.push('workbench-visible');
    const fileBrowser = page.locator('.file-browser-panel');
    if (!await fileBrowser.isVisible().catch(() => false)) {
      await page.locator(
        '.context-actions button[aria-label="文件"], .context-actions button[aria-label="Files"]',
      ).first().click();
      stages.push('file-browser-opened');
    }

    for (const selector of ['.password-dialog', '.trust-dialog']) {
      const staleDialog = page.locator(selector);
      if (await staleDialog.isVisible().catch(() => false)) {
        await staleDialog.locator('.dialog-footer .button').first().click();
        await staleDialog.waitFor({ state: 'hidden', timeout: 10_000 });
        stages.push('stale-dialog-dismissed');
      }
    }

    const quickConnect = page.locator(
      '.context-actions button[aria-label="快速连接"], .context-actions button[aria-label="Quick connect"]',
    ).first();
    await quickConnect.click();
    await page.locator('.quick-connect-dialog').waitFor({ state: 'visible', timeout: 10_000 });
    await page.locator('.quick-connect-dialog .field.full input').fill(host!);
    await page.locator('.quick-connect-dialog .port-field input').fill(String(port));
    await page.locator('.quick-connect-dialog .field:not(.full):not(.port-field) input').fill(username);
    await page.locator('.quick-connect-dialog button[type="submit"]').click();
    stages.push('quick-connect-submitted');

    const challenge = await waitForAny([
      '.trust-dialog',
      '.password-dialog',
      '.form-error[role="alert"]',
    ], 25_000);
    if (challenge === '.form-error[role="alert"]') {
      throw new Error('Connection request failed before host verification');
    }

    if (challenge === '.trust-dialog') {
      await page.locator('.trust-confirm input').check();
      await page.locator('.trust-dialog button.primary').click();
      stages.push('host-key-trusted');
    }

    const passwordDialog = await waitForAny([
      '.password-dialog',
      '.form-error[role="alert"]',
    ], 25_000);
    if (passwordDialog !== '.password-dialog') throw new Error('The password dialog did not appear');

    await page.locator('.password-dialog input[type="password"]').fill(password!);
    await page.locator('.password-dialog button[type="submit"]').click();
    await page.locator('.password-dialog').waitFor({ state: 'hidden', timeout: 30_000 });
    stages.push('password-submitted');

    await page.locator('.command-input:not([disabled])').waitFor({ state: 'visible', timeout: 30_000 });
    await page.waitForTimeout(1_500);
    stages.push('ssh-connected');
    await page.locator('.nav-mode').getByRole('button', { name: '最近', exact: true }).click();
    await expect(page.locator('.recent-row', { hasText: `${username}@${host}` }).first()).toBeVisible();
    await page.locator('.nav-mode').getByRole('button', { name: '连接', exact: true }).click();
    await expect(page.getByText('临时连接', { exact: true })).toBeVisible();
    await expect(page.locator('.connections-pane .connection-row', { hasText: `${username}@${host}` }).first()).toBeVisible();
    stages.push('quick-connection-visible-in-navigation');
    await capture('live-ssh-connected-1280x800.png');

    await page.locator('.command-input').fill(`printf '%s\\n' '${marker}'`);
    await page.locator('.command-input').press('Enter');
    await page.waitForTimeout(1_500);

    const searchButton = page.locator(
      '.terminal-pane-actions button[aria-label="搜索终端"], .terminal-pane-actions button[aria-label="Search terminal"]',
    ).first();
    await searchButton.click();
    await page.locator('.terminal-search input').fill(marker);
    await page.waitForTimeout(1_000);
    const searchPosition = (await page.locator('.terminal-search-position').textContent())?.trim() || '';
    if (!/\d+\s*\/\s*\d+/.test(searchPosition)) {
      throw new Error('Terminal search did not find the live marker');
    }
    stages.push('terminal-marker-search-pass');
    await capture('live-ssh-terminal-search-1280x800.png');

    const accessibleTerminal = page.locator('.xterm-accessibility-tree');
    await accessibleTerminal.waitFor({ state: 'attached', timeout: 10_000 });
    const accessibleTerminalText = await accessibleTerminal.textContent() || '';
    if (!accessibleTerminalText.includes(marker)) {
      throw new Error('Terminal output was not exposed in the accessibility tree');
    }
    stages.push('terminal-accessibility-pass');

    const remotePane = page.locator('.file-browser-pane[aria-label="远端目录"], .file-browser-pane[aria-label="Remote directory"]').first();
    await remotePane.waitFor({ state: 'visible', timeout: 10_000 });
    await page.waitForTimeout(1_000);
    if (await remotePane.locator('.inline-notice.error').count() > 0) {
      throw new Error('Remote directory failed to load over SFTP');
    }
    const remoteEntries = await remotePane.locator('.file-row').count();
    stages.push(remoteEntries > 0 ? 'sftp-listing-pass' : 'sftp-empty-directory');
    const fileBrowserLayout = await page.locator('.file-browser-panel').evaluate((element) => ({
      scrollWidth: element.scrollWidth,
      clientWidth: element.clientWidth,
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight,
    }));
    if (fileBrowserLayout.scrollWidth > fileBrowserLayout.clientWidth + 1
      || fileBrowserLayout.scrollHeight > fileBrowserLayout.clientHeight + 1) {
      throw new Error('File browser content escaped its fixed panel');
    }
    const fileTableBody = remotePane.locator('.file-table-body').first();
    if (await fileTableBody.count()) {
      const bodyLayout = await fileTableBody.evaluate((element) => ({
        scrollHeight: element.scrollHeight,
        clientHeight: element.clientHeight,
        overflowY: getComputedStyle(element).overflowY,
      }));
      if (bodyLayout.scrollHeight > bodyLayout.clientHeight + 1 && bodyLayout.overflowY === 'visible') {
        throw new Error('Long file listing has no internal vertical scroll');
      }
    }

    const monitorPanel = page.locator('.host-panel');
    await monitorPanel.waitFor({ state: 'visible', timeout: 10_000 });
    await page.waitForTimeout(3_000);
    const monitorStatus = (await monitorPanel.locator('.status-pill').first().textContent())?.trim() || '';
    if (await monitorPanel.locator('.inline-notice.error').count() > 0) {
      throw new Error('Monitoring probe reported an error');
    }
    const monitorLayout = await monitorPanel.evaluate((element) => ({
      scrollWidth: element.scrollWidth,
      clientWidth: element.clientWidth,
    }));
    if (monitorLayout.scrollWidth > monitorLayout.clientWidth + 1) {
      throw new Error('Host monitoring content overflows horizontally');
    }
    stages.push('monitor-sampled');
    await capture('live-ssh-connected-files-monitor-1280x800.png');

    const invoke = async <T>(command: string, args: Record<string, unknown> = {}) => {
      return page.evaluate(
        ({ commandName, commandArgs }) => (
          window as unknown as Window & {
            __TAURI_INTERNALS__: {
              invoke: (command: string, args: Record<string, unknown>) => Promise<unknown>;
            };
          }
        ).__TAURI_INTERNALS__.invoke(commandName, commandArgs),
        { commandName: command, commandArgs: args },
      ) as Promise<T>;
    };
    type Result<T> = { ok: true; data: T } | { ok: false; error: { code: string } };
    const ok = <T>(result: Result<T>, label: string): T => {
      if (!result.ok) throw new Error(`${label}: ${result.error.code}`);
      return result.data;
    };
    activeSessionId = await page.evaluate(() => {
      const root = document.querySelector('#app') as HTMLElement & {
        __vue_app__?: {
          config: { globalProperties: { $pinia?: { _s: Map<string, Record<string, unknown>> } } };
        };
      };
      const sessions = root.__vue_app__?.config.globalProperties.$pinia?._s.get('sessions');
      return sessions?.activeSessionId as string | undefined;
    }) ?? null;
    if (!activeSessionId) throw new Error('No active SSH session for file lifecycle checks');

    ok(await invoke<Result<void>>('create_remote_directory', {
      sessionId: activeSessionId,
      parentPath: '/tmp',
      name: auditRoot.split('/').pop(),
    }), 'create live audit root');
    ok(await invoke<Result<void>>('create_remote_file', {
      sessionId: activeSessionId,
      parentPath: auditRoot,
      name: 'external-edit.txt',
    }), 'create remote file');
    ok(await invoke<Result<void>>('create_remote_directory', {
      sessionId: activeSessionId,
      parentPath: auditRoot,
      name: 'nested',
    }), 'create nested remote directory');
    ok(await invoke<Result<void>>('create_remote_file', {
      sessionId: activeSessionId,
      parentPath: `${auditRoot}/nested`,
      name: 'child.txt',
    }), 'create nested remote file');
    const initialPreview = ok(await invoke<Result<{ revision: string }>>('preview_remote_text', {
      sessionId: activeSessionId,
      path: `${auditRoot}/external-edit.txt`,
    }), 'preview empty external edit file');
    ok(await invoke<Result<void>>('save_remote_text', {
      sessionId: activeSessionId,
      path: `${auditRoot}/external-edit.txt`,
      content: 'external-editor-v1\n',
      expectedRevision: initialPreview.revision,
    }), 'seed external edit file');
    const permissions = ok(await invoke<Result<{ updatedCount: number; skippedSymlinkCount: number }>>(
      'update_remote_permissions',
      {
        sessionId: activeSessionId,
        input: {
          path: auditRoot,
          mode: 0o700,
          recursive: true,
          scope: 'all',
        },
      },
    ), 'apply recursive permissions');
    if (permissions.updatedCount < 4) {
      throw new Error(`Recursive permission update covered only ${permissions.updatedCount} entries`);
    }
    stages.push('file-create-and-recursive-permissions-pass');

    const editor = await page.evaluate(async ({ sessionId, remotePath }) => {
      const root = document.querySelector('#app') as HTMLElement & {
        __vue_app__?: {
          config: { globalProperties: { $pinia?: { _s: Map<string, Record<string, unknown>> } } };
        };
      };
      const pinia = root.__vue_app__?.config.globalProperties.$pinia;
      const settings = pinia?._s.get('settings');
      const externalEditors = pinia?._s.get('external-editors');
      if (!settings || !externalEditors) throw new Error('External editor stores unavailable');
      Object.assign(settings.value as Record<string, unknown>, {
        textEditorPreference: 'external',
        externalEditorPath: 'C:\\Windows\\System32\\where.exe',
      });
      const opened = await (externalEditors.openRemote as (
        sessionId: string,
        remotePath: string,
        mode: string,
      ) => Promise<boolean>)(sessionId, remotePath, 'external');
      if (!opened) throw new Error('External editor session did not open');
      const managed = (externalEditors.sessions as Array<Record<string, unknown>>)
        .find((candidate) => candidate.remotePath === remotePath);
      if (!managed) throw new Error('External editor session descriptor unavailable');
      return managed as {
        id: string;
        localPath: string;
        remoteRevision: string;
      };
    }, {
      sessionId: activeSessionId,
      remotePath: `${auditRoot}/external-edit.txt`,
    });
    await writeFile(editor.localPath, 'external-editor-v2-autosync\n', 'utf8');
    await page.waitForFunction(({ id, previousRevision }) => {
      const root = document.querySelector('#app') as HTMLElement & {
        __vue_app__?: {
          config: { globalProperties: { $pinia?: { _s: Map<string, Record<string, unknown>> } } };
        };
      };
      const externalEditors = root.__vue_app__?.config.globalProperties.$pinia?._s.get('external-editors');
      const managed = (externalEditors?.sessions as Array<Record<string, unknown>> | undefined)
        ?.find((candidate) => candidate.id === id);
      return Boolean(managed && managed.lastSyncedAtMs && managed.remoteRevision !== previousRevision);
    }, { id: editor.id, previousRevision: editor.remoteRevision }, { timeout: 10_000 });
    const syncedPreview = ok(await invoke<Result<{ content: string; revision: string }>>('preview_remote_text', {
      sessionId: activeSessionId,
      path: `${auditRoot}/external-edit.txt`,
    }), 'preview external edit result');
    if (!syncedPreview.content.includes('external-editor-v2-autosync')) {
      throw new Error('External editor save was not uploaded to the remote file');
    }
    ok(await invoke<Result<void>>('save_remote_text', {
      sessionId: activeSessionId,
      path: `${auditRoot}/external-edit.txt`,
      content: 'remote-writer-v3\n',
      expectedRevision: syncedPreview.revision,
    }), 'simulate concurrent remote writer');
    await writeFile(editor.localPath, 'external-editor-v4-must-not-overwrite\n', 'utf8');
    await page.waitForFunction((id) => {
      const root = document.querySelector('#app') as HTMLElement & {
        __vue_app__?: {
          config: { globalProperties: { $pinia?: { _s: Map<string, Record<string, unknown>> } } };
        };
      };
      const externalEditors = root.__vue_app__?.config.globalProperties.$pinia?._s.get('external-editors');
      const managed = (externalEditors?.sessions as Array<Record<string, unknown>> | undefined)
        ?.find((candidate) => candidate.id === id);
      return managed?.state === 'conflict';
    }, editor.id, { timeout: 10_000 });
    const conflictPreview = ok(await invoke<Result<{ content: string }>>('preview_remote_text', {
      sessionId: activeSessionId,
      path: `${auditRoot}/external-edit.txt`,
    }), 'preview remote conflict result');
    if (!conflictPreview.content.includes('remote-writer-v3')
      || conflictPreview.content.includes('v4-must-not-overwrite')) {
      throw new Error('External editor conflict did not fail closed');
    }
    stages.push('external-editor-conflict-pass');
    await page.evaluate((id) => {
      const root = document.querySelector('#app') as HTMLElement & {
        __vue_app__?: {
          config: { globalProperties: { $pinia?: { _s: Map<string, Record<string, unknown>> } } };
        };
      };
      const externalEditors = root.__vue_app__?.config.globalProperties.$pinia?._s.get('external-editors');
      return (externalEditors?.close as ((id: string) => Promise<void>) | undefined)?.(id);
    }, editor.id);
    await expect.poll(async () => stat(editor.localPath).then(() => true, () => false)).toBe(false);
    stages.push('external-editor-autosync-pass');

    const deleted = ok(await invoke<Result<number>>('delete_remote_entry_recursive', {
      sessionId: activeSessionId,
      path: auditRoot,
    }), 'quick delete live audit tree');
    if (deleted < 4) throw new Error(`Quick delete removed only ${deleted} entries`);
    stages.push('quick-recursive-delete-pass');

    const rootStyle = await page.evaluate(() => ({
      fontSize: getComputedStyle(document.documentElement).fontSize,
      fontFamily: getComputedStyle(document.body).fontFamily,
      bodyScrollWidth: document.body.scrollWidth,
      bodyScrollHeight: document.body.scrollHeight,
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
    }));
    const fontLoaded = await page.evaluate(async () => {
      await document.fonts.ready;
      const regular = await document.fonts.load('400 14px "HarmonyOS Sans SC"');
      const bold = await document.fonts.load('700 14px "HarmonyOS Sans SC"');
      return regular.length > 0 && bold.length > 0;
    });
    if (!fontLoaded) throw new Error('Bundled HarmonyOS Sans SC fonts did not load');

    const result = {
      ok: true,
      stages,
      terminalSearchPosition: searchPosition,
      remoteEntryCount: remoteEntries,
      fileBrowserLayout,
      monitorLayout,
      monitorStatus,
      fontSize: rootStyle.fontSize,
      harmonyFontLoaded: fontLoaded,
      layout: {
        bodyScrollWidth: rootStyle.bodyScrollWidth,
        bodyScrollHeight: rootStyle.bodyScrollHeight,
        innerWidth: rootStyle.innerWidth,
        innerHeight: rootStyle.innerHeight,
      },
      diagnostics,
    };
    if (diagnostics.pageErrors.length > 0 || diagnostics.consoleErrors.length > 0 || diagnostics.failedRequests.length > 0) {
      throw new Error('Runtime diagnostics recorded errors during the live flow');
    }

    await testInfo.attach('live-ssh-result.json', {
      body: JSON.stringify(result, null, 2),
      contentType: 'application/json',
    });
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    if (activeSessionId) {
      await page.evaluate(({ sessionId, path }) => (
        window as unknown as Window & {
          __TAURI_INTERNALS__: {
            invoke: (command: string, args: Record<string, unknown>) => Promise<unknown>;
          };
        }
      ).__TAURI_INTERNALS__.invoke(
        'delete_remote_entry_recursive',
        { sessionId, path },
      ), { sessionId: activeSessionId, path: auditRoot }).catch(() => undefined);
    }
    await capture('live-ssh-failure-1280x800.png').catch(() => undefined);
    const failure = {
      ok: false,
      stages,
      error: error instanceof Error ? error.message : 'Unknown live SSH failure',
      diagnostics,
    };
    await testInfo.attach('live-ssh-failure.json', {
      body: JSON.stringify(failure, null, 2),
      contentType: 'application/json',
    });
    throw error;
  } finally {
    await browser.close().catch(() => undefined);
  }
});
