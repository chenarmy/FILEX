import type { TerminalEncoding } from '@/types/contracts';

export interface TextEncodingOption {
  value: TerminalEncoding;
  label: string;
}

export const SUPPORTED_TEXT_ENCODINGS: readonly TextEncodingOption[] = [
  { value: 'utf-8', label: 'UTF-8' },
  { value: 'utf-16le', label: 'UTF-16 LE' },
  { value: 'utf-16be', label: 'UTF-16 BE' },
  { value: 'gbk', label: 'GBK' },
  { value: 'gb18030', label: 'GB18030' },
  { value: 'big5', label: 'Big5' },
  { value: 'shift_jis', label: 'Shift_JIS' },
  { value: 'euc-jp', label: 'EUC-JP' },
  { value: 'euc-kr', label: 'EUC-KR' },
  { value: 'windows-1252', label: 'Windows-1252' },
] as const;

export const TEXT_ENCODING_LABELS: Record<TerminalEncoding, string> = Object.fromEntries(
  SUPPORTED_TEXT_ENCODINGS.map((item) => [item.value, item.label]),
) as Record<TerminalEncoding, string>;

export function isSupportedTextEncoding(value: unknown): value is TerminalEncoding {
  return typeof value === 'string'
    && SUPPORTED_TEXT_ENCODINGS.some((item) => item.value === value);
}

export function normalizeTextEncoding(
  value: unknown,
  fallback: TerminalEncoding = 'utf-8',
): TerminalEncoding {
  return isSupportedTextEncoding(value) ? value : fallback;
}
