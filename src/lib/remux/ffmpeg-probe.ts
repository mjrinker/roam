/**
 * Reads a file's first audio stream out of `ffmpeg -i <file>` stderr (the
 * bundled ffmpeg has no ffprobe). Pure text parsing; the caller runs ffmpeg.
 */

export interface AudioStreamInfo {
  codec: string;
  channels: number;
}

const LAYOUT_CHANNELS: Record<string, number> = {
  mono: 1,
  stereo: 2,
  "2.1": 3,
  "3.0": 3,
  "4.0": 4,
  quad: 4,
  "5.0": 5,
  "5.1": 6,
  "6.0": 6,
  "6.1": 7,
  "7.0": 7,
  "7.1": 8,
};

/** "5.1(side)" -> 6, "stereo" -> 2, "6 channels" -> 6; null if unrecognized. */
export function channelsFromLayout(layout: string): number | null {
  const l = layout.trim().toLowerCase();
  const count = /^(\d+) channels?/.exec(l);
  if (count) return Number(count[1]);
  return LAYOUT_CHANNELS[l.replace(/\(.*\)$/, "")] ?? null;
}

/** The first `Audio:` stream line of ffmpeg's input summary, or null when the file has none. */
export function parseFirstAudioStream(ffmpegStderr: string): AudioStreamInfo | null {
  const line = ffmpegStderr.split("\n").find((l) => /Stream #\d+:\d+.*: Audio:/.test(l));
  if (!line) return null;
  const codec = /Audio: ([a-z0-9_]+)/i.exec(line)?.[1]?.toLowerCase();
  if (!codec) return null;
  // "Audio: ac3 (AC-3 / 0x332D4341), 48000 Hz, 5.1(side), fltp, 448 kb/s"
  const fields = line.slice(line.indexOf("Audio:")).split(",").map((f) => f.trim());
  let channels = 2;
  for (const f of fields.slice(1)) {
    const n = channelsFromLayout(f);
    if (n !== null) {
      channels = n;
      break;
    }
  }
  return { codec, channels };
}
