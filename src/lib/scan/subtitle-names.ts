/** Naming of subtitle files beside a video, with nothing that needs the database. */

/** The subtitle formats Plex reads from files: SRT, WebVTT, SSA and ASS, and SMI. */
export const SUBTITLE_EXTENSIONS = ["srt", "vtt", "ass", "ssa", "smi"] as const;

/** "Movie.en.srt" -> { base: "Movie", language: "en" }; "Movie.srt" -> language null. Forced and hearing-impaired variants are named by it too. */
export function subtitleFileParts(fileName: string): { base: string; language: string | null; forced: boolean } | null {
  const m = /^(.*?)((?:\.(?:[a-z]{2,3}(?:-[a-z]{2,4})?|forced|sdh|hi|cc))*)\.(?:srt|vtt|ass|ssa|smi)$/i.exec(fileName);
  if (!m) return null;
  const tags = m[2].split(".").filter(Boolean).map((t) => t.toLowerCase());
  const forced = tags.includes("forced");
  const language = tags.find((t) => /^[a-z]{2,3}(-[a-z]{2,4})?$/.test(t) && !["forced", "sdh", "hi", "cc"].includes(t)) ?? null;
  return { base: m[1], language, forced };
}

