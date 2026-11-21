import { describe, expect, it } from 'vitest';
import {
  buildDockerFollowTerminalCommand,
  DEFAULT_DOCKER_LOG_TAIL,
  DOCKER_LOG_TAIL_PRESETS,
  parseDockerPorts,
} from '@/domain/docker';

describe('docker domain helpers', () => {
  it('splits comma-separated port mappings cleanly and ignores empty placeholders', () => {
    expect(parseDockerPorts('')).toEqual([]);
    expect(parseDockerPorts('—')).toEqual([]);
    expect(
      parseDockerPorts('0.0.0.0:8012->8012/tcp, [::]:8012->8012/tcp, 443/tcp'),
    ).toEqual([
      '0.0.0.0:8012->8012/tcp',
      '[::]:8012->8012/tcp',
      '443/tcp',
    ]);
  });

  it('builds safe bounded docker follow terminal commands and rejects unsafe container refs', () => {
    expect(DOCKER_LOG_TAIL_PRESETS).toContain(DEFAULT_DOCKER_LOG_TAIL);
    expect(buildDockerFollowTerminalCommand('kkfileview', 100)).toBe(
      "docker logs -f --tail 100 'kkfileview'\r",
    );
    expect(buildDockerFollowTerminalCommand('c464e054ab1c', 9999)).toBe(
      "docker logs -f --tail 500 'c464e054ab1c'\r",
    );
    expect(buildDockerFollowTerminalCommand('bad;rm -rf /', 100)).toBeNull();
    expect(buildDockerFollowTerminalCommand('-leading-dash', 100)).toBeNull();
  });
});
