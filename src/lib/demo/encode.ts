/**
 * How a demo clip is cut from a source film. Only the main picture and sound are kept: a source's chapter list,
 * subtitle tracks and tags must not follow the clip (a leftover chapter list once made a 45-second clip claim to be
 * 12 minutes long, which Roam would have read as its duration). 720p at most, H.264 + AAC, index first, so it
 * plays in every browser and a clip is only a few MB.
 */
export function clipEncodeArgs(input: string, output: string, startSeconds: number, seconds: number): string[] {
  return [
    "-hide_banner", "-loglevel", "error", "-y",
    "-ss", String(startSeconds), "-t", String(seconds), "-i", input,
    "-map", "0:v:0", "-map", "0:a:0", "-map_chapters", "-1", "-map_metadata", "-1", "-sn", "-dn",
    "-vf", "scale=-2:min(720\\,ih)",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "26", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "96k", "-ac", "2",
    "-movflags", "+faststart",
    output,
  ];
}
