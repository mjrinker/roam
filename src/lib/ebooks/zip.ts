/**
 * A bounded reader for ZIP files (an EPUB is one), working from byte ranges so a book in Box is never downloaded
 * whole: the end of the file for the directory, then just the entries wanted. Books come from anywhere, so every
 * size is capped, nothing is ever written to disk (an entry's name is only a lookup key, so a name like "../x" can't
 * escape anywhere), decompression is limited to the size the entry may have, and anything unusual (encryption,
 * ZIP64, an unknown compression method) is refused with a ZipError rather than guessed at.
 */
import { inflateRawSync } from "node:zlib";

export type RangeFetcher = (start: number, endInclusive: number) => Promise<ArrayBuffer | Uint8Array>;

export class ZipError extends Error {}

export interface ZipEntry {
  name: string;
  method: 0 | 8;
  compressedSize: number;
  size: number;
  localHeaderOffset: number;
}

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;
const EOCD_MIN = 22;
const MAX_COMMENT = 0xffff;
/** The directory of a real book is a few kilobytes; this is generous. */
export const MAX_DIRECTORY_BYTES = 4 * 1024 * 1024;
export const MAX_ENTRIES = 20_000;
export const MAX_ENTRY_BYTES = 8 * 1024 * 1024;

const bytes = (b: ArrayBuffer | Uint8Array) => (b instanceof Uint8Array ? b : new Uint8Array(b));

export async function readZipDirectory(fetchRange: RangeFetcher, fileSize: number): Promise<Map<string, ZipEntry>> {
  if (!Number.isSafeInteger(fileSize) || fileSize < EOCD_MIN) throw new ZipError("Not a ZIP file.");
  const tailStart = Math.max(0, fileSize - (EOCD_MIN + MAX_COMMENT));
  const tail = bytes(await fetchRange(tailStart, fileSize - 1));
  const view = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);

  let eocd = -1;
  for (let i = tail.length - EOCD_MIN; i >= 0; i--) {
    if (view.getUint32(i, true) === EOCD_SIG) {
      // The comment length must account for exactly the rest of the file, or this is a stray signature inside a comment.
      if (i + EOCD_MIN + view.getUint16(i + 20, true) === tail.length) {
        eocd = i;
        break;
      }
    }
  }
  if (eocd < 0) throw new ZipError("Not a ZIP file.");

  const entryCount = view.getUint16(eocd + 10, true);
  const dirSize = view.getUint32(eocd + 12, true);
  const dirOffset = view.getUint32(eocd + 16, true);
  if (entryCount === 0xffff || dirSize === 0xffffffff || dirOffset === 0xffffffff) throw new ZipError("ZIP64 files are not supported.");
  if (entryCount > MAX_ENTRIES || dirSize > MAX_DIRECTORY_BYTES) throw new ZipError("The ZIP directory is too large.");
  if (dirOffset + dirSize > fileSize) throw new ZipError("The ZIP directory is damaged.");

  const dir = dirSize === 0 ? new Uint8Array(0) : bytes(await fetchRange(dirOffset, dirOffset + dirSize - 1));
  if (dir.length !== dirSize) throw new ZipError("The ZIP directory is damaged.");
  const dv = new DataView(dir.buffer, dir.byteOffset, dir.byteLength);
  const entries = new Map<string, ZipEntry>();
  let at = 0;
  for (let n = 0; n < entryCount; n++) {
    if (at + 46 > dir.length || dv.getUint32(at, true) !== CEN_SIG) throw new ZipError("The ZIP directory is damaged.");
    const flags = dv.getUint16(at + 8, true);
    const method = dv.getUint16(at + 10, true);
    const compressedSize = dv.getUint32(at + 20, true);
    const size = dv.getUint32(at + 24, true);
    const nameLen = dv.getUint16(at + 28, true);
    const extraLen = dv.getUint16(at + 30, true);
    const commentLen = dv.getUint16(at + 32, true);
    const localHeaderOffset = dv.getUint32(at + 42, true);
    if (at + 46 + nameLen + extraLen + commentLen > dir.length) throw new ZipError("The ZIP directory is damaged.");
    const name = new TextDecoder("utf-8").decode(dir.subarray(at + 46, at + 46 + nameLen));
    at += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith("/")) continue; // a folder
    if (flags & 1) throw new ZipError("Encrypted ZIP entries are not supported.");
    if (method !== 0 && method !== 8) throw new ZipError(`Unsupported compression method ${method}.`);
    if (compressedSize === 0xffffffff || size === 0xffffffff) throw new ZipError("ZIP64 files are not supported.");
    if (localHeaderOffset >= fileSize) throw new ZipError("The ZIP directory is damaged.");
    // A repeated name: the first wins (what a reader of the directory in order would pick), so a later duplicate can't replace a real entry.
    if (!entries.has(name)) entries.set(name, { name, method, compressedSize, size, localHeaderOffset });
  }
  return entries;
}

/** One entry's bytes, decompressed. `maxBytes` caps what it may expand to (and so what is read). */
export async function readZipEntry(fetchRange: RangeFetcher, entry: ZipEntry, fileSize: number, maxBytes = MAX_ENTRY_BYTES): Promise<Uint8Array> {
  if (entry.size > maxBytes) throw new ZipError("That ZIP entry is too large.");
  const head = bytes(await fetchRange(entry.localHeaderOffset, Math.min(entry.localHeaderOffset + 29, fileSize - 1)));
  if (head.length < 30) throw new ZipError("The ZIP entry is damaged.");
  const hv = new DataView(head.buffer, head.byteOffset, head.byteLength);
  if (hv.getUint32(0, true) !== LOC_SIG) throw new ZipError("The ZIP entry is damaged.");
  const dataStart = entry.localHeaderOffset + 30 + hv.getUint16(26, true) + hv.getUint16(28, true);
  if (dataStart + entry.compressedSize > fileSize) throw new ZipError("The ZIP entry is damaged.");
  if (entry.compressedSize === 0) {
    if (entry.size !== 0) throw new ZipError("The ZIP entry is damaged.");
    return new Uint8Array(0);
  }
  const raw = bytes(await fetchRange(dataStart, dataStart + entry.compressedSize - 1));
  if (raw.length !== entry.compressedSize) throw new ZipError("The ZIP entry is damaged.");
  let out: Uint8Array;
  if (entry.method === 0) out = raw;
  else {
    try {
      out = inflateRawSync(raw, { maxOutputLength: Math.max(entry.size, 1) });
    } catch {
      throw new ZipError("The ZIP entry could not be decompressed.");
    }
  }
  if (out.length !== entry.size) throw new ZipError("The ZIP entry is damaged.");
  return out;
}
