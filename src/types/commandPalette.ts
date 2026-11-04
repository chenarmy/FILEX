import type { KeyboardShortcuts } from '@/types/contracts';

export type CommandPaletteCommandId =
  | Exclude<keyof KeyboardShortcuts, 'commandPalette'>
  | 'showMonitor'
  | 'disconnectActiveSession';

export interface CommandPaletteCommand {
  id: CommandPaletteCommandId;
  label: string;
  keywords?: string;
  shortcut?: string;
  disabled?: boolean;
}
