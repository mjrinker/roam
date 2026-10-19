/**
 * Sets the "taken" date inside a JPEG's EXIF block (DateTimeOriginal, DateTimeDigitized and DateTime), leaving everything else in the file
 * exactly as it is: the picture's compressed data is never touched, and the rest of the EXIF (orientation, camera, location, maker notes) is
 * kept. The edit only appends to the EXIF block: new copies of the two directories that change go at its end, and the header is pointed at
 * them, so every offset already in the block stays valid. A file with no EXIF gets a small block of its own.
 *
 * Throws for anything that isn't a JPEG, or whose EXIF is too damaged or too big to extend: the caller then leaves the file as it is.
 */
const EXIF_PREFIX = [0x45, 0x78, 0x69, 0x66, 0, 0]; // "Exif\0\0"
const TAG_DATETIME = 0x0132;
const TAG_EXIF_POINTER = 0x8769;
const TAG_DATETIME_ORIGINAL = 0x9003;
const TAG_DATETIME_DIGITIZED = 0x9004;
const MAX_ENTRIES = 512;
const MAX_SEGMENT = 0xffff - 2;

interface RawEntry {
  tag: number;
  bytes: Uint8Array; // the whole 12-byte entry
}

const pad2 = (n: number) => String(n).padStart(2, "0");
export const exifDateString = (d: Date) => `${d.getUTCFullYear()}:${pad2(d.getUTCMonth() + 1)}:${pad2(d.getUTCDate())} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`;

function isExifSegment(b: Uint8Array, at: number, length: number) {
  return length >= 8 && EXIF_PREFIX.every((v, i) => b[at + 4 + i] === v);
}

export function setJpegTakenAt(jpeg: Uint8Array, takenAt: Date): Uint8Array {
  if (jpeg.length < 4 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) throw new Error("Not a JPEG.");
  if (Number.isNaN(takenAt.getTime())) throw new Error("No date.");

  // The segments before the picture data: where the EXIF one is (or would go).
  let at = 2;
  let exifAt = -1;
  let exifLength = 0;
  let insertAt = 2;
  while (at + 4 <= jpeg.length && jpeg[at] === 0xff) {
    const marker = jpeg[at + 1];
    if (marker === 0xda || marker === 0xd9) break;
    const length = (jpeg[at + 2] << 8) | jpeg[at + 3];
    if (length < 2 || at + 2 + length > jpeg.length) throw new Error("Damaged JPEG.");
    if (marker === 0xe1 && exifAt < 0 && isExifSegment(jpeg, at, length)) {
      exifAt = at;
      exifLength = 2 + length;
    }
    if (marker === 0xe0 && at === 2) insertAt = at + 2 + length; // after the JFIF header, where cameras put it
    at += 2 + length;
  }

  const tiff = exifAt >= 0 ? jpeg.subarray(exifAt + 10, exifAt + exifLength) : null;
  const little = tiff ? tiff[0] === 0x49 : true;
  if (tiff && !((tiff[0] === 0x49 && tiff[1] === 0x49) || (tiff[0] === 0x4d && tiff[1] === 0x4d))) throw new Error("Damaged EXIF.");

  const out: number[] = tiff ? Array.from(tiff) : [0x49, 0x49, 0x2a, 0, 8, 0, 0, 0];
  const u16 = (o: number) => (little ? out[o] | (out[o + 1] << 8) : (out[o] << 8) | out[o + 1]);
  const u32 = (o: number) => (little ? (out[o] | (out[o + 1] << 8) | (out[o + 2] << 16) | (out[o + 3] << 24)) >>> 0 : ((out[o] << 24) | (out[o + 1] << 16) | (out[o + 2] << 8) | out[o + 3]) >>> 0);
  const put16 = (n: number) => (little ? [n & 255, (n >> 8) & 255] : [(n >> 8) & 255, n & 255]);
  const put32 = (n: number) => (little ? [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255] : [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
  const setU32 = (o: number, n: number) => put32(n).forEach((v, i) => (out[o + i] = v));

  const readIfd = (offset: number): { entries: RawEntry[]; next: number } => {
    if (offset < 8 || offset + 2 > out.length) throw new Error("Damaged EXIF.");
    const count = u16(offset);
    if (count > MAX_ENTRIES || offset + 2 + count * 12 + 4 > out.length) throw new Error("Damaged EXIF.");
    const entries: RawEntry[] = [];
    for (let i = 0; i < count; i++) {
      const o = offset + 2 + i * 12;
      entries.push({ tag: u16(o), bytes: Uint8Array.from(out.slice(o, o + 12)) });
    }
    return { entries, next: u32(offset + 2 + count * 12) };
  };
  const entry = (tag: number, type: number, count: number, value: number): RawEntry => ({ tag, bytes: Uint8Array.from([...put16(tag), ...put16(type), ...put32(count), ...put32(value)]) });
  const append = (bytes: number[]): number => {
    if (out.length % 2) out.push(0);
    const offset = out.length;
    out.push(...bytes);
    return offset;
  };
  const writeIfd = (entries: RawEntry[], next: number): number =>
    append([...put16(entries.length), ...[...entries].sort((a, b) => a.tag - b.tag).flatMap((e) => [...e.bytes]), ...put32(next)]);

  const ifd0 = tiff ? readIfd(u32(4)) : { entries: [], next: 0 };
  const exifPointer = ifd0.entries.find((e) => e.tag === TAG_EXIF_POINTER);
  const valueOf = (e: RawEntry) => (little ? (e.bytes[8] | (e.bytes[9] << 8) | (e.bytes[10] << 16) | (e.bytes[11] << 24)) >>> 0 : ((e.bytes[8] << 24) | (e.bytes[9] << 16) | (e.bytes[10] << 8) | e.bytes[11]) >>> 0);
  const exifIfd = exifPointer ? readIfd(valueOf(exifPointer)) : { entries: [], next: 0 };

  const text = [...Buffer.from(`${exifDateString(takenAt)}\0`, "ascii")];
  const dateAt = append(text);
  const exifEntries = exifIfd.entries
    .filter((e) => e.tag !== TAG_DATETIME_ORIGINAL && e.tag !== TAG_DATETIME_DIGITIZED)
    .concat([entry(TAG_DATETIME_ORIGINAL, 2, 20, dateAt), entry(TAG_DATETIME_DIGITIZED, 2, 20, dateAt)]);
  const exifIfdAt = writeIfd(exifEntries, exifIfd.next);
  const ifd0Entries = ifd0.entries
    .filter((e) => e.tag !== TAG_EXIF_POINTER && e.tag !== TAG_DATETIME)
    .concat([entry(TAG_EXIF_POINTER, 4, 1, exifIfdAt), entry(TAG_DATETIME, 2, 20, dateAt)]);
  const ifd0At = writeIfd(ifd0Entries, ifd0.next);
  setU32(4, ifd0At);

  if (out.length + 8 > MAX_SEGMENT) throw new Error("The EXIF block is too large to extend.");
  const length = out.length + 8; // the length field (2) + "Exif\0\0" (6) + the block
  const segment = [0xff, 0xe1, (length >> 8) & 255, length & 255, ...EXIF_PREFIX, ...out];

  const head = exifAt >= 0 ? jpeg.subarray(0, exifAt) : jpeg.subarray(0, insertAt);
  const tail = exifAt >= 0 ? jpeg.subarray(exifAt + exifLength) : jpeg.subarray(insertAt);
  const result = new Uint8Array(head.length + segment.length + tail.length);
  result.set(head, 0);
  result.set(segment, head.length);
  result.set(tail, head.length + segment.length);
  return result;
}
