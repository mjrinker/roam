/**
 * A date and time in a picture's file name, for pictures whose own metadata says none (screenshots, messaging apps, some phones and
 * scanners name files by when they were made: "IMG_20190314_142530.jpg", "Screenshot_2019-03-14-14-25-30.png", "2019-03-14 14.25.30.jpg",
 * "1552573530000.jpg"). The result is a wall-clock time in UTC terms, like an EXIF time (no zone is applied). Only a real calendar date in a
 * believable range counts; a name that merely contains digits (a counter, a size) says nothing.
 */
const EARLIEST_YEAR = 1990;
const FUTURE_SLACK_MS = 24 * 60 * 60 * 1000;

function build(y: number, mo: number, d: number, h: number, mi: number, s: number, now: number): Date | null {
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return null;
  const date = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return null; // Feb 30 and the like
  if (y < EARLIEST_YEAR || date.getTime() > now + FUTURE_SLACK_MS) return null;
  return date;
}

// 2019-03-14 14:25:30 in any mix of "-", "_", ".", ":" and a space or T between the date and the time, or all digits run together.
const DATE_TIME = /(?<!\d)((?:19|20)\d{2})[-_.:]?(\d{2})[-_.:]?(\d{2})[-_.T ]?(\d{2})[-_.:]?(\d{2})[-_.:]?(\d{2})\d{0,3}(?!\d)/; // (a few phones add milliseconds)
// A date alone ("IMG-20190314-WA0001"): the middle of that day, so the picture stays in its day whatever the zone.
const DATE_ONLY = /(?<!\d)((?:19|20)\d{2})[-_.]?(\d{2})[-_.]?(\d{2})(?!\d)/;

export function parseFilenameDate(filename: string, now = Date.now()): Date | null {
  const stem = filename.replace(/\.[A-Za-z0-9]{1,5}$/, "");
  const full = DATE_TIME.exec(stem);
  if (full) {
    const [y, mo, d, h, mi, s] = full.slice(1).map(Number);
    const date = build(y, mo, d, h, mi, s, now);
    if (date) return date;
  }
  // Milliseconds since 1970, as many Android gallery and chat apps write them; seconds only when the whole name is the number.
  const epoch = /(?<!\d)(\d{13})(?!\d)/.exec(stem)?.[1] ?? (/^\d{10}$/.test(stem) ? `${stem}000` : null);
  if (epoch) {
    const t = new Date(Number(epoch));
    const date = build(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate(), t.getUTCHours(), t.getUTCMinutes(), t.getUTCSeconds(), now);
    if (date) return date;
  }
  const day = DATE_ONLY.exec(stem);
  if (day) return build(Number(day[1]), Number(day[2]), Number(day[3]), 12, 0, 0, now);
  return null;
}
