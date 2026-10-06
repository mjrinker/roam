/** 6720 -> "1h 52m"; 2700 -> "45m". Null for missing/zero runtimes. */
export function formatRuntime(totalSeconds: number | null | undefined): string | null {
  if (!totalSeconds || totalSeconds <= 0) return null;
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.round((totalSeconds % 3600) / 60);
  if (hours === 0) return `${Math.max(minutes, 1)}m`;
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}

/** Time left in something partly watched: "34 min left", "1h 12m left". */
export function formatRemaining(
  durationSeconds: number,
  positionSeconds: number
): string | null {
  const remaining = durationSeconds - positionSeconds;
  if (remaining <= 0) return null;
  if (remaining < 3600) return `${Math.max(Math.round(remaining / 60), 1)} min left`;
  return `${formatRuntime(remaining)} left`;
}

/** A file size for people: "3.5 MB". Null for an unknown or nonsensical size. */
export function formatFileSize(bytes: number | null | undefined): string | null {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return null;
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  // Round first, then roll over: 1,048,575 bytes is "1.0 MB", not "1024 KB".
  if (value >= 1023.95 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value >= 100 || Number.isInteger(value) ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
}
