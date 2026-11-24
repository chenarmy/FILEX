export interface SpeedSample {
  bytes: number;
  timestampMs: number;
  bytesPerSecond: number;
}

const SPEED_SMOOTHING_ALPHA = 0.35;
const MIN_DELTA_MS = 80;

export function updateSpeedSample(
  previous: SpeedSample | undefined,
  nextBytes: number,
  nowMs: number,
): SpeedSample {
  const safeBytes = Math.max(0, nextBytes);
  if (!previous) {
    return {
      bytes: safeBytes,
      timestampMs: nowMs,
      bytesPerSecond: 0,
    };
  }
  if (safeBytes < previous.bytes) {
    return {
      bytes: safeBytes,
      timestampMs: nowMs,
      bytesPerSecond: 0,
    };
  }
  const elapsedMs = nowMs - previous.timestampMs;
  if (elapsedMs < MIN_DELTA_MS) {
    return previous;
  }
  const deltaBytes = safeBytes - previous.bytes;
  const instantRate = (deltaBytes * 1000) / elapsedMs;
  const smoothed = previous.bytesPerSecond > 0
    ? previous.bytesPerSecond * (1 - SPEED_SMOOTHING_ALPHA) + instantRate * SPEED_SMOOTHING_ALPHA
    : instantRate;
  return {
    bytes: safeBytes,
    timestampMs: nowMs,
    bytesPerSecond: Math.max(0, smoothed),
  };
}

export function formatTransferSpeed(bytesPerSecond: number | null | undefined): string {
  if (bytesPerSecond === null || bytesPerSecond === undefined || !Number.isFinite(bytesPerSecond) || bytesPerSecond < 0) {
    return '—';
  }
  if (bytesPerSecond < 1024) {
    return `${Math.round(bytesPerSecond)} B/s`;
  }
  if (bytesPerSecond < 1024 * 1024) {
    return `${(bytesPerSecond / 1024).toFixed(1)} KB/s`;
  }
  if (bytesPerSecond < 1024 * 1024 * 1024) {
    return `${(bytesPerSecond / (1024 * 1024)).toFixed(2)} MB/s`;
  }
  return `${(bytesPerSecond / (1024 * 1024 * 1024)).toFixed(2)} GB/s`;
}

export function formatTransferBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes < 0) {
    return '—';
  }
  if (bytes < 1024) {
    return `${Math.round(bytes)} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  }
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
