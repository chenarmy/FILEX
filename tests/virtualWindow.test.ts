import { describe, expect, it } from 'vitest';
import { computeVirtualWindow } from '@/utils/virtualWindow';

describe('computeVirtualWindow', () => {
  it('renders the visible window plus overscan', () => {
    const result = computeVirtualWindow(1020, 300, 10_000, 34, 8);
    expect(result.startIndex).toBe(22);
    expect(result.endIndex).toBeGreaterThanOrEqual(33);
    expect(result.startOffset).toBe(22 * 34);
    expect(result.totalHeight).toBe(10_000 * 34);
  });

  it('clamps to the item bounds', () => {
    const result = computeVirtualWindow(10_000, 300, 10, 34, 8);
    expect(result.startIndex).toBeLessThanOrEqual(10);
    expect(result.endIndex).toBe(10);
  });

  it('handles empty and degenerate inputs', () => {
    expect(computeVirtualWindow(0, 300, 0, 34)).toEqual({
      startIndex: 0,
      endIndex: 0,
      startOffset: 0,
      totalHeight: 0,
    });
    expect(computeVirtualWindow(0, 300, 100, 0).totalHeight).toBe(0);
  });
});
