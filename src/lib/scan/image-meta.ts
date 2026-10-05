/**
 * What a photo file says about itself: when it was taken and how big it is. Read from the first
 * bytes of the file (one ranged read of at most 256 KiB, plus one more small read for the EXIF block
 * of a HEIC), by the file's real format (its first bytes, not its extension). Pure parsing over bytes
 * a provider hands back: nothing here touches the network or the database, and nothing ever throws.
 *
 * Reads no location data. Dimensions are what the picture should look like when shown, so a photo
 * stored sideways and marked "rotate" comes back with width and height swapped.
 */
import { parseExif, validDimension } from "@/lib/scan/exif";
import { EXIF_ITEM_MAX, parseHeif, tiffOfExifItem } from "@/lib/scan/heif-meta";

export interface ImageMeta {
  /** Wall-clock time the picture was taken (UTC terms, see exif.ts), or null when the file doesn't say. */
  takenAt: Date | null;
  width: number | null;
  height: number | null;
}

export const META_WINDOW = 256 * 1024;
const MAX_JPEG_SEGMENTS = 64;
const NO_META: ImageMeta = { takenAt: null, width: null, height: null };

type FetchRange = (start: number, end: number) => Promise<ArrayBuffer>;

const u16be = (b: Uint8Array, o: number) => (b[o] << 8) | b[o + 1];
const u16le = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);
const u32be = (b: Uint8Array, o: number) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const u32le = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const ascii = (b: Uint8Array, o: number, n: number) => String.fromCharCode(...b.subarray(o, o + n));

/** Width and height, turned for orientations 5-8 (the stored picture is on its side). */
function oriented(width: number | null, height: number | null, orientation: number | null): Pick<ImageMeta, "width" | "height"> {
  if (!validDimension(width) || !validDimension(height)) return { width: null, height: null };
  return orientation !== null && orientation >= 5 ? { width: height, height: width } : { width, height };
}

/** The first EXIF TIFF block and the first frame header of a JPEG. */
function walkJpeg(b: Uint8Array): { tiff: Uint8Array | null; sof: { width: number; height: number } | null } {
  let tiff: Uint8Array | null = null;
  let sof: { width: number; height: number } | null = null;
  let o = 2; // past SOI
  for (let segments = 0; segments < MAX_JPEG_SEGMENTS && o + 4 <= b.length; segments++) {
    if (b[o] !== 0xff) break;
    while (b[o] === 0xff && o + 1 < b.length) o++; // fill bytes
    const marker = b[o++];
    if (marker === 0xd9 || marker === 0xda) break; // end of image / start of the compressed data: nothing useful after
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue; // markers without a length
    if (o + 2 > b.length) break;
    const length = u16be(b, o);
    if (length < 2 || o + length > b.length) break; // bogus, or reaches past what we read
    const body = o + 2;
    const bodyLength = length - 2;
    if (marker === 0xe1 && tiff === null && bodyLength > 6 && ascii(b, body, 6) === "Exif\0\0") {
      tiff = b.subarray(body + 6, body + bodyLength);
    } else if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc && sof === null && bodyLength >= 6) {
      sof = { height: u16be(b, body + 1), width: u16be(b, body + 3) };
    }
    if (tiff && sof) break;
    o += length;
  }
  return { tiff, sof };
}

function jpegMeta(b: Uint8Array): ImageMeta {
  const { tiff, sof } = walkJpeg(b);
  const exif = tiff ? parseExif(tiff) : null;
  const w = sof?.width ?? exif?.width ?? null;
  const h = sof?.height ?? exif?.height ?? null;
  return { takenAt: exif?.takenAt ?? null, ...oriented(w, h, exif?.orientation ?? null) };
}

function pngMeta(b: Uint8Array): ImageMeta {
  // 8-byte signature, then the IHDR chunk: length 13, "IHDR", width, height.
  if (b.length < 24 || u32be(b, 8) !== 13 || ascii(b, 12, 4) !== "IHDR") return NO_META;
  return { takenAt: null, ...oriented(u32be(b, 16), u32be(b, 20), null) };
}

function gifMeta(b: Uint8Array): ImageMeta {
  if (b.length < 10) return NO_META;
  return { takenAt: null, ...oriented(u16le(b, 6), u16le(b, 8), null) };
}

function webpMeta(b: Uint8Array): ImageMeta {
  if (b.length < 25) return NO_META; // the smallest header we read (a lossless 1x1 picture is about 26 bytes)
  const chunk = ascii(b, 12, 4);
  if (chunk === "VP8 ") {
    if (b.length < 30) return NO_META;
    // 3-byte frame tag, the start code 9d 01 2a, then two 14-bit sizes.
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return NO_META;
    return { takenAt: null, ...oriented(u16le(b, 26) & 0x3fff, u16le(b, 28) & 0x3fff, null) };
  }
  if (chunk === "VP8L") {
    if (b[20] !== 0x2f) return NO_META;
    const bits = u32le(b, 21);
    return { takenAt: null, ...oriented((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1, null) };
  }
  if (chunk === "VP8X") {
    if (b.length < 30) return NO_META;
    const w = (b[24] | (b[25] << 8) | (b[26] << 16)) + 1;
    const h = (b[27] | (b[28] << 8) | (b[29] << 16)) + 1;
    return { takenAt: null, ...oriented(w, h, null) };
  }
  return NO_META;
}

async function heicMeta(b: Uint8Array, fetchRange: FetchRange, size: number): Promise<ImageMeta> {
  const info = parseHeif(b);
  let takenAt: Date | null = null;
  if (info.exif && info.exif.offset + info.exif.length <= size) {
    const { offset, length } = info.exif;
    // Usually just beyond what we read; ask for exactly the block (bounded at parse time).
    const item =
      offset + length <= b.length
        ? b.subarray(offset, offset + length)
        : new Uint8Array(await fetchRange(offset, offset + Math.min(length, EXIF_ITEM_MAX) - 1));
    const tiff = tiffOfExifItem(item);
    if (tiff) takenAt = parseExif(tiff).takenAt;
  }
  // A HEIC's rotation lives in its own `irot` (already applied by parseHeif); its EXIF orientation is not applied again.
  return { takenAt, ...oriented(info.width, info.height, null) };
}

/** Reads what the file says about itself. Returns nothing-known (never throws) for an unreadable or unrecognised file. */
export async function readImageMeta(fetchRange: FetchRange, size: number): Promise<ImageMeta> {
  try {
    if (!Number.isFinite(size) || size < 12) return NO_META;
    const b = new Uint8Array(await fetchRange(0, Math.min(size, META_WINDOW) - 1));
    if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return jpegMeta(b);
    if (b.length >= 8 && b[0] === 0x89 && ascii(b, 1, 3) === "PNG") return pngMeta(b);
    if (b.length >= 6 && ascii(b, 0, 4) === "GIF8") return gifMeta(b);
    if (b.length >= 12 && ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "WEBP") return webpMeta(b);
    if (b.length >= 12 && ascii(b, 4, 4) === "ftyp") return await heicMeta(b, fetchRange, size);
    return NO_META;
  } catch {
    return NO_META;
  }
}
