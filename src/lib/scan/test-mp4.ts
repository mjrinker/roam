/** Builds small but real MP4 files (with tags) for tests, so parsing runs against real bytes. Not used by app code. */
const u32be = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
const fourcc = (s: string) => Array.from(s).map((c) => c.charCodeAt(0));
const box = (type: string, payload: number[]) => [...u32be(8 + payload.length), ...fourcc(type), ...payload];
const utf8 = (s: string) => Array.from(new TextEncoder().encode(s));
const data = (flags: number, value: number[]) => box("data", [0, 0, 0, flags, ...u32be(0), ...value]);

export const TEST_JPEG = [0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9];

export function mp4WithTags(tags: { title?: string; artist?: string; album?: string; year?: string; description?: string; cover?: number[] } = {}): Uint8Array {
  const items = [
    tags.title ? box("©nam", data(1, utf8(tags.title))) : [],
    tags.artist ? box("©ART", data(1, utf8(tags.artist))) : [],
    tags.album ? box("©alb", data(1, utf8(tags.album))) : [],
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

/** A tiny MP3: an ID3v2.3 tag (any of title, artist, album, year, front cover) followed by filler "audio". */
export function mp3WithTags(tags: { title?: string; artist?: string; album?: string; year?: string; cover?: number[] } = {}): Uint8Array {
  const sync = (n: number) => [(n >>> 21) & 0x7f, (n >>> 14) & 0x7f, (n >>> 7) & 0x7f, n & 0x7f];
  const frame = (id: string, body: number[]) => [...fourcc(id), ...u32be(body.length), 0, 0, ...body];
  const text = (v: string) => [3, ...utf8(v)]; // UTF-8
  const frames = [
    tags.title ? frame("TIT2", text(tags.title)) : [],
    tags.artist ? frame("TPE1", text(tags.artist)) : [],
    tags.album ? frame("TALB", text(tags.album)) : [],
    tags.year ? frame("TYER", text(tags.year)) : [],
    tags.cover ? frame("APIC", [0, ...fourcc("image/jpeg").slice(0, 10), 0, 3, 0, ...tags.cover]) : [],
  ].flat();
  const body = frames;
  const tag = body.length ? [...fourcc("ID3").slice(0, 3), 3, 0, 0, ...sync(body.length), ...body] : [];
  return Uint8Array.from([...tag, ...new Array(2000).fill(0xaa)]);
}
