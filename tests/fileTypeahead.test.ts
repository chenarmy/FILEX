import { describe, expect, it } from 'vitest';
import {
  createEmptyTypeaheadState,
  isFileCopyShortcut,
  isFilePasteShortcut,
  isTypeaheadTriggerKey,
  resolveArrowSelectionIndex,
  resolveTypeaheadMatch,
  TYPEAHEAD_RESET_MS,
} from '@/domain/fileTypeahead';

const sampleEntries = [
  { name: 'aa-config', path: '/srv/aa-config' },
  { name: 'assets', path: '/srv/assets' },
  { name: 'build', path: '/srv/build' },
  { name: 'docs', path: '/srv/docs' },
  { name: '.env', path: '/srv/.env' },
  { name: 'app.ts', path: '/srv/app.ts' },
  { name: 'README.md', path: '/srv/README.md' },
  { name: 'release.env', path: '/srv/release.env' },
];

describe('folder typeahead matching and keyboard predicates', () => {
  it('jumps to folders and files case-insensitively and refines rapid multi-letter queries', () => {
    let state = createEmptyTypeaheadState();
    const first = resolveTypeaheadMatch(sampleEntries, null, 'R', state, 1_000);
    expect(first.matched).toBe(true);
    expect(first.entry?.name).toBe('README.md');
    expect(first.index).toBe(6);

    state = first.nextState;
    const second = resolveTypeaheadMatch(sampleEntries, first.entry!.path, 'e', state, 1_200);
    expect(second.matched).toBe(true);
    expect(second.entry?.name).toBe('README.md');

    state = second.nextState;
    const third = resolveTypeaheadMatch(sampleEntries, second.entry!.path, 'l', state, 1_400);
    expect(third.matched).toBe(true);
    expect(third.entry?.name).toBe('release.env');
    expect(third.index).toBe(7);
  });

  it('cycles through entries starting with the same letter on repeated presses and wraps around', () => {
    let state = createEmptyTypeaheadState();
    const r1 = resolveTypeaheadMatch(sampleEntries, null, 'a', state, 1_000);
    expect(r1.entry?.name).toBe('aa-config');
    state = r1.nextState;

    const r2 = resolveTypeaheadMatch(sampleEntries, r1.entry!.path, 'a', state, 1_200);
    expect(r2.entry?.name).toBe('assets');
    state = r2.nextState;

    const r3 = resolveTypeaheadMatch(sampleEntries, r2.entry!.path, 'a', state, 1_400);
    expect(r3.entry?.name).toBe('app.ts');
    state = r3.nextState;

    const r4 = resolveTypeaheadMatch(sampleEntries, r3.entry!.path, 'a', state, 1_600);
    expect(r4.entry?.name).toBe('aa-config');
  });

  it('resets after timeout and does not trap subsequent keys on unmatched letters', () => {
    const first = resolveTypeaheadMatch(sampleEntries, null, 'b', createEmptyTypeaheadState(), 1_000);
    expect(first.entry?.name).toBe('build');

    const miss = resolveTypeaheadMatch(sampleEntries, first.entry!.path, 'z', first.nextState, 1_200);
    expect(miss.matched).toBe(false);
    expect(miss.entry).toBeNull();
    expect(miss.nextState.query).toBe('');

    const recover = resolveTypeaheadMatch(sampleEntries, first.entry!.path, 'd', miss.nextState, 1_300);
    expect(recover.matched).toBe(true);
    expect(recover.entry?.name).toBe('docs');

    const afterTimeout = resolveTypeaheadMatch(
      sampleEntries,
      recover.entry!.path,
      '.',
      recover.nextState,
      1_300 + TYPEAHEAD_RESET_MS + 50,
    );
    expect(afterTimeout.matched).toBe(true);
    expect(afterTimeout.entry?.name).toBe('.env');
  });

  it('filters out modified, non-printable, whitespace, and IME composing keys', () => {
    expect(isTypeaheadTriggerKey({ key: 'a', ctrlKey: false, metaKey: false, altKey: false, isComposing: false })).toBe(true);
    expect(isTypeaheadTriggerKey({ key: '.', ctrlKey: false, metaKey: false, altKey: false, isComposing: false })).toBe(true);
    expect(isTypeaheadTriggerKey({ key: 'c', ctrlKey: true, metaKey: false, altKey: false, isComposing: false })).toBe(false);
    expect(isTypeaheadTriggerKey({ key: 'v', ctrlKey: false, metaKey: true, altKey: false, isComposing: false })).toBe(false);
    expect(isTypeaheadTriggerKey({ key: ' ', ctrlKey: false, metaKey: false, altKey: false, isComposing: false })).toBe(false);
    expect(isTypeaheadTriggerKey({ key: 'Enter', ctrlKey: false, metaKey: false, altKey: false, isComposing: false })).toBe(false);
    expect(isTypeaheadTriggerKey({ key: 'a', ctrlKey: false, metaKey: false, altKey: false, isComposing: true })).toBe(false);
    expect(isTypeaheadTriggerKey({ key: 'Process', ctrlKey: false, metaKey: false, altKey: false, isComposing: false })).toBe(false);
  });

  it('detects platform copy/paste shortcuts and computes arrow navigation indices', () => {
    expect(isFileCopyShortcut({ key: 'c', code: 'KeyC', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false }, false)).toBe(true);
    expect(isFileCopyShortcut({ key: 'c', code: 'KeyC', ctrlKey: true, metaKey: false, altKey: false, shiftKey: true }, false)).toBe(false);
    expect(isFilePasteShortcut({ key: 'v', code: 'KeyV', ctrlKey: false, metaKey: true, altKey: false, shiftKey: false }, true)).toBe(true);
    expect(isFilePasteShortcut({ key: 'v', code: 'KeyV', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false }, true)).toBe(false);

    expect(resolveArrowSelectionIndex(5, -1, 'ArrowDown')).toBe(0);
    expect(resolveArrowSelectionIndex(5, -1, 'ArrowUp')).toBe(4);
    expect(resolveArrowSelectionIndex(5, 2, 'ArrowDown')).toBe(3);
    expect(resolveArrowSelectionIndex(5, 4, 'ArrowDown')).toBe(4);
    expect(resolveArrowSelectionIndex(5, 2, 'ArrowUp')).toBe(1);
    expect(resolveArrowSelectionIndex(5, 0, 'ArrowUp')).toBe(0);
    expect(resolveArrowSelectionIndex(5, 2, 'Home')).toBe(0);
    expect(resolveArrowSelectionIndex(5, 2, 'End')).toBe(4);
    expect(resolveArrowSelectionIndex(0, -1, 'ArrowDown')).toBeNull();
  });
});
