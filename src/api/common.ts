import type { AppError, OperationResult } from '@/types/contracts';

export function createRequestId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `filex-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function isTauriRuntime(): boolean {
  return '__TAURI_INTERNALS__' in window;
}

export function success<T>(data: T, requestId = createRequestId()): OperationResult<T> {
  return { ok: true, data, requestId };
}

export function failure<T>(error: AppError, requestId = createRequestId()): OperationResult<T> {
  return { ok: false, error, requestId };
}

export function normalizeUnknownError(error: unknown, fallbackCode: string): AppError {
  if (isAppError(error)) return error;

  return {
    code: fallbackCode,
    messageKey: 'errors.unexpected',
    retryable: true,
    remoteState: 'unknown',
    details: {
      kind: error instanceof Error ? error.name : typeof error,
    },
  };
}

function isAppError(value: unknown): value is AppError {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<AppError>;
  return typeof candidate.code === 'string' && typeof candidate.messageKey === 'string';
}
