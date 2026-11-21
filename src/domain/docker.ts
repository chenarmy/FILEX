export const DOCKER_LOG_TAIL_PRESETS = [50, 100, 200, 500] as const;
export type DockerLogTailPreset = (typeof DOCKER_LOG_TAIL_PRESETS)[number];
export const DEFAULT_DOCKER_LOG_TAIL: DockerLogTailPreset = 100;

const SAFE_CONTAINER_REF_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;

export function parseDockerPorts(ports: string | null | undefined): string[] {
  if (!ports) return [];
  return ports
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0 && item !== '—');
}

export function buildDockerFollowTerminalCommand(
  containerRef: string,
  tailLines: number = DEFAULT_DOCKER_LOG_TAIL,
): string | null {
  const trimmed = containerRef.trim();
  if (!SAFE_CONTAINER_REF_PATTERN.test(trimmed)) return null;
  const clamped = Math.max(10, Math.min(500, Math.round(tailLines)));
  return `docker logs -f --tail ${clamped} '${trimmed}'\r`;
}
