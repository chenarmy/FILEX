import { describe, expect, it } from 'vitest';
import { resolveCdCommand } from '@/domain/terminalCwd';

describe('terminal cwd inference', () => {
  it('resolves simple absolute and relative cd commands', () => {
    expect(resolveCdCommand('cd /var/log', '/home/dev')).toBe('/var/log');
    expect(resolveCdCommand('cd ../logs', '/srv/app')).toBe('/srv/logs');
    expect(resolveCdCommand('cd "release files"', '/srv')).toBe('/srv/release files');
  });

  it('rejects commands whose shell semantics cannot be inferred safely', () => {
    expect(resolveCdCommand('cd', '/srv')).toBeNull();
    expect(resolveCdCommand('cd ~', '/srv')).toBeNull();
    expect(resolveCdCommand('cd /tmp && rm -rf x', '/srv')).toBeNull();
    expect(resolveCdCommand('pushd /tmp', '/srv')).toBeNull();
  });
});
