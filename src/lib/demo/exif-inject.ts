/**
 * Writes a capture date into a JPEG as EXIF, so a demo photo carries the date its author recorded and Roam's
 * timeline reads it the way it reads a real camera's. A downsized copy from Wikimedia Commons has its EXIF
 * stripped, so the date (which Commons keeps as metadata) is put back. Nothing else is invented: no location, no
 * camera. Any EXIF the file already had is replaced, not merged.
 */
const pad = (n: number, w = 2) => String(n).padStart(w, "0");

/** "YYYY:MM:DD HH:MM:SS" in UTC terms (an EXIF time has no zone; Roam shows it as written). */
export function exifDateString(date: Date): string {
  return `${pad(date.getUTCFullYear(), 4)}:${pad(date.getUTCMonth() + 1)}:${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
}

const le16 = (n: number) => [n & 255, (n >> 8) & 255];
const le32 = (n: number) => [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255];

/** A little-endian TIFF block: IFD0 {DateTime, ExifIFD pointer} and an Exif IFD {DateTimeOriginal, DateTimeDigitized}. */
function tiffWithDate(stamp: string): number[] {
  const text = [...new TextEncoder().encode(stamp), 0]; // 20 bytes
  const ifd0At = 8;
  const ifd0Size = 2 + 12 * 2 + 4;
  const exifAt = ifd0At + ifd0Size;
  const exifSize = 2 + 12 * 2 + 4;
  const dataAt = exifAt + exifSize;
  const entry = (tag: number, at: number) => [...le16(tag), ...le16(2), ...le32(20), ...le32(at)];
  return [
    0x49, 0x49, 42, 0, ...le32(ifd0At),
    ...le16(2), ...entry(0x0132, dataAt), ...[...le16(0x8769), ...le16(4), ...le32(1), ...le32(exifAt)], ...le32(0),
    ...le16(2), ...entry(0x9003, dataAt), ...entry(0x9004, dataAt), ...le32(0),
    ...text,
  ];
}

/** The JPEG with an Exif APP1 segment holding `date` placed right after the start marker. Throws if the bytes are not a JPEG. */
export function injectExifDate(jpeg: Uint8Array, date: Date): Uint8Array {
  if (jpeg.length < 4 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) throw new Error("Not a JPEG.");
  if (!Number.isFinite(date.getTime())) throw new Error("Not a valid date.");
  const tiff = tiffWithDate(exifDateString(date));
  const body = [...new TextEncoder().encode("Exif"), 0, 0, ...tiff];
  const segment = [0xff, 0xe1, (body.length + 2) >> 8, (body.length + 2) & 255, ...body];

  // Copy everything after SOI except any existing Exif segment (other APP segments, like JFIF, stay).
  const out: number[] = [0xff, 0xd8, ...segment];
  let o = 2;
  while (o + 4 <= jpeg.length && jpeg[o] === 0xff) {
    const marker = jpeg[o + 1];
    if (marker === 0xda || marker === 0xd9) break; // compressed data (or end): the rest is copied as is
    const length = (jpeg[o + 2] << 8) | jpeg[o + 3];
    if (length < 2 || o + 2 + length > jpeg.length) break;
    const isExif = marker === 0xe1 && length >= 8 && String.fromCharCode(...jpeg.subarray(o + 4, o + 8)) === "Exif";
    if (!isExif) for (let i = 0; i < 2 + length; i++) out.push(jpeg[o + i]);
    o += 2 + length;
  }
  const head = Uint8Array.from(out);
  const result = new Uint8Array(head.length + (jpeg.length - o));
  result.set(head, 0);
  result.set(jpeg.subarray(o), head.length);
  return result;
}
