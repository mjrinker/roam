/** Builds small but real MP4 files (with tags) for tests, so parsing runs against real bytes. Not used by app code. */
const u32be = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
const fourcc = (s: string) => Array.from(s).map((c) => c.charCodeAt(0));
const box = (type: string, payload: number[]) => [...u32be(8 + payload.length), ...fourcc(type), ...payload];
const utf8 = (s: string) => Array.from(new TextEncoder().encode(s));
const data = (flags: number, value: number[]) => box("data", [0, 0, 0, flags, ...u32be(0), ...value]);

export const TEST_JPEG = [0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9];

export function mp4WithTags(tags: { title?: string; year?: string; description?: string; cover?: number[] } = {}): Uint8Array {
  const items = [
    tags.title ? box("©nam", data(1, utf8(tags.title))) : [],
    tags.year ? box("©day", data(1, utf8(tags.year))) : [],
    tags.description ? box("desc", data(1, utf8(tags.description))) : [],
    tags.cover ? box("covr", data(13, tags.cover)) : [],
  ].flat();
  const hdlr = box("hdlr", [0, 0, 0, 0, ...u32be(0), ...fourcc("mdir"), ...new Array(12).fill(0), 0]);
  const mvhd = box("mvhd", [0, 0, 0, 0, ...u32be(0), ...u32be(0), ...u32be(1000), ...u32be(60_000), ...new Array(80).fill(0)]);
  const udta = items.length ? box("udta", box("meta", [0, 0, 0, 0, ...hdlr, ...box("ilst", items)])) : [];
  const ftyp = box("ftyp", [...fourcc("isom"), ...u32be(0), ...fourcc("isom")]);
  return Uint8Array.from([...ftyp, ...box("moov", [...mvhd, ...udta])]);
}

/** A byte-range fetcher over `bytes`, the shape providers expose. */
export function rangeOf(bytes: Uint8Array) {
  return async (start: number, end: number): Promise<ArrayBuffer> => {
    const slice = bytes.slice(start, Math.min(end + 1, bytes.length));
    return slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength) as ArrayBuffer;
  };
}
