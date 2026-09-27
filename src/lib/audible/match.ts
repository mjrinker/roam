import type { AudibleSearchResult } from "./parse";

/** Lowercased, accent-stripped, punctuation-free tokens; filler words dropped. */
export function tokens(text: string): string[] {
  return text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/\(?\b(?:un)?abridged\b\)?|\baudiobook\b|\ba novel\b/g, " ")
    .split(/[^a-z0-9]+/)
    .filter((t) => t && !["the", "a", "an"].includes(t));
}

/** Order-insensitive similarity of two token lists, 0..1 (Dice coefficient). */
function dice(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let overlap = 0;
  for (const t of setA) if (setB.has(t)) overlap++;
  return (2 * overlap) / (setA.size + setB.size);
}

/** Title similarity, also trying the candidate without its subtitle ("Skyward: Book 1" -> "Skyward"). */
export function titleSimilarity(wanted: string, candidate: string): number {
  const w = tokens(wanted);
  const full = dice(w, tokens(candidate));
  const main = candidate.split(/\s*(?::| - | — )\s*/)[0];
  const trimmed = main !== candidate ? dice(w, tokens(main)) : 0;
  // Every word of the folder name appearing in the candidate is a strong hint too.
  const cand = new Set(tokens(candidate));
  const contained = w.length >= 2 && w.every((t) => cand.has(t)) ? 0.9 : 0;
  return Math.max(full, trimmed, contained);
}

export function authorSimilarity(wanted: string, candidateAuthors: string[]): number {
  const w = tokens(wanted);
  return Math.max(0, ...candidateAuthors.map((a) => dice(w, tokens(a))));
}

/** Best similarity between any wanted narrator and any candidate narrator (names are order-insensitive). */
export function narratorSimilarity(wanted: string[], candidates: string[]): number {
  return Math.max(0, ...wanted.flatMap((w) => candidates.map((c) => dice(tokens(w), tokens(c)))));
}

export interface MatchQuery {
  title: string;
  author?: string | null;
  /** Narrator(s) named by the files (e.g. "Title [Ray Porter].m4b"); separates editions of one book read by different people. */
  narrators?: string[] | null;
  year?: number | null;
  /** Known runtime (from probing); used to tell abridged from unabridged and reject wrong editions. */
  runtimeMinutes?: number | null;
}

export interface ScoredMatch {
  result: AudibleSearchResult;
  score: number;
}

const MIN_TITLE_SCORE = 0.6;
const MIN_TOTAL_SCORE = 0.6;

/** Scores every candidate; best first. Candidates that fail the title/author bars are dropped. */
export function rankMatches(query: MatchQuery, results: AudibleSearchResult[]): ScoredMatch[] {
  const scored: ScoredMatch[] = [];
  for (const result of results) {
    const titleScore = titleSimilarity(query.title, result.title);
    if (titleScore < MIN_TITLE_SCORE) continue;

    let score = titleScore;
    if (query.author) {
      const authorScore = authorSimilarity(query.author, result.authors);
      // Only a (near-)exact title may skip the author check, e.g. when the folder's author is spelled oddly.
      if (authorScore < 0.4 && titleScore < 0.98) continue;
      score = 0.7 * titleScore + 0.3 * authorScore;
    }
    if (query.narrators?.length && result.narrators.length > 0) {
      // Same book, different reader: the tagged narrator is the tiebreaker.
      const narratorScore = narratorSimilarity(query.narrators, result.narrators);
      score += narratorScore >= 0.5 ? 0.1 * narratorScore : -0.2;
    }
    if (query.year && result.releaseYear === query.year) score += 0.05;
    if (query.runtimeMinutes && result.runtimeMinutes) {
      const ratio = Math.abs(result.runtimeMinutes - query.runtimeMinutes) / query.runtimeMinutes;
      if (ratio > 0.25) score -= 0.2;
      else if (ratio < 0.05) score += 0.03;
    }
    if (score >= MIN_TOTAL_SCORE) scored.push({ result, score });
  }
  return scored.sort((a, b) => b.score - a.score);
}

export function pickBestMatch(query: MatchQuery, results: AudibleSearchResult[]): AudibleSearchResult | null {
  return rankMatches(query, results)[0]?.result ?? null;
}
