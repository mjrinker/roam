/**
 * A bounded reader for the TIFF structure inside EXIF (JPEG's APP1 segment, HEIC's Exif item): when a
 * photo was taken, which way it is turned, and its pixel size. Photo files come from anywhere, so every
 * read is range-checked, only the two directories that matter are visited (no chain of "next" pointers
 * to loop on), and entry counts are capped. Never throws: whatever can't be read safely is null.
 *
 * Deliberately reads NO location data: the GPS directory is never opened.
 */

export interface ExifData {
  /** The wall-clock time on the camera, as a Date in UTC terms (an EXIF time has no zone, so none is applied). */
  takenAt: Date | null;
  /** 1-8, how the stored image is turned relative to how it should be shown. */
  orientation: number | null;
  /** Pixel size the file declares (stored, not yet turned by `orientation`). */
  width: number | null;
  height: number | null;
}

const NOTHING: ExifData = { takenAt: null, orientation: null, width: null, height: null };
const MAX_ENTRIES = 512;
const EARLIEST_YEAR = 1826; // the oldest photograph
const FUTURE_SLACK_MS = 24 * 60 * 60 * 1000;

export const MAX_DIMENSION = 1_000_000;
export const validDimension = (n: number | null | undefined): n is number => typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= MAX_DIMENSION;

/** "YYYY:MM:DD HH:MM:SS" (a few cameras use "-" between the date parts) as a UTC Date, or null for anything else, including impossible dates. */
export function parseExifDate(raw: string, now = Date.now()): Date | null {
  const m = /^(\d{4})[:-](\d{2})[:-](\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(raw.replace(/[\0 ]+$/, ""));
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number);
  if (y < EARLIEST_YEAR || mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return null;
  const date = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
  // Date rolls an impossible day (Feb 30) into the next month; a real date comes back unchanged.
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return null;
  return date.getTime() > now + FUTURE_SLACK_MS ? null : date;
}

interface Entry {
  type: number;
  count: number;
  /** Offset of the value's bytes (inline in the entry, or where the entry points). */
  at: number;
}

const TYPE_SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4 };

/** `tiff` starts at the TIFF header ("II*\0" or "MM\0*"). */
export function parseExif(tiff: Uint8Array, now = Date.now()): ExifData {
  try {
    return read(tiff, now);
  } catch {
    return NOTHING;
  }
}

function read(t: Uint8Array, now: number): ExifData {
  if (t.length < 8) return NOTHING;
  const little = t[0] === 0x49 && t[1] === 0x49;
  if (!little && !(t[0] === 0x4d && t[1] === 0x4d)) return NOTHING;
  const dv = new DataView(t.buffer, t.byteOffset, t.byteLength);
  const u16 = (o: number) => (Number.isInteger(o) && o >= 0 && o + 2 <= t.length ? dv.getUint16(o, little) : undefined);
  const u32 = (o: number) => (Number.isInteger(o) && o >= 0 && o + 4 <= t.length ? dv.getUint32(o, little) : undefined);
  if (u16(2) !== 42) return NOTHING;

  const directory = (offset: number | undefined): Map<number, Entry> => {
    const entries = new Map<number, Entry>();
    if (offset === undefined || offset < 8) return entries;
    const declared = u16(offset);
    if (declared === undefined) return entries;
    const n = Math.min(declared, MAX_ENTRIES, Math.floor((t.length - offset - 2) / 12));
    for (let i = 0; i < n; i++) {
      const e = offset + 2 + 12 * i;
      const tag = u16(e);
      const type = u16(e + 2);
      const count = u32(e + 4);
      if (tag === undefined || type === undefined || count === undefined) break;
      const size = (TYPE_SIZE[type] ?? 0) * count;
      const at = size <= 4 ? e + 8 : u32(e + 8);
      if (at === undefined || size === 0) continue;
      if (size > 4 && at + size > t.length) continue; // points outside the data
      if (!entries.has(tag)) entries.set(tag, { type, count, at });
    }
    return entries;
  };
  const number = (e: Entry | undefined): number | null => {
    if (!e || e.count < 1) return null;
    const v = e.type === 3 ? u16(e.at) : e.type === 4 ? u32(e.at) : undefined;
    return v === undefined ? null : v;
  };
  const text = (e: Entry | undefined): string | null => {
    if (!e || e.type !== 2 || e.count < 1 || e.count > 64) return null;
    let s = "";
    for (let i = 0; i < e.count; i++) {
      const c = t[e.at + i];
      if (c === 0) break;
      s += String.fromCharCode(c);
    }
    return s;
  };

  const ifd0 = directory(u32(4));
  const pointer = number(ifd0.get(0x8769));
  const exifIfd = pointer === null ? new Map<number, Entry>() : directory(pointer);

  // The shutter time, else when it was digitized, else (weakest) when the file was last written.
  const takenAt =
    [text(exifIfd.get(0x9003)), text(exifIfd.get(0x9004)), text(ifd0.get(0x0132))]
      .map((s) => (s === null ? null : parseExifDate(s, now)))
      .find((d) => d !== null) ?? null;

  const o = number(ifd0.get(0x0112));
  const width = number(exifIfd.get(0xa002));
  const height = number(exifIfd.get(0xa003));
  return {
    takenAt,
    orientation: o !== null && o >= 1 && o <= 8 ? o : null,
    width: validDimension(width) ? width : null,
    height: validDimension(height) ? height : null,
  };
}
