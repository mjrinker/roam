/**
 * Searching a photo library. A query matches the item's name, and, if it reads as a date, the items taken
 * in that period: "2024", "2024-03", "2024-03-14", "March 2024", "Mar 2024". Both are tried together, so
 * "2024" finds IMG_2024 and the photos from 2024. Dates are read in UTC like everything on the timeline
 * (see lib/scan/exif). Day-first or month-first numeric dates are NOT guessed at.
 */
export const MAX_QUERY_LENGTH = 64;

export interface SearchSpec {
  /** The cleaned text to look for in names. */
  text: string;
  /** Items taken in [from, to), if the query is a date. */
  range: { from: Date; to: Date } | null;
}

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

function monthIndex(word: string): number {
  const w = word.toLowerCase();
  if (w.length < 3) return -1;
  return MONTHS.findIndex((m) => m === w || (w.length === 3 && m.startsWith(w)) || (w === "sept" && m === "september"));
}

const valid = (y: number) => y >= 1826 && y <= 9998;

function dateRange(q: string): { from: Date; to: Date } | null {
  let m = /^(\d{4})$/.exec(q);
  if (m && valid(+m[1])) return { from: new Date(Date.UTC(+m[1], 0, 1)), to: new Date(Date.UTC(+m[1] + 1, 0, 1)) };

  m = /^(\d{4})-(\d{1,2})$/.exec(q);
  if (m && valid(+m[1]) && +m[2] >= 1 && +m[2] <= 12) return { from: new Date(Date.UTC(+m[1], +m[2] - 1, 1)), to: new Date(Date.UTC(+m[1], +m[2], 1)) };

  m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(q);
  if (m && valid(+m[1]) && +m[2] >= 1 && +m[2] <= 12) {
    const from = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    // Feb 30 rolls into March: not a real day.
    if (from.getUTCMonth() !== +m[2] - 1 || +m[3] < 1) return null;
    return { from, to: new Date(from.getTime() + 86_400_000) };
  }

  m = /^([a-z]{3,9})\.?,?\s+(\d{4})$/i.exec(q) ?? /^(\d{4})\s+([a-z]{3,9})\.?$/i.exec(q);
  if (m) {
    const [word, year] = /^\d/.test(m[1]) ? [m[2], m[1]] : [m[1], m[2]];
    const i = monthIndex(word);
    if (i >= 0 && valid(+year)) return { from: new Date(Date.UTC(+year, i, 1)), to: new Date(Date.UTC(+year, i + 1, 1)) };
  }
  return null;
}

/** Cleans a raw query (trimmed, spaces collapsed, control characters dropped, length capped) and reads any date in it. Null for an empty query. */
export function parseSearch(raw: string | null | undefined): SearchSpec | null {
  if (typeof raw !== "string") return null;
  const text = raw.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_QUERY_LENGTH).trim();
  if (!text) return null;
  return { text, range: dateRange(text) };
}

/** Makes `text` safe to put between % in a LIKE pattern that uses backslash as its escape. */
export const escapeLike = (text: string) => text.replace(/[\\%_]/g, (c) => `\\${c}`);
