/** 3_200_000_000 -> "3.2 GB"; 640_000_000 -> "640 MB"; null -> "size unknown". */
export function formatBytes(bytes: number | null): string {
  if (bytes === null || !Number.isFinite(bytes) || bytes < 0) return "size unknown";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit++;
  }
  const digits = unit >= 3 ? (value >= 100 ? 0 : 1) : 0;
  return `${value.toFixed(digits)} ${units[unit]}`;
}

/** 0.4237 -> 42 (whole percent, never 100 until it is). */
export function percentOf(done: number, total: number | null): number | null {
  if (!total || total <= 0) return null;
  return Math.min(done >= total ? 100 : 99, Math.floor((done / total) * 100));
}
