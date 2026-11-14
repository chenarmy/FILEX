import type { IDisposable, ITerminalOptions, Terminal } from '@xterm/xterm';

interface SelectionPalette {
  selectionBackgroundOpaque: { css: string };
  selectionInactiveBackgroundOpaque: { css: string };
}

interface ThemeServiceView {
  _core?: {
    _themeService?: { colors?: SelectionPalette };
  };
}

interface InternalLine {
  _data: Uint32Array;
}

interface LineView {
  _line?: InternalLine;
}

const CELL_WORDS = 3;
const COLOR_MASK = 0x03ffffff;
const RGB_WHITE = 0x03ffffff;
const INVERSE = 0x04000000;
const COLOR_MODE_MASK = 0x03000000;

export function getTerminalCompatibilityOptions(): Partial<ITerminalOptions> {
  return {
    letterSpacing: 0,
    lineHeight: 1.05,
    minimumContrastRatio: 4.5,
    macOptionClickForcesSelection: true,
    rescaleOverlappingGlyphs: false,
  };
}

/**
 * The DOM selection layer (`.xterm-selection div`) already paints the row
 * selection background. Repainting an opaque selection background on every
 * selected `.xterm-decoration-top` span can cover adjacent glyphs. This
 * adapter keeps xterm's foreground/contrast decisions while letting the
 * selection layer own the background once per row.
 */
export function registerTerminalSelectionRenderer(terminal: Terminal): IDisposable {
  const render = (): void => {
    const selection = terminal.getSelectionPosition();
    if (!selection) return;
    const colors = (terminal as unknown as ThemeServiceView)._core?._themeService?.colors;
    const rows = terminal.element?.querySelector('.xterm-rows');
    if (!colors || !rows || terminal.cols <= 0) return;
    const cellWidth = rows.getBoundingClientRect().width / terminal.cols;
    if (cellWidth <= 0) return;
    const probe = rows.ownerDocument.createElement('span');
    const backgrounds = [colors.selectionBackgroundOpaque, colors.selectionInactiveBackgroundOpaque].map(({ css }) => {
      probe.style.backgroundColor = css;
      return probe.style.backgroundColor;
    });
    Array.from(rows.children).forEach((row, index) => {
      const bufferRow = terminal.buffer.active.viewportY + index;
      if (bufferRow < selection.start.y || bufferRow > selection.end.y) return;
      const firstColumn = bufferRow === selection.start.y ? selection.start.x : 0;
      const lastColumn = bufferRow === selection.end.y ? selection.end.x : terminal.cols;
      const rowLeft = row.getBoundingClientRect().left;
      row.querySelectorAll<HTMLElement>(':scope > .xterm-decoration-top').forEach((span) => {
        const column = Math.round((span.getBoundingClientRect().left - rowLeft) / cellWidth);
        if (
          column >= firstColumn
          && column < lastColumn
          && !span.classList.contains('xterm-cursor')
          && backgrounds.includes(span.style.backgroundColor)
        ) {
          span.style.backgroundColor = 'transparent';
        }
      });
    });
  };

  const subscription = terminal.onRender(render);
  const view = terminal.element?.ownerDocument.defaultView;
  let refreshFrame: number | undefined;
  const refresh = (): void => {
    if (!view || refreshFrame !== undefined) return;
    refreshFrame = view.requestAnimationFrame(() => {
      refreshFrame = undefined;
      terminal.refresh(0, Math.max(0, terminal.rows - 1));
    });
  };

  const selectionSubscription = terminal.onSelectionChange(refresh);
  let observedSelection = JSON.stringify(terminal.getSelectionPosition());
  const observer = view
    ? new view.MutationObserver(() => {
      render();
      const selection = JSON.stringify(terminal.getSelectionPosition());
      if (selection !== observedSelection) {
        observedSelection = selection;
        refresh();
      }
    })
    : undefined;

  const rows = terminal.element?.querySelector('.xterm-rows');
  if (rows && observer) observer.observe(rows, { childList: true, subtree: true });
  terminal.textarea?.addEventListener('focus', refresh);
  terminal.textarea?.addEventListener('blur', refresh);

  return {
    dispose(): void {
      subscription.dispose();
      selectionSubscription.dispose();
      observer?.disconnect();
      if (refreshFrame !== undefined) view?.cancelAnimationFrame(refreshFrame);
      terminal.textarea?.removeEventListener('focus', refresh);
      terminal.textarea?.removeEventListener('blur', refresh);
    },
  };
}

/**
 * Adapts literal RGB white (`#ffffff`) on the default background to the
 * theme's default foreground so light themes never render white-on-white text.
 */
export function registerTerminalForegroundAdapter(terminal: Terminal): IDisposable {
  let pending = false;
  let disposed = false;

  const adaptViewport = (): void => {
    pending = false;
    if (disposed) return;
    const buffer = terminal.buffer.active;
    let changed = false;
    for (let row = buffer.viewportY; row < Math.min(buffer.length, buffer.viewportY + terminal.rows); row += 1) {
      const line = buffer.getLine(row);
      const data = (line as LineView | undefined)?._line?._data;
      if (!line || !(data instanceof Uint32Array) || data.length !== line.length * CELL_WORDS) continue;

      for (let column = 0; column < line.length; column += 1) {
        const index = column * CELL_WORDS;
        const foreground = data[index + 1]!;
        const background = data[index + 2]!;
        if ((foreground & COLOR_MASK) === RGB_WHITE && !(foreground & INVERSE) && !(background & COLOR_MODE_MASK)) {
          data[index + 1] = foreground & ~COLOR_MASK;
          changed = true;
        }
      }
    }
    if (changed) terminal.refresh(0, Math.max(0, terminal.rows - 1));
  };

  const scheduleAdaptViewport = (): void => {
    if (pending || disposed) return;
    pending = true;
    queueMicrotask(() => {
      if (pending) adaptViewport();
    });
  };

  const subscriptions = [
    terminal.onWriteParsed(adaptViewport),
    terminal.onScroll(scheduleAdaptViewport),
    terminal.onResize(scheduleAdaptViewport),
    terminal.buffer.onBufferChange(scheduleAdaptViewport),
  ];
  adaptViewport();

  return {
    dispose(): void {
      disposed = true;
      pending = false;
      subscriptions.forEach((subscription) => subscription.dispose());
    },
  };
}

/**
 * Refreshes the terminal surface when switching between normal and alternate
 * screen buffers (e.g. `top`, `htop`, `vim`, `less`).
 */
export function registerTerminalBufferRenderRecovery(terminal: Terminal): IDisposable {
  let renderedBufferType = terminal.buffer.active.type;
  return terminal.onWriteParsed(() => {
    const nextBufferType = terminal.buffer.active.type;
    if (nextBufferType === renderedBufferType) return;
    renderedBufferType = nextBufferType;
    terminal.clearTextureAtlas();
    terminal.refresh(0, Math.max(terminal.rows - 1, 0));
  });
}

/**
 * Forces xterm's DOM `WidthCache` and `CharSizeService` to re-measure glyphs
 * after web/system fonts finish loading or DPI changes.
 */
export function pulseTerminalFontMetrics(terminal: Terminal, fontFamily: string): void {
  for (const candidate of [`${fontFamily}, ${fontFamily}`, fontFamily]) {
    terminal.options.fontFamily = candidate;
  }
  terminal.clearTextureAtlas();
  terminal.refresh(0, Math.max(terminal.rows - 1, 0));
}
