/**
 * Which audio codecs browsers other than Safari (and, for a few of these,
 * Safari too) can't decode natively — the root cause of "video plays with
 * no sound" on desktop Chrome/Firefox. See lib/scan/mp4-duration.ts for
 * where a file's actual codec is read, and lib/remux/ for the one-time
 * server-side fix.
 *
 * Safari can decode AC-3/E-AC-3 (Apple's AVFoundation), but NOT DTS/DTS:X —
 * a single generic "can this browser play it" check is wrong; callers
 * should test per-codec (see the player's canPlayType usage).
 */
export const UNSUPPORTED_AUDIO_CODECS = [
  "ac-3",
  "ec-3", // Dolby Digital / Dolby Digital Plus
  "dtsc",
  "dtsh",
  "dtsl",
  "dtse",
  "dtsx",
  "dtsy", // DTS / DTS:X
  "ac-4", // Dolby AC-4
  "mha1",
  "mhm1", // MPEG-H
  "alac", // Apple Lossless
  "lpcm",
  "sowt",
  "twos",
  "ipcm", // uncompressed PCM in .mov
] as const;

/**
 * `mp4a` (AAC or MP3-in-MP4) is universally safe. Anything else we don't
 * recognize is ALSO treated as safe — never flag a codec we've simply never
 * seen, since a false "this needs fixing" is worse than missing a genuinely
 * rare one.
 */
export function isBrowserSafeAudioCodec(codec: string | null): boolean {
  if (codec === null) return true;
  return !(UNSUPPORTED_AUDIO_CODECS as readonly string[]).includes(codec.toLowerCase());
}
