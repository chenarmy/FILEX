import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useEditorStore } from '@/stores/editor';
import { useSessionsStore } from '@/stores/sessions';

const localFilesMocks = vi.hoisted(() => ({
  previewLocalText: vi.fn(),
  saveLocalText: vi.fn(),
}));

const sftpMocks = vi.hoisted(() => ({
  previewRemoteText: vi.fn(),
  saveRemoteText: vi.fn(),
}));

vi.mock('@/api/domain/localFilesApi', () => localFilesMocks);
vi.mock('@/api/domain/sftpApi', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/api/domain/sftpApi');
  return {
    ...actual,
    previewRemoteText: sftpMocks.previewRemoteText,
    saveRemoteText: sftpMocks.saveRemoteText,
  };
});

describe('editor encoding matrix', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  it('reloads unmodified local tabs in the chosen encoding and saves with that encoding', async () => {
    localFilesMocks.previewLocalText
      .mockResolvedValueOnce({
        ok: true,
        data: { path: '/tmp/app.conf', content: 'abc', bytes: 3, revision: 'rev-1', truncated: false },
      })
      .mockResolvedValueOnce({
        ok: true,
        data: { path: '/tmp/app.conf', content: '中文配置', bytes: 12, revision: 'rev-2', truncated: false },
      });
    localFilesMocks.saveLocalText.mockResolvedValueOnce({
      ok: true,
      data: { path: '/tmp/app.conf', bytes: 12, revision: 'rev-3' },
    });

    const store = useEditorStore();
    await store.open('local', '/tmp/app.conf');
    expect(localFilesMocks.previewLocalText).toHaveBeenCalledWith('/tmp/app.conf', 'utf-8');

    const tab = store.activeTab!;
    await store.setEncoding(tab.id, 'gbk');
    expect(localFilesMocks.previewLocalText).toHaveBeenLastCalledWith('/tmp/app.conf', 'gbk');
    expect(store.activeTab?.content).toBe('中文配置');

    store.updateContent(tab.id, '中文新配置');
    const saved = await store.save(tab.id);
    expect(saved).toBe(true);
    expect(localFilesMocks.saveLocalText).toHaveBeenCalledWith('/tmp/app.conf', '中文新配置', 'rev-2', 'gbk');
  });

  it('passes selected encoding through remote preview and save calls', async () => {
    const sessions = useSessionsStore();
    sessions.activeSessionId = 'sess-1';
    sftpMocks.previewRemoteText
      .mockResolvedValueOnce({
        ok: true,
        data: { path: '/etc/legacy.txt', content: 'old', bytes: 3, revision: 'r1', truncated: false },
      })
      .mockResolvedValueOnce({
        ok: true,
        data: { path: '/etc/legacy.txt', content: '設定', bytes: 6, revision: 'r2', truncated: false },
      });
    sftpMocks.saveRemoteText.mockResolvedValueOnce({
      ok: false,
      error: {
        code: 'ENCODING_LOSSY_INPUT',
        messageKey: 'errors.encodingLossyInput',
        retryable: false,
        remoteState: 'unchanged',
        field: 'encoding',
      },
    });

    const store = useEditorStore();
    await store.open('remote', '/etc/legacy.txt');
    const tab = store.activeTab!;
    await store.setEncoding(tab.id, 'shift_jis');
    expect(sftpMocks.previewRemoteText).toHaveBeenLastCalledWith('sess-1', '/etc/legacy.txt', 'shift_jis');

    store.updateContent(tab.id, '😀');
    const saved = await store.save(tab.id);
    expect(saved).toBe(false);
    expect(store.activeTab?.error?.code).toBe('ENCODING_LOSSY_INPUT');
  });
});
