import { describe, expect, it } from 'vitest';
import {
  createTerminalCwdTracker,
  extractCommandFromPromptLine,
  resolveCdCommand,
} from '@/domain/terminalCwd';

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

  it('extracts cd commands from shell prompt lines', () => {
    expect(extractCommandFromPromptLine('[porlog@portal-log software]$ cd ../app/')).toBe('cd ../app/');
    expect(extractCommandFromPromptLine('root@host:/srv# cd /var/log  ')).toBe('cd /var/log');
    expect(extractCommandFromPromptLine('[porlog@portal-log software]$ ls -la')).toBeNull();
  });

  it('tracks untainted cd commands and recovers Tab-completed paths from the active prompt line', () => {
    const tracker = createTerminalCwdTracker();

    expect(tracker.feed('cd ../app\r', '/home/porlog/software')).toBe('/home/porlog/app');

    expect(
      tracker.feed(
        'cd ../ap\t\r',
        '/home/porlog/software',
        () => '[porlog@portal-log software]$ cd ../app/',
      ),
    ).toBe('/home/porlog/app');

    expect(
      tracker.feed(
        'cd ../ap\t\r',
        '/home/porlog/software',
        () => '[porlog@portal-log software]$ cd ../ap',
      ),
    ).toBe('/home/porlog/ap');

    expect(
      tracker.feed(
        'cd ../ap\t\r',
        '/home/porlog/software',
        () => null,
      ),
    ).toBeNull();

    expect(
      tracker.feed(
        '\x1b[A\r',
        '/home/porlog/software',
        () => '[porlog@portal-log software]$ cd /opt/openresty',
      ),
    ).toBe('/opt/openresty');
  });
});
