import { describe, expect, it } from "vitest";
import { parseExif, parseExifDate } from "./exif";
import { readImageMeta, META_WINDOW } from "./image-meta";
import { buildGif, buildHeic, buildJpeg, buildPng, buildTiff, buildWebp, rangeOfBytes } from "./test-images";

const meta = (bytes: Uint8Array) => readImageMeta(rangeOfBytes(bytes), bytes.length);
const NOON = new Date("2019-05-06T07:08:09Z");

describe("parseExifDate", () => {
  it("reads a real EXIF time as wall-clock UTC, with no zone shift", () => {
    expect(parseExifDate("2019:05:06 07:08:09")).toEqual(NOON);
    expect(parseExifDate("2019:05:06 07:08:09\0")).toEqual(NOON);
    expect(parseExifDate("2019-05-06 07:08:09")).toEqual(NOON);
    expect(parseExifDate("2024:12:31 23:59:59")?.toISOString()).toBe("2024-12-31T23:59:59.000Z");
  });
  it("refuses everything that isn't a real moment", () => {
    for (const bad of ["", "0000:00:00 00:00:00", "2019:13:01 00:00:00", "2019:02:30 10:00:00", "2019:02:29 10:00:00", "2019:05:06 24:00:00", "2019:05:06 07:60:00", "2019:05:06 07:08:60", "2019:05:06", "2019:05:06T07:08:09", "  2019:05:06 07:08:09", "1825:01:01 00:00:00", "2019:05:06 07:08:09 extra", "abcd:ef:gh ij:kl:mn", "2019:5:6 7:8:9", "２０１９:05:06 07:08:09"]) {
      expect(parseExifDate(bad), JSON.stringify(bad)).toBeNull();
    }
    expect(parseExifDate("2020:02:29 10:00:00")?.toISOString()).toBe("2020-02-29T10:00:00.000Z"); // a real leap day
  });
  it("refuses a time far in the future (a camera with a broken clock) but allows a day of slack", () => {
    const now = Date.UTC(2026, 9, 5, 12);
    expect(parseExifDate("2030:01:01 00:00:00", now)).toBeNull();
    expect(parseExifDate("2026:10:06 10:00:00", now)).not.toBeNull();
  });
});

describe("parseExif", () => {
  it("reads little- and big-endian TIFF alike: the three dates, orientation and pixel size", () => {
    for (const little of [true, false]) {
      const t = Uint8Array.from(buildTiff({ little, orientation: 6, dateTimeOriginal: "2019:05:06 07:08:09", dateTime: "2020:01:01 00:00:00", pixelX: 4000, pixelY: 3000 }));
      expect(parseExif(t), String(little)).toEqual({ takenAt: NOON, orientation: 6, width: 4000, height: 3000 });
    }
  });
  it("prefers the shutter time, then the digitized time, then the file-written time; nothing when none is a real date", () => {
    const a = parseExif(Uint8Array.from(buildTiff({ dateTimeOriginal: "2019:05:06 07:08:09", dateTimeDigitized: "2018:01:01 01:01:01", dateTime: "2020:01:01 00:00:00" })));
    expect(a.takenAt).toEqual(NOON);
    const b = parseExif(Uint8Array.from(buildTiff({ dateTimeOriginal: "0000:00:00 00:00:00", dateTimeDigitized: "2018:01:01 01:01:01", dateTime: "2020:01:01 00:00:00" })));
    expect(b.takenAt?.toISOString()).toBe("2018-01-01T01:01:01.000Z");
    const c = parseExif(Uint8Array.from(buildTiff({ dateTime: "2020:01:01 00:00:00" })));
    expect(c.takenAt?.toISOString()).toBe("2020-01-01T00:00:00.000Z");
    expect(parseExif(Uint8Array.from(buildTiff({ dateTimeOriginal: "garbage", dateTime: "also garbage" }))).takenAt).toBeNull();
  });
  it("treats an out-of-range orientation or a zero/huge size as unknown", () => {
    expect(parseExif(Uint8Array.from(buildTiff({ orientation: 0 }))).orientation).toBeNull();
    expect(parseExif(Uint8Array.from(buildTiff({ orientation: 9 }))).orientation).toBeNull();
    const t = parseExif(Uint8Array.from(buildTiff({ pixelX: 0, pixelY: 4_000_000_000 })));
    expect([t.width, t.height]).toEqual([null, null]);
  });
});

describe("hostile TIFF", () => {
  const nothing = { takenAt: null, orientation: null, width: null, height: null };
  it("never throws on empty, tiny, wrong-magic or wrong-version data", () => {
    for (const bytes of [[], [0x49], [0x49, 0x49, 42, 0], [0x49, 0x49, 42, 0, 8, 0, 0, 0], [1, 2, 3, 4, 5, 6, 7, 8, 9], [0x49, 0x49, 43, 0, 8, 0, 0, 0, 0, 0]]) {
      expect(parseExif(Uint8Array.from(bytes)), JSON.stringify(bytes)).toEqual(nothing);
    }
  });
  it("ignores an IFD offset pointing outside the data, before the header, or onto itself", () => {
    for (const offset of [0, 4, 7, 0xffffffff, 100000]) {
      const t = buildTiff({ orientation: 1 });
      t.splice(4, 4, offset & 255, (offset >>> 8) & 255, (offset >>> 16) & 255, (offset >>> 24) & 255);
      expect(parseExif(Uint8Array.from(t)).orientation, String(offset)).toBeNull();
    }
  });
  it("only looks at the first 512 entries of a directory", () => {
    const junk = Array.from({ length: 600 }, () => ({ tag: 1, type: 4, count: 1, value: 7 }));
    expect(parseExif(Uint8Array.from(buildTiff({ rawIfd0: junk, orientation: 3 }))).orientation).toBeNull(); // 601 entries: the orientation is past the cap
    expect(parseExif(Uint8Array.from(buildTiff({ rawIfd0: junk.slice(0, 100), orientation: 3 }))).orientation).toBe(3);
  });
  it("caps a directory that claims 65,535 entries to what is really there", () => {
    const t = buildTiff({ orientation: 3 });
    t[8] = 0xff;
    t[9] = 0xff;
    expect(() => parseExif(Uint8Array.from(t))).not.toThrow();
  });
  it("skips a value that points outside the data, and a Exif-IFD pointer back at IFD0 (no loop)", () => {
    const outside = buildTiff({ rawIfd0: [{ tag: 0x0132, type: 2, count: 20, value: 0x7fffffff }] });
    expect(parseExif(Uint8Array.from(outside)).takenAt).toBeNull();
    const loop = buildTiff({ dateTimeOriginal: "2019:05:06 07:08:09", orientation: 1 });
    // point the Exif IFD pointer (tag 0x8769, in IFD0) back at IFD0 itself
    const at = loop.findIndex((_, i) => loop[i] === 0x69 && loop[i + 1] === 0x87);
    loop.splice(at + 8, 4, 8, 0, 0, 0);
    expect(() => parseExif(Uint8Array.from(loop))).not.toThrow();
  });
  it("survives random corruption of a valid block (seeded fuzz): never throws, only returns valid values", () => {
    const base = buildTiff({ orientation: 6, dateTimeOriginal: "2019:05:06 07:08:09", dateTime: "2020:01:01 00:00:00", pixelX: 4000, pixelY: 3000 });
    let seed = 12345;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let i = 0; i < 3000; i++) {
      const t = base.slice(0, 1 + Math.floor(rnd() * base.length));
      for (let k = 0; k < 1 + Math.floor(rnd() * 6); k++) t[Math.floor(rnd() * t.length)] = Math.floor(rnd() * 256);
      const r = parseExif(Uint8Array.from(t));
      if (r.takenAt) expect(Number.isFinite(r.takenAt.getTime())).toBe(true);
      if (r.orientation !== null) expect(r.orientation >= 1 && r.orientation <= 8).toBe(true);
      for (const d of [r.width, r.height]) if (d !== null) expect(d >= 1 && d <= 1_000_000).toBe(true);
    }
  });
});

describe("JPEG", () => {
  it("reads the taken time and the frame size", async () => {
    const jpeg = buildJpeg({ width: 4000, height: 3000, tiff: buildTiff({ dateTimeOriginal: "2019:05:06 07:08:09" }) });
    expect(await meta(jpeg)).toEqual({ takenAt: NOON, width: 4000, height: 3000 });
  });
  it("turns the size for a photo stored on its side (orientation 5-8), and not for 1-4", async () => {
    for (const [o, swapped] of [[1, false], [3, false], [4, false], [5, true], [6, true], [7, true], [8, true]] as const) {
      const m = await meta(buildJpeg({ width: 4000, height: 3000, tiff: buildTiff({ orientation: o }) }));
      expect([m.width, m.height], String(o)).toEqual(swapped ? [3000, 4000] : [4000, 3000]);
    }
  });
  it("finds the size of a progressive JPEG, and a JPEG with no EXIF at all", async () => {
    expect(await meta(buildJpeg({ width: 640, height: 480, progressive: true }))).toEqual({ takenAt: null, width: 640, height: 480 });
  });
  it("gets past other segments before the EXIF (an ICC profile and XMP)", async () => {
    const seg = (marker: number, body: number[]) => [0xff, marker, (body.length + 2) >> 8, (body.length + 2) & 255, ...body];
    const icc = seg(0xe2, new Array(300).fill(7));
    const xmp = seg(0xe1, [...Array.from("http://ns.adobe.com/xap/1.0/\0").map((c) => c.charCodeAt(0)), 60, 61, 62]);
    const m = await meta(buildJpeg({ before: [icc, xmp], tiff: buildTiff({ dateTimeOriginal: "2019:05:06 07:08:09" }) }));
    expect(m.takenAt).toEqual(NOON);
  });
  it("copes with fill bytes (0xFF padding) between segments, markers without a length, truncation, and a bogus segment length", async () => {
    const good = buildJpeg({ width: 100, height: 50, tiff: buildTiff({ dateTimeOriginal: "2019:05:06 07:08:09" }) });
    const padded = Uint8Array.from([0xff, 0xd8, 0xff, 0xff, 0xff, 0x01, ...good.slice(2)]);
    expect((await meta(padded)).takenAt).toEqual(NOON);
    expect((await meta(good.slice(0, 40))).takenAt).toBeNull();
    for (const bad of [0, 1, 0xffff]) {
      const broken = good.slice();
      broken[4] = bad >> 8;
      broken[5] = bad & 255; // the APP0's own length
      await expect(meta(broken)).resolves.toBeDefined();
    }
  });
  it("never reads more than one 256 KiB window of a JPEG, and ignores an Exif block that lies beyond it", async () => {
    const filler = [0xff, 0xe2, 0xff, 0xff, ...new Array(0xfffd).fill(0)];
    const jpeg = buildJpeg({ width: 10, height: 10, before: [filler, filler, filler, filler, filler], tiff: buildTiff({ dateTimeOriginal: "2019:05:06 07:08:09" }) });
    expect(jpeg.length).toBeGreaterThan(META_WINDOW);
    let largest = 0;
    const spy = async (s: number, e: number) => ((largest = Math.max(largest, e - s + 1)), rangeOfBytes(jpeg)(s, e));
    const m = await readImageMeta(spy, jpeg.length);
    expect(largest).toBeLessThanOrEqual(META_WINDOW);
    expect(m.takenAt).toBeNull();
  });
});

describe("PNG, GIF and WebP", () => {
  it("read their sizes from the header, and report no taken time", async () => {
    expect(await meta(buildPng(1920, 1080))).toEqual({ takenAt: null, width: 1920, height: 1080 });
    expect(await meta(buildGif(320, 200))).toEqual({ takenAt: null, width: 320, height: 200 });
    expect(await meta(buildWebp("VP8 ", 800, 600))).toEqual({ takenAt: null, width: 800, height: 600 });
    expect(await meta(buildWebp("VP8L", 801, 601))).toEqual({ takenAt: null, width: 801, height: 601 });
    expect(await meta(buildWebp("VP8X", 4000, 3000))).toEqual({ takenAt: null, width: 4000, height: 3000 });
  });
  it("treat zero and absurd sizes as unknown", async () => {
    expect(await meta(buildPng(0, 100))).toEqual({ takenAt: null, width: null, height: null });
    expect(await meta(buildPng(4_000_000_000, 100))).toEqual({ takenAt: null, width: null, height: null });
    expect(await meta(buildGif(0, 0))).toEqual({ takenAt: null, width: null, height: null });
  });
});

describe("unrecognised and unreadable files", () => {
  it("give nothing, whatever the extension claimed", async () => {
    const none = { takenAt: null, width: null, height: null };
    for (const bytes of [new Uint8Array(100), Uint8Array.from(Array.from("this is a text file, not a picture").map((c) => c.charCodeAt(0))), new Uint8Array(3), new Uint8Array(0)]) {
      expect(await meta(bytes)).toEqual(none);
    }
    expect(await readImageMeta(async () => { throw new Error("network"); }, 5000)).toEqual(none);
    expect(await readImageMeta(rangeOfBytes(buildPng(1, 1)), Number.NaN)).toEqual(none);
  });
  it("go by the real format, not the name: a PNG is read as a PNG wherever it is", async () => {
    expect(await meta(buildPng(10, 20))).toMatchObject({ width: 10, height: 20 });
  });
});

describe("HEIC", () => {
  it("reads the picture size and the taken time from the EXIF item, when it sits right after the boxes", async () => {
    const heic = buildHeic({ width: 4032, height: 3024, tiff: buildTiff({ dateTimeOriginal: "2019:05:06 07:08:09" }) });
    expect(await meta(heic)).toEqual({ takenAt: NOON, width: 4032, height: 3024 });
  });
  it("fetches the EXIF item with one extra small read when it lies beyond the first window", async () => {
    const heic = buildHeic({ tiff: buildTiff({ dateTimeOriginal: "2019:05:06 07:08:09" }), gap: META_WINDOW + 1000 });
    const reads: [number, number][] = [];
    const m = await readImageMeta(async (s, e) => (reads.push([s, e]), rangeOfBytes(heic)(s, e)), heic.length);
    expect(m.takenAt).toEqual(NOON);
    expect(reads).toHaveLength(2);
    expect(reads[1][1] - reads[1][0] + 1).toBeLessThan(1024);
  });
  it("turns the size by the picture's own rotation (irot), and uses the PRIMARY item's size, not a tile's", async () => {
    expect(await meta(buildHeic({ width: 4032, height: 3024, rotate: 1 }))).toMatchObject({ width: 3024, height: 4032 });
    expect(await meta(buildHeic({ width: 4032, height: 3024, rotate: 2 }))).toMatchObject({ width: 4032, height: 3024 });
    expect(await meta(buildHeic({ width: 4032, height: 3024, rotate: 3, decoyTile: true }))).toMatchObject({ width: 3024, height: 4032 });
  });
  it("has no taken time without an EXIF item, and still gives the size", async () => {
    expect(await meta(buildHeic({ width: 100, height: 80 }))).toEqual({ takenAt: null, width: 100, height: 80 });
  });
});

describe("hostile HEIC", () => {
  const tiff = buildTiff({ dateTimeOriginal: "2019:05:06 07:08:09" });
  const good = () => buildHeic({ width: 4032, height: 3024, tiff });
  const none = { takenAt: null, width: null, height: null };
  const patch = (bytes: Uint8Array, at: number, values: number[]) => {
    const copy = bytes.slice();
    copy.set(values, at);
    return copy;
  };
  const find = (bytes: Uint8Array, type: string) => {
    const t = Array.from(type).map((c) => c.charCodeAt(0));
    for (let i = 0; i + 4 <= bytes.length; i++) if (t.every((c, k) => bytes[i + k] === c)) return i;
    throw new Error(`no ${type}`);
  };

  it("the good fixture reads fully", async () => {
    expect(await meta(good())).toEqual({ takenAt: NOON, width: 4032, height: 3024 });
  });

  it("refuses a file whose brands aren't HEIF, or that has no meta box", async () => {
    const h = good();
    const avif = Array.from("avif").map((c) => c.charCodeAt(0));
    const ftyp = find(h, "ftyp");
    // the major brand AND both compatible brands say avif: not a HEIF Roam shows
    expect(await meta(patch(patch(patch(h, ftyp + 4, avif), ftyp + 12, avif), ftyp + 16, avif))).toEqual(none);
    // a file that is compatible with heic is accepted even when its major brand is something else
    expect(await meta(patch(h, ftyp + 4, avif))).toMatchObject({ width: 4032 });
    const noMeta = patch(h, find(h, "meta"), Array.from("junk").map((c) => c.charCodeAt(0)));
    expect(await meta(noMeta)).toEqual(none);
  });

  it("survives impossible box sizes: zero, one (64-bit), enormous, and smaller than a header", async () => {
    const h = good();
    const at = find(h, "meta") - 4; // the meta box's size field
    for (const size of [[0, 0, 0, 0], [0, 0, 0, 1], [0xff, 0xff, 0xff, 0xff], [0, 0, 0, 4], [0, 0, 0, 8]]) {
      await expect(meta(patch(h, at, size)), JSON.stringify(size)).resolves.toBeDefined();
    }
  });

  it("survives an item count of 4 billion in iloc and ipma (loops are bounded and checked against the bytes)", async () => {
    const h = good();
    const iloc = find(h, "iloc") + 4 + 4 + 2; // after type, version/flags, the two size bytes
    const bad = patch(h, iloc, [0xff, 0xff]);
    const started = Date.now();
    await expect(meta(bad)).resolves.toBeDefined();
    const ipma = find(h, "ipma") + 4 + 4;
    await expect(meta(patch(h, ipma, [0xff, 0xff, 0xff, 0xff]))).resolves.toBeDefined();
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("ignores an EXIF item whose extent runs past the end of the file, or is stored somewhere other than the file", async () => {
    const h = good();
    const iloc = find(h, "iloc");
    // item 2's extent length (the last 4 bytes of the iloc box) set to something that can't fit
    const lengthAt = iloc - 4 + new DataView(h.buffer).getUint32(iloc - 4) - 4;
    const past = patch(h, lengthAt, [0, 0, 0x80, 0]);
    expect((await meta(past)).takenAt).toBeNull();
    expect((await meta(past)).width).toBe(4032); // the size still reads
    // construction method 1 (data inside the meta box) is not followed: needs iloc version 1, which we simulate by bumping the version
    const v1 = patch(h, iloc + 4, [1]);
    await expect(meta(v1)).resolves.toBeDefined();
  });

  it("only follows an Exif item stored in the file itself, and a skip count within bounds", async () => {
    const inFile = await meta(buildHeic({ tiff, constructionMethod: 0 }));
    expect(inFile.takenAt).toEqual(NOON); // iloc version 1 with the normal method still works
    expect((await meta(buildHeic({ tiff, constructionMethod: 1 }))).takenAt).toBeNull(); // data "inside meta": not followed
    expect((await meta(buildHeic({ tiff, exifSkip: 6 }))).takenAt).toEqual(NOON);
    expect((await meta(buildHeic({ tiff, exifSkip: 2000 }))).takenAt).toBeNull(); // a TIFF header 2000 bytes in is not trusted
    expect((await meta(buildHeic({ tiff, exifSkip: 2000 }))).width).toBe(4032);
  });

  it("does not read an enormous EXIF item (the block is capped before it is fetched)", async () => {
    const h = good();
    const iloc = find(h, "iloc");
    const lengthAt = iloc - 4 + new DataView(h.buffer).getUint32(iloc - 4) - 4;
    const huge = patch(h, lengthAt, [0x10, 0, 0, 0]); // 256 MiB
    let largest = 0;
    const m = await readImageMeta(async (s, e) => ((largest = Math.max(largest, e - s + 1)), rangeOfBytes(huge)(s, e)), 300 * 1024 * 1024);
    expect(largest).toBeLessThanOrEqual(META_WINDOW);
    expect(m.takenAt).toBeNull();
  });

  it("survives random corruption and truncation (seeded fuzz): never throws, stays quick, only valid values", async () => {
    const base = good();
    let seed = 987;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const started = Date.now();
    for (let i = 0; i < 2500; i++) {
      const t = base.slice(0, 12 + Math.floor(rnd() * (base.length - 12)));
      for (let k = 0; k < 1 + Math.floor(rnd() * 8); k++) t[Math.floor(rnd() * t.length)] = Math.floor(rnd() * 256);
      const m = await readImageMeta(rangeOfBytes(t), t.length + (rnd() < 0.2 ? 5000 : 0));
      if (m.takenAt) expect(Number.isFinite(m.takenAt.getTime())).toBe(true);
      for (const d of [m.width, m.height]) if (d !== null) expect(d >= 1 && d <= 1_000_000).toBe(true);
    }
    expect(Date.now() - started).toBeLessThan(15_000);
  });

  it("survives random corruption of JPEG, PNG, GIF and WebP headers too", async () => {
    const bases = [buildJpeg({ tiff: buildTiff({ orientation: 6, dateTimeOriginal: "2019:05:06 07:08:09", pixelX: 400, pixelY: 300 }) }), buildPng(100, 100), buildGif(100, 100), buildWebp("VP8X", 100, 100), buildWebp("VP8L", 100, 100)];
    let seed = 4242;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let i = 0; i < 4000; i++) {
      const base = bases[i % bases.length];
      const t = base.slice(0, 1 + Math.floor(rnd() * base.length));
      for (let k = 0; k < 1 + Math.floor(rnd() * 5); k++) t[Math.floor(rnd() * t.length)] = Math.floor(rnd() * 256);
      const m = await readImageMeta(rangeOfBytes(t), t.length);
      for (const d of [m.width, m.height]) if (d !== null) expect(d >= 1 && d <= 1_000_000).toBe(true);
    }
  });
});
