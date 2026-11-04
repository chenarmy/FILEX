import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { failure, isTauriRuntime, normalizeUnknownError, success } from '@/api/common';
import type {
  HostTrustRecord,
  ImportKnownHostsInput,
  ImportKnownHostsResult,
  KnownHostsImportPreview,
  OperationResult,
  RecordHostTrustInput,
} from '@/types/contracts';

export async function listHostTrustRecords(): Promise<OperationResult<HostTrustRecord[]>> {
  if (!isTauriRuntime()) return success([]);
  try {
    return await invoke<OperationResult<HostTrustRecord[]>>('list_host_trust_records');
  } catch (error: unknown) {
    return failure(normalizeUnknownError(error, 'TRUST_LIST_FAILED'));
  }
}

export async function recordHostTrust(input: RecordHostTrustInput): Promise<OperationResult<HostTrustRecord>> {
  if (!isTauriRuntime()) {
    return failure({
      code: 'TRUST_DESKTOP_ONLY',
      messageKey: 'errors.sshDesktopOnly',
      retryable: false,
      remoteState: 'not_applicable',
    });
  }
  try {
    return await invoke<OperationResult<HostTrustRecord>>('record_host_trust', { input });
  } catch (error: unknown) {
    return failure(normalizeUnknownError(error, 'TRUST_RECORD_FAILED'));
  }
}

export async function selectKnownHostsFile(title: string): Promise<OperationResult<string | null>> {
  if (!isTauriRuntime()) {
    return failure({
      code: 'TRUST_IMPORT_DESKTOP_ONLY',
      messageKey: 'errors.desktopRuntimeRequired',
      retryable: false,
      remoteState: 'not_applicable',
    });
  }
  try {
    // OpenSSH's default file is usually named "known_hosts" without an extension.
    const selectedPath = await open({ title, multiple: false, directory: false });
    return success(typeof selectedPath === 'string' ? selectedPath : null);
  } catch {
    return failure({
      code: 'TRUST_IMPORT_PICKER_FAILED',
      messageKey: 'errors.trustImportPickerFailed',
      retryable: true,
      remoteState: 'not_applicable',
    });
  }
}

export async function previewKnownHostsImport(filePath: string): Promise<OperationResult<KnownHostsImportPreview>> {
  if (!isTauriRuntime()) {
    return failure({
      code: 'TRUST_IMPORT_DESKTOP_ONLY',
      messageKey: 'errors.desktopRuntimeRequired',
      retryable: false,
      remoteState: 'not_applicable',
    });
  }
  try {
    return await invoke<OperationResult<KnownHostsImportPreview>>('preview_known_hosts_import', { filePath });
  } catch (error: unknown) {
    return failure(normalizeUnknownError(error, 'TRUST_IMPORT_PREVIEW_FAILED'));
  }
}

export async function importKnownHosts(input: ImportKnownHostsInput): Promise<OperationResult<ImportKnownHostsResult>> {
  if (!isTauriRuntime()) {
    return failure({
      code: 'TRUST_IMPORT_DESKTOP_ONLY',
      messageKey: 'errors.desktopRuntimeRequired',
      retryable: false,
      remoteState: 'not_applicable',
    });
  }
  try {
    return await invoke<OperationResult<ImportKnownHostsResult>>('import_known_hosts', { input });
  } catch (error: unknown) {
    return failure(normalizeUnknownError(error, 'TRUST_IMPORT_FAILED'));
  }
}
