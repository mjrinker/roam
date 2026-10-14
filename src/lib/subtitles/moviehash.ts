/**
 * OpenSubtitles' file fingerprint: the file's size plus the sum of its first and last 64 KiB read as little-endian 64-bit numbers, modulo
 * 2^64, as 16 hex digits (https://opensubtitles.github.io/oshash/). A subtitle found by this fingerprint was made for this exact file, so
 * its timing lines up. Costs two small range reads; nothing is downloaded.
 */
export const HASH_CHUNK = 64 * 1024;
const MASK = BigInt("0xffffffffffffffff");

type Fetcher = (start: number, end: number) => Promise<ArrayBuffer>;

function sumWords(bytes: Uint8Array): bigint {
  let sum = BigInt(0);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i + 8 <= bytes.byteLength; i += 8) sum += view.getBigUint64(i, true);
  return sum;
}

/** The fingerprint from the file's size and its first and last 64 KiB. */
export function movieHashFromParts(sizeBytes: number, first: Uint8Array, last: Uint8Array): string {
  const hash = (BigInt(sizeBytes) + sumWords(first) + sumWords(last)) & MASK;
  return hash.toString(16).padStart(16, "0");
}

/** The fingerprint of a stored file, or null when it is too small to have one (under 128 KiB). */
export async function computeMovieHash(fetchRange: Fetcher, sizeBytes: number): Promise<string | null> {
  if (sizeBytes < HASH_CHUNK * 2) return null;
  const first = new Uint8Array(await fetchRange(0, HASH_CHUNK - 1));
  const last = new Uint8Array(await fetchRange(sizeBytes - HASH_CHUNK, sizeBytes - 1));
  if (first.byteLength < HASH_CHUNK || last.byteLength < HASH_CHUNK) return null;
  return movieHashFromParts(sizeBytes, first, last);
}
