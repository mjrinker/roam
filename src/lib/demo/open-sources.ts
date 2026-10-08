/**
 * The rules for what may go on the public demo. Everything that is not cut from the two Blender films comes from
 * the Internet Archive or Wikimedia Commons, and is accepted ONLY when the source itself says it is public domain or
 * CC0: anything else, or anything that says nothing, is refused. Pure functions, so the rules are tested without a network.
 */

/** Commons' licence names we accept for photos: dedicated to the public domain, no conditions. */
const COMMONS_OPEN = new Set(["CC0", "CC0 1.0", "Public domain", "Public Domain", "PD"]);
export const isOpenCommonsLicence = (shortName: string | null | undefined): boolean => !!shortName && COMMONS_OPEN.has(shortName.trim());

/** Licence URLs the Internet Archive records for public-domain and CC0 items (LibriVox recordings, Musopen's CC0 releases). */
const ARCHIVE_OPEN = [
  "http://creativecommons.org/publicdomain/zero/1.0/",
  "https://creativecommons.org/publicdomain/zero/1.0/",
  "http://creativecommons.org/publicdomain/mark/1.0/",
  "https://creativecommons.org/publicdomain/mark/1.0/",
  "http://creativecommons.org/licenses/publicdomain/",
  "https://creativecommons.org/licenses/publicdomain/",
];
export const isOpenArchiveLicence = (url: string | null | undefined): boolean => !!url && ARCHIVE_OPEN.includes(url.trim());

const ENTITIES: Record<string, string> = { "&amp;": "&", "&quot;": '"', "&#39;": "'", "&apos;": "'", "&lt;": "<", "&gt;": ">", "&nbsp;": " " };

/** Commons returns credits as HTML: plain text from it (tags dropped, entities decoded, whitespace tidied, length capped). */
export function plainText(html: string | null | undefined, max = 200): string {
  if (!html) return "";
  const text = html
    .replace(/<[^>]*>/g, "")
    .replace(/&(?:amp|quot|#39|apos|lt|gt|nbsp);/g, (m) => ENTITIES[m] ?? m)
    .replace(/\s+/g, " ")
    .trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/**
 * A capture date from Commons' DateTimeOriginal, or null for anything that isn't one exact moment: "circa 1870", "between 1762
 * and 1765", "Unknown date", ranges and bare years. Whole dates get noon (so no time zone can move them to another day),
 * dates with a time keep it. Only 2000 up to now is believable for a photograph from a digital camera.
 */
export function parseCommonsDate(raw: string | null | undefined, now = new Date()): Date | null {
  const text = plainText(raw, 60);
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(text);
  if (!m) return null;
  const [y, mo, d] = [+m[1], +m[2], +m[3]];
  const hasTime = m[4] !== undefined;
  const h = hasTime ? +m[4] : 12;
  const mi = hasTime ? +m[5] : 0;
  const s = hasTime && m[6] ? +m[6] : 0;
  if (y < 2000 || mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return null;
  const date = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
  if (date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return null; // Feb 30 rolls over
  return date.getTime() > now.getTime() ? null : date;
}

/** A readable file title from a Commons file name: no "File:" prefix, extension or camera/ID numbers in brackets. */
export function photoTitle(commonsTitle: string): string {
  return commonsTitle
    .replace(/^File:/i, "")
    .replace(/\.[a-z0-9]{2,5}$/i, "")
    .replace(/\s*\(\d{6,}\)\s*$/, "")
    .replace(/[\\/:*?"<>|]/g, "")
    .replace(/_/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export interface PhotoCandidate {
  title: string;
  mime: string;
  width: number;
  height: number;
  licence: string | null;
  takenAt: Date | null;
  pageUrl: string;
  downloadUrl: string;
  artist: string;
}

export const MIN_PHOTO_WIDTH = 2000;

/** Whether a Commons file may be used: an openly licensed, dated, full-size JPEG. */
export const usablePhoto = (c: PhotoCandidate): boolean =>
  isOpenCommonsLicence(c.licence) && c.mime === "image/jpeg" && c.width >= MIN_PHOTO_WIDTH && c.takenAt !== null && /[A-Za-z]{3}/.test(photoTitle(c.title));

/** Up to `count` usable photos, one per file title, newest first, taken evenly across their dates so the timeline spans the years. */
export function pickPhotos(candidates: PhotoCandidate[], count: number): PhotoCandidate[] {
  const seen = new Set<string>();
  const usable = candidates
    .filter(usablePhoto)
    .filter((c) => {
      const key = photoTitle(c.title).toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => b.takenAt!.getTime() - a.takenAt!.getTime());
  if (usable.length <= count) return usable;
  const chosen: PhotoCandidate[] = [];
  for (let i = 0; i < count; i++) chosen.push(usable[Math.floor((i * usable.length) / count)]);
  return chosen;
}

/** A file name that is safe in Box and in a URL path segment. */
export const safeFileName = (s: string): string => s.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "").replace(/\s+/g, " ").trim();
