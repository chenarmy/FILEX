import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OperationResult, UpdateStatus } from '@/types/contracts';

const mocks = vi.hoisted(() => ({
  cancelUpdateDownload: vi.fn(),
  checkForUpdates: vi.fn(),
  getUpdateStatus: vi.fn(),
  installUpdate: vi.fn(),
}));

vi.mock('@/api/domain/maintenanceApi', () => ({
  cancelUpdateDownload: mocks.cancelUpdateDownload,
  checkForUpdates: mocks.checkForUpdates,
  getUpdateStatus: mocks.getUpdateStatus,
  installUpdate: mocks.installUpdate,
}));

import { useUiStore } from '@/stores/ui';
import { useUpdatesStore } from '@/stores/updates';

const baseStatus: UpdateStatus = {
  currentVersion: '0.1.1',
  channel: 'stable',
  configured: true,
  availableVersion: null,
  releaseNotes: null,
  publishedAt: null,
};

function success<T>(data: T): OperationResult<T> {
  return { ok: true, data, requestId: 'test-request' };
}

function available(version: string): UpdateStatus {
  return {
    ...baseStatus,
    availableVersion: version,
    releaseNotes: '### Added\n\n- Automatic update checks.',
    publishedAt: '2026-11-11T00:00:00Z',
  };
}

describe('update store', () => {
  beforeEach(() => {
    localStorage.clear();
    setActivePinia(createPinia());
    vi.clearAllMocks();
    mocks.getUpdateStatus.mockResolvedValue(success(baseStatus));
    mocks.cancelUpdateDownload.mockResolvedValue(success(undefined));
  });

  it('checks in the background, opens the first prompt and persists the successful check time', async () => {
    mocks.checkForUpdates.mockResolvedValue(success(available('0.1.2')));
    const store = useUpdatesStore();

    await expect(store.check(false, true)).resolves.toBe(true);
    expect(store.phase).toBe('available');
    expect(store.dialogOpen).toBe(true);
    expect(store.hasUpdateAvailable).toBe(true);
    expect(store.lastCheckAt).not.toBeNull();
    expect(localStorage.getItem('filex.update-preferences.v1')).toContain('"lastCheckAt"');
  });

  it('updates the persistent indicator without opening a dialog for later periodic discoveries', async () => {
    mocks.checkForUpdates.mockResolvedValue(success(available('0.1.2')));
    const store = useUpdatesStore();

    await expect(store.check(false, false)).resolves.toBe(true);
    expect(store.dialogOpen).toBe(false);
    expect(store.hasUpdateAvailable).toBe(true);
    store.openDialog();
    expect(store.dialogOpen).toBe(true);
  });

  it('hides a skipped version from automatic discovery but keeps manual checks available', async () => {
    mocks.checkForUpdates.mockResolvedValue(success(available('0.1.2')));
    const store = useUpdatesStore();
    await store.check(false, true);

    store.skipAvailableVersion();
    expect(store.dialogOpen).toBe(false);
    expect(store.hasUpdateAvailable).toBe(false);
    expect(store.skippedVersion).toBe('0.1.2');

    await expect(store.check(false, true)).resolves.toBe(true);
    expect(store.dialogOpen).toBe(false);

    await expect(store.check(true, true)).resolves.toBe(true);
    expect(store.dialogOpen).toBe(true);
  });

  it('clears an old skip when a newer version is published', async () => {
    mocks.checkForUpdates
      .mockResolvedValueOnce(success(available('0.1.2')))
      .mockResolvedValueOnce(success(available('0.1.3')));
    const store = useUpdatesStore();
    await store.check(false, true);
    store.skipAvailableVersion();

    await store.check(false, true);
    expect(store.availableVersion).toBe('0.1.3');
    expect(store.skippedVersion).toBeNull();
    expect(store.dialogOpen).toBe(true);
  });

  it('keeps background failures quiet and does not advance the last success time', async () => {
    const store = useUpdatesStore();
    const ui = useUiStore();
    const notify = vi.spyOn(ui, 'notify');
    mocks.checkForUpdates.mockResolvedValue({
      ok: false,
      requestId: 'failed-request',
      error: {
        code: 'UPDATE_CHECK_FAILED',
        messageKey: 'errors.updateCheckFailed',
        retryable: true,
        remoteState: 'not_applicable',
      },
    });

    await expect(store.check(false, true)).resolves.toBe(false);
    expect(store.lastCheckAt).toBeNull();
    expect(store.errorKey).toBe('errors.updateCheckFailed');
    expect(notify).not.toHaveBeenCalled();
  });

  it('installs only an available reviewed version and tracks progress', async () => {
    mocks.checkForUpdates.mockResolvedValue(success(available('0.1.2')));
    mocks.installUpdate.mockImplementation((version, onEvent) => {
      expect(version).toBe('0.1.2');
      onEvent?.({ event: 'progress', data: { downloadedBytes: 50, contentLength: 100 } });
      onEvent?.({ event: 'installing' });
      return Promise.resolve(success(undefined));
    });
    const store = useUpdatesStore();
    await store.check(false, true);

    await expect(store.install()).resolves.toBe(true);
    expect(store.phase).toBe('installing');
    expect(store.progressPercent).toBe(50);
  });

  it('returns to the reviewed version after an in-flight download is cancelled', async () => {
    mocks.checkForUpdates.mockResolvedValue(success(available('0.1.2')));
    let finishInstall!: (value: OperationResult<void>) => void;
    mocks.installUpdate.mockImplementation(() => new Promise((resolve) => {
      finishInstall = resolve;
    }));
    const store = useUpdatesStore();
    await store.check(false, true);

    const installation = store.install();
    expect(store.phase).toBe('downloading');
    await store.cancelDownload();
    expect(mocks.cancelUpdateDownload).toHaveBeenCalledOnce();

    finishInstall({
      ok: false,
      requestId: 'cancelled-request',
      error: {
        code: 'UPDATE_CANCELLED',
        messageKey: 'errors.updateCancelled',
        retryable: true,
        remoteState: 'unchanged',
      },
    });
    await expect(installation).resolves.toBe(false);
    expect(store.phase).toBe('available');
    expect(store.errorKey).toBeNull();
  });
});
