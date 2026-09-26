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
