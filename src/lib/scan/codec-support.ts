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
 * Video codecs a browser may not decode, each with a full codec string to ask `canPlayType` about (it wants more than the bare fourcc).
 * "hev1" and "hvc1" are both HEVC (H.265); the tag only says where the stream's parameters live, but Safari and iOS refuse hev1 files
 * outright while playing hvc1, and browsers without an HEVC decoder (most desktop Chrome and Firefox) refuse both.
 */
export const VIDEO_CODEC_TESTS: Record<string, string> = {
  hvc1: "hvc1.1.6.L93.B0",
  hev1: "hev1.1.6.L93.B0",
};
export const isVideoCodecToken = (token: string): boolean => token in VIDEO_CODEC_TESTS;

/**
 * Video formats browsers actually play inside MP4/MOV (H.264, HEVC, VP9, AV1). Used only where a file is OFFERED to play with no other
 * version to fall back on (a movie's extras): old QuickTime trailers in Sorenson (svq3) or Cinepak are not worth listing.
 */
const PLAYABLE_VIDEO_CODECS = new Set(["avc1", "avc3", "hvc1", "hev1", "vp09", "av01"]);
/** Audio in old QuickTime files that no browser decodes. */
const UNPLAYABLE_AUDIO_CODECS = new Set(["qdm2", "qdmc", "samr", "sawb", "ima4", "agsm"]);

/** False only when the file's video or audio is a format known not to play in browsers; an unread codec counts as playable. */
export function isBrowserPlayableMedia(videoCodec: string | null, audioCodec: string | null): boolean {
  if (videoCodec && !PLAYABLE_VIDEO_CODECS.has(videoCodec.toLowerCase())) return false;
  if (audioCodec && UNPLAYABLE_AUDIO_CODECS.has(audioCodec.toLowerCase())) return false;
  return true;
}

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

/** True when any row has an unsupported audio codec that hasn't been fixed by a linked remux yet — drives the admin "Fix audio" button. */
export function needsAudioFix(rows: readonly { audioCodec: string | null; remuxStatus: string | null }[]): boolean {
  return rows.some((r) => !isBrowserSafeAudioCodec(r.audioCodec) && r.remuxStatus !== "done");
}
