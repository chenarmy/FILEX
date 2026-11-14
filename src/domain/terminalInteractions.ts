export const DEFAULT_TERMINAL_FONT_FAMILY = "'JetBrains Mono', 'Cascadia Mono', Consolas, 'Courier New', monospace";
export const ALT_DOUBLE_TAP_WINDOW_MS = 420;

export type AltTapState = {
  lastTapAt: number | null;
  openHistory: boolean;
};

export function registerAltTap(
  lastTapAt: number | null,
  now: number,
  event: Pick<KeyboardEvent, 'key' | 'repeat' | 'ctrlKey' | 'metaKey' | 'shiftKey'>,
): AltTapState {
  const plainAlt = event.key === 'Alt'
    && !event.repeat
    && !event.ctrlKey
    && !event.metaKey
    && !event.shiftKey;
  if (!plainAlt) return { lastTapAt: null, openHistory: false };
  if (lastTapAt !== null && now - lastTapAt <= ALT_DOUBLE_TAP_WINDOW_MS) {
    return { lastTapAt: null, openHistory: true };
  }
  return { lastTapAt: now, openHistory: false };
}

type TextWidthMeasure = (text: string, font: string) => number;

function canvasTextWidth(text: string, font: string): number {
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  if (!context) return Number.NaN;
  context.font = font;
  return context.measureText(text).width;
}

export function isEffectiveMonospaceFont(
  fontFamily: string,
  fontSize: number,
  measureText: TextWidthMeasure = canvasTextWidth,
): boolean {
  const font = `${fontSize}px ${fontFamily}`;
  const widths = ['i', 'W', '0', 'M'].map((character) => measureText(character.repeat(16), font) / 16);
  if (widths.some((width) => !Number.isFinite(width) || width <= 0)) return true;
  return Math.max(...widths) - Math.min(...widths) <= 0.05;
}

export function resolveTerminalFontFamily(
  requested: string,
  fontSize: number,
  measureText?: TextWidthMeasure,
): { fontFamily: string; fellBack: boolean } {
  const normalized = requested.trim() || DEFAULT_TERMINAL_FONT_FAMILY;
  if (isEffectiveMonospaceFont(normalized, fontSize, measureText)) {
    return { fontFamily: normalized, fellBack: false };
  }
  return { fontFamily: DEFAULT_TERMINAL_FONT_FAMILY, fellBack: true };
}

export function clampTerminalMenuPosition(
  pointer: { x: number; y: number },
  surface: { left: number; top: number; width: number; height: number },
  menu: { width: number; height: number },
): { x: number; y: number } {
  const padding = 6;
  return {
    x: Math.max(padding, Math.min(pointer.x - surface.left, surface.width - menu.width - padding)),
    y: Math.max(padding, Math.min(pointer.y - surface.top, surface.height - menu.height - padding)),
  };
}
