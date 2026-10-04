import { describe, expect, it } from "vitest";
import { probeMp4Tags } from "./mp4-duration";

// Minimal ISO BMFF builders (see mp4-duration.test.ts): real bytes through the real parser.
const u32be = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
const u16be = (n: number) => [(n >>> 8) & 0xff, n & 0xff];
const fourcc = (s: string) => Array.from(s).map((c) => c.charCodeAt(0)); // © is 0xA9, a single byte here
const box = (type: string, payload: number[]) => [...u32be(8 + payload.length), ...fourcc(type), ...payload];
const utf8 = (s: string) => Array.from(new TextEncoder().encode(s));
const FTYP = box("ftyp", [...fourcc("isom"), ...u32be(0), ...fourcc("isom")]);
const MVHD = box("mvhd", [0, 0, 0, 0, ...u32be(0), ...u32be(0), ...u32be(1000), ...u32be(60_000), ...new Array(80).fill(0)]);

const JPEG = [0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9];
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9, 9];

/** An `ilst` item's `data` box: u8 version, u24 type flags, u32 locale, then the value. */
const data = (flags: number, value: number[]) => box("data", [0, (flags >> 16) & 0xff, (flags >> 8) & 0xff, flags & 0xff, ...u32be(0), ...value]);
const textItem = (name: string, text: string) => box(name === "desc" || name === "ldes" ? name : "©" + name, data(1, utf8(text)));
const HDLR = box("hdlr", [0, 0, 0, 0, ...u32be(0), ...fourcc("mdir"), ...new Array(12).fill(0), 0]);
/** ISO `meta`: a full box (4 bytes of version/flags) holding hdlr then ilst. */
const isoMeta = (...items: number[][]) => box("meta", [0, 0, 0, 0, ...HDLR, ...box("ilst", items.flat())]);
/** QuickTime `meta`: no version/flags, hdlr first. */
const qtMeta = (...items: number[][]) => box("meta", [...HDLR, ...box("ilst", items.flat())]);

function fetcher(bytes: number[]) {
  return async (start: number, end: number): Promise<ArrayBuffer> => {
    const out = new Uint8Array(end - start + 1);
    for (let i = start; i <= Math.min(end, bytes.length - 1); i++) out[i - start] = bytes[i];
    return out.buffer;
  };
}
const probe = (bytes: number[]) => probeMp4Tags(fetcher(bytes), bytes.length);
const file = (...moovChildren: number[][]) => [...FTYP, ...box("moov", [...MVHD, ...moovChildren.flat()])];

describe("probeMp4Tags", () => {
  it("reads title, year, description and cover from an iTunes-style file", async () => {
    const bytes = file(
      box("udta", isoMeta(textItem("nam", "Beach Day"), textItem("day", "2019-07-04T10:00:00Z"), textItem("desc", "Waves and sand."), box("covr", data(13, JPEG))))
    );
    const tags = await probe(bytes);
    expect(tags).toMatchObject({ title: "Beach Day", year: 2019, description: "Waves and sand." });
    expect(tags.cover?.contentType).toBe("image/jpeg");
    expect(Array.from(tags.cover!.bytes)).toEqual(JPEG);
  });

  it("reads artist and album, falling back to the album artist, from iTunes and QuickTime layouts", async () => {
    const ilst = await probe(file(box("udta", isoMeta(textItem("nam", "Track"), textItem("ART", "Track Artist"), textItem("alb", "The Album")))));
    expect(ilst).toMatchObject({ title: "Track", artist: "Track Artist", album: "The Album" });
    const albumArtistOnly = await probe(file(box("udta", isoMeta(box("aART", data(1, utf8("Album Artist")))))));
    expect(albumArtistOnly.artist).toBe("Album Artist");
    const both = await probe(file(box("udta", isoMeta(box("aART", data(1, utf8("Album Artist"))), textItem("ART", "Track Artist")))));
    expect(both.artist).toBe("Track Artist"); // the track artist wins even though the album artist came first
    const textAtom = (name: string, text: string) => box("\u00a9" + name, [...u16be(utf8(text).length), ...u16be(0), ...utf8(text)]);
    const qt = await probe(file(box("udta", [...textAtom("ART", "QT Artist"), ...textAtom("alb", "QT Album")].flat())));
    expect(qt).toMatchObject({ artist: "QT Artist", album: "QT Album" });
  });

  it("reads the QuickTime layout: © atoms directly in udta, and a meta box without version bytes", async () => {
    const textAtom = (name: string, text: string) => box("©" + name, [...u16be(utf8(text).length), ...u16be(0), ...utf8(text)]);
    const direct = await probe(file(box("udta", [...textAtom("nam", "Old Movie"), ...textAtom("day", "1987")].flat())));
    expect(direct).toMatchObject({ title: "Old Movie", year: 1987, description: null, cover: null });

    const qt = await probe(file(box("udta", qtMeta(textItem("nam", "QuickTime Style"), box("covr", data(14, PNG))))));
    expect(qt.title).toBe("QuickTime Style");
    expect(qt.cover?.contentType).toBe("image/png");
  });

  it("finds tags in a meta box sitting directly under moov, and falls back to the long description", async () => {
    const tags = await probe(file(isoMeta(textItem("nam", "Direct"), textItem("ldes", "The long one."))));
    expect(tags).toMatchObject({ title: "Direct", description: "The long one." });
  });

  it("takes the first valid cover when there are several, skipping broken ones", async () => {
    const tags = await probe(file(box("udta", isoMeta(box("covr", [...data(13, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), ...data(14, PNG), ...data(13, JPEG)])))));
    expect(tags.cover?.contentType).toBe("image/png");
  });

  it("ignores a cover that is too large, or whose bytes aren't a JPEG or PNG, but keeps the text", async () => {
    const huge = [0xff, 0xd8, 0xff, ...new Array(300 * 1024).fill(7)];
    const big = await probe(file(box("udta", isoMeta(textItem("nam", "Big Cover"), box("covr", data(13, huge))))));
    expect(big).toMatchObject({ title: "Big Cover", cover: null });
    const fake = await probe(file(box("udta", isoMeta(textItem("nam", "Fake"), box("covr", data(13, utf8("<html>not an image</html>")))))));
    expect(fake).toMatchObject({ title: "Fake", cover: null });
  });

  it("returns all nulls for a file with no tags", async () => {
    expect(await probe(file())).toEqual({ title: null, artist: null, album: null, year: null, description: null, cover: null });
    expect(await probe(file(box("udta", [])))).toEqual({ title: null, artist: null, album: null, year: null, description: null, cover: null });
  });

  it("keeps what it read before a malformed section instead of failing", async () => {
    const truncatedItem = [...u32be(5000), ...fourcc("desc"), 1, 2, 3]; // claims 5000 bytes, has 3
    const tags = await probe(file(box("udta", isoMeta(textItem("nam", "Survives"), truncatedItem))));
    expect(tags.title).toBe("Survives");
  });

  it("finds tags when moov is at the end of the file (after a large mdat)", async () => {
    const mdat = box("mdat", new Array(50_000).fill(0));
    const moov = box("moov", [...MVHD, ...box("udta", isoMeta(textItem("nam", "Moov At End")))]);
    expect((await probe([...FTYP, ...mdat, ...moov])).title).toBe("Moov At End");
  });

  it("cleans text: control characters, runs of whitespace, empty values, absurd years and length", async () => {
    const tags = await probe(file(box("udta", isoMeta(textItem("nam", "  Line\u0000one\n\ntwo   three  "), textItem("day", "1066"), textItem("desc", "x".repeat(5000))))));
    expect(tags.title).toBe("Line one two three");
    expect(tags.year).toBeNull();
    expect(tags.description).toHaveLength(2000);
    const blank = await probe(file(box("udta", isoMeta(textItem("nam", "   "), textItem("day", "abcd")))));
    expect(blank).toMatchObject({ title: null, year: null });
  });

  it("a file that claims enormous tags never makes it read more than a small window", async () => {
    // Every box on the path to the tags claims to run to the end of a 50 MB file. A 60 KB filler atom puts the
    // description text at the far end of the reader's 64 KB window, so reading it needs a fresh fetch: the
    // moment an unbounded prefetch would go to the network.
    const FILE_SIZE = 50_000_000;
    const huge = (type: string, payload: number[], start: number) => [...u32be(FILE_SIZE - start), ...fourcc(type), ...payload];
    const ftypLen = FTYP.length;
    const moovStart = ftypLen;
    const real = [
      ...FTYP,
      ...huge("moov", [
        ...MVHD,
        ...huge("udta", [
          // meta is a full box (4 bytes of version/flags), then hdlr and an ilst whose first atom is a huge `desc`.
          ...huge("meta", [0, 0, 0, 0, ...HDLR, ...huge("ilst", [...box("zzzz", new Array(60_000).fill(0)), ...huge("desc", [...huge("data", [0, 0, 0, 1, ...u32be(0), ...utf8("A description that never ends")], 0)], 0)], 0)], 0),
        ], 0),
      ], moovStart),
    ];
    const requested: number[] = [];
    const tags = await probeMp4Tags(async (start, end) => {
      requested.push(end - start + 1);
      const out = new Uint8Array(end - start + 1);
      for (let i = start; i <= Math.min(end, real.length - 1); i++) out[i - start] = real[i];
      return out.buffer;
    }, FILE_SIZE);
    expect(Math.max(...requested)).toBeLessThanOrEqual(70 * 1024); // no single read near the declared size
    expect(requested.reduce((a, b) => a + b, 0)).toBeLessThan(1024 * 1024); // nor many of them adding up
    expect(typeof tags.description === "string" || tags.description === null).toBe(true);
  });

  it("throws only when there is no moov at all", async () => {
    await expect(probe([...FTYP])).rejects.toThrow();
  });
});
