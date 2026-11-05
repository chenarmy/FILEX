export interface VirtualWindow {
  startIndex: number;
  endIndex: number;
  startOffset: number;
  totalHeight: number;
}

/**
 * Computes the fixed-row-height render window for a virtualized list.
 * Rows outside [startIndex, endIndex] stay unrendered; the caller pads the
 * remaining space with `startOffset` and `totalHeight`.
 */
export function computeVirtualWindow(
  scrollTop: number,
  viewportHeight: number,
  itemCount: number,
  rowHeight: number,
  overscan = 8,
): VirtualWindow {
  if (itemCount <= 0 || rowHeight <= 0) {
    return { startIndex: 0, endIndex: 0, startOffset: 0, totalHeight: 0 };
  }
  const firstVisible = Math.min(itemCount - 1, Math.floor(scrollTop / rowHeight));
  const visibleCount = Math.ceil(viewportHeight / rowHeight) + 1;
  const startIndex = Math.max(0, firstVisible - overscan);
  const endIndex = Math.min(itemCount, firstVisible + visibleCount + overscan);
  return {
    startIndex,
    endIndex,
    startOffset: startIndex * rowHeight,
    totalHeight: itemCount * rowHeight,
  };
}
