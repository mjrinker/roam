/**
 * Building a video file's profanity mutes from an OpenSubtitles subtitle, one file at a time (the script in scripts/build-language-filters.ts
 * calls this for as many files as the day's download allowance covers). By default only a subtitle made for this exact file is used, because
 * only then does its timing line up. In "loose" mode the best subtitle for the film is used if its length is plausible for the video, and
 * the result is marked as a guess. The subtitle itself is never kept, only the mute times.
 */
import type { FilterCue } from "@/lib/content-filter/categories";
import { languageCuesFromSubtitles } from "@/lib/content-filter/profanity";
import { computeMovieHash } from "@/lib/subtitles/moviehash";
import { parseSubtitleBytes } from "@/lib/subtitles/cues";
import { OpenSubtitlesError, type OpenSubtitles, type SubtitleResult, type SubtitleSearch } from "@/lib/subtitles/opensubtitles";

export type BuildOutcome =
  | { status: "built"; cues: FilterCue[]; guess: boolean; fileName: string; remaining: number | null }
  /** The file is too small to fingerprint. */
  | { status: "no_hash" }
  /** No subtitle was made for this exact file (and loose mode is off, or nothing plausible was found either). */
  | { status: "unmatched" }
  | { status: "bad_subtitle" }
  /** The day's download allowance is used up: stop. */
  | { status: "quota" }
  | { status: "error"; message: string };

/** A subtitle's last line should end near the end of the film (credits aside): a mismatch this large means a different film or cut. */
const PLAUSIBLE_LAST_LINE = { min: 0.8, max: 1.02 };

export async function buildLanguageCues(
  deps: { os: Pick<OpenSubtitles, "search" | "download">; fetchRange: (start: number, end: number) => Promise<ArrayBuffer> },
  input: { target: Omit<SubtitleSearch, "languages" | "movieHash">; sizeBytes: number; durationSeconds: number; loose?: boolean }
): Promise<BuildOutcome> {
  try {
    const hash = await computeMovieHash(deps.fetchRange, input.sizeBytes);
    if (!hash) return { status: "no_hash" };
    const exact = (await deps.os.search({ ...input.target, movieHash: hash, languages: ["en"] })).filter((r) => r.hashMatch && !r.aiTranslated);
    let pool: SubtitleResult[] = exact;
    if (pool.length === 0 && input.loose) pool = (await deps.os.search({ ...input.target, languages: ["en"] })).filter((r) => !r.aiTranslated);
    if (pool.length === 0) return { status: "unmatched" };
    // Spoken words only (not the hearing-impaired version with sound descriptions) when there is a choice; the client already puts trusted, popular ones first.
    const ordered = [...pool].sort((a, b) => Number(a.hearingImpaired) - Number(b.hearingImpaired));
    const guess = exact.length === 0;
    for (const pick of ordered.slice(0, guess ? 3 : 1)) {
      const dl = await deps.os.download(pick.fileId);
      const parsed = parseSubtitleBytes(dl.bytes);
      if (!parsed.ok) continue;
      const lastEnd = parsed.cues.reduce((m, c) => Math.max(m, c[1]), 0);
      // A guess has to at least be about the right length.
      if (guess && !(lastEnd >= input.durationSeconds * PLAUSIBLE_LAST_LINE.min && lastEnd <= input.durationSeconds * PLAUSIBLE_LAST_LINE.max)) continue;
      return { status: "built", cues: languageCuesFromSubtitles(parsed.cues), guess, fileName: dl.fileName, remaining: dl.remaining };
    }
    return { status: guess ? "unmatched" : "bad_subtitle" };
  } catch (err) {
    if (err instanceof OpenSubtitlesError && err.kind === "quota") return { status: "quota" };
    return { status: "error", message: err instanceof Error ? err.message : String(err) };
  }
}
