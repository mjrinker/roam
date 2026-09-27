export const AUDIO_MP4_CONTAINERS = new Set(["m4b", "m4a"]);

export function containerOf(file: { container: string | null; filename: string }): string {
  return (file.container ?? file.filename.slice(file.filename.lastIndexOf(".") + 1)).toLowerCase();
}

export function isAudioContainer(container: string): boolean {
  return container === "mp3" || AUDIO_MP4_CONTAINERS.has(container);
}

/**
 * Rough duration for an audio part that can't be probed, assuming a typical
 * audiobook bitrate (128 kbps mp3, 64 kbps AAC). Used only once a part has
 * exhausted its probe attempts, so one unreadable file can't keep a whole
 * book unplayable; the part stays marked failed so it's still visible.
 */
export function estimateAudioDurationMs(container: string, sizeBytes: number): number | null {
  if (!isAudioContainer(container) || !(sizeBytes > 0)) return null;
  const bitsPerSecond = container === "mp3" ? 128_000 : 64_000;
  return Math.round(((sizeBytes * 8) / bitsPerSecond) * 1000);
}
