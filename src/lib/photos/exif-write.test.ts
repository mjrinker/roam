import { describe, expect, it } from "vitest";
import { parseExif } from "@/lib/scan/exif";
import { readImageMeta } from "@/lib/scan/image-meta";
import { buildJpeg as realJpeg, buildTiff as realTiff } from "@/lib/scan/test-images";
import { editJpegExif, setJpegTakenAt } from "./exif-write";

/** A TIFF block with IFD0 (orientation, make, and a pointer to an Exif IFD holding a date unless `date` is null, and a made-up tag 0x927c). */
function tiff(little: boolean, date: string | null): number[] {
  const w16 = (n: number) => (little ? [n & 255, n >> 8] : [n >> 8, n & 255]);
  const w32 = (n: number) => (little ? [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255] : [(n >>> 24) & 255, (n >> 16) & 255, (n >> 8) & 255, n & 255]);
  const ent = (tag: number, type: number, count: number, value: number[]) => [...w16(tag), ...w16(type), ...w32(count), ...value];
  const header = little ? [0x49, 0x49, 0x2a, 0, 8, 0, 0, 0] : [0x4d, 0x4d, 0, 0x2a, 0, 0, 0, 8];
  const makeAt = 8 + 2 + 3 * 12 + 4; // after IFD0
  const make = [...Buffer.from("Cam\0")];
  const exifAt = makeAt + make.length;
  const dateAt = exifAt + 2 + 12 + 4;
  const ifd0 = [...w16(3), ...ent(0x0112, 3, 1, [...w16(6), 0, 0]), ...ent(0x010f, 2, 4, w32(makeAt)), ...ent(0x8769, 4, 1, w32(exifAt)), ...w32(0)];
  const exif = [...w16(1), ...ent(0x9003, 2, 20, w32(dateAt)), ...w32(0)];
  const text = date ? [...Buffer.from(`${date}\0`)] : [];
  if (!date) {
    // an Exif IFD with only an unrelated entry (a made-up one), no date
    return [...header, ...ifd0, ...make, ...w16(1), ...ent(0x927c, 7, 4, [1, 2, 3, 4]), ...w32(0)];
  }
  return [...header, ...ifd0, ...make, ...exif, ...text];
}

function jpeg(exif: number[] | null): Uint8Array {
  const app0 = [0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0];
  const app1 = exif ? [0xff, 0xe1, ((exif.length + 8) >> 8) & 255, (exif.length + 8) & 255, 0x45, 0x78, 0x69, 0x66, 0, 0, ...exif] : [];
  const sof = [0xff, 0xc0, 0, 11, 8, 0, 20, 0, 30, 1, 1, 0x11, 0]; // 30 wide, 20 high
  const scan = [0xff, 0xda, 0, 8, 1, 1, 0, 0, 63, 0, 0x12, 0x34, 0x56, 0xff, 0xd9];
  return Uint8Array.from([0xff, 0xd8, ...app0, ...app1, ...sof, ...scan]);
}

const entryTags = (t: Uint8Array) => {
  const little = t[0] === 0x49;
  const u16 = (o: number) => (little ? t[o] | (t[o + 1] << 8) : (t[o] << 8) | t[o + 1]);
  const u32 = (o: number) => (little ? (t[o] | (t[o + 1] << 8) | (t[o + 2] << 16) | (t[o + 3] << 24)) >>> 0 : ((t[o] << 24) | (t[o + 1] << 16) | (t[o + 2] << 8) | t[o + 3]) >>> 0);
  const ifd0 = u32(4);
  const tags = Array.from({ length: u16(ifd0) }, (_, i) => u16(ifd0 + 2 + i * 12));
  const exifAt = u32(ifd0 + 2 + tags.indexOf(0x8769) * 12 + 8);
  const exifTags = Array.from({ length: u16(exifAt) }, (_, i) => u16(exifAt + 2 + i * 12));
  return { tags, exifTags };
};
const exifOf = (b: Uint8Array) => {
  const at = b.findIndex((v, i) => v === 0xff && b[i + 1] === 0xe1);
  return b.subarray(at + 10, at + 2 + ((b[at + 2] << 8) | b[at + 3]));
};
const NEW = new Date(Date.UTC(2015, 5, 1, 8, 30, 15));
const meta = async (b: Uint8Array) => readImageMeta(async (s, e) => b.slice(s, e + 1).buffer as ArrayBuffer, b.length);

describe("setting the taken date inside a JPEG", () => {
  for (const little of [true, false]) {
    const order = little ? "little-endian" : "big-endian";
    it(`replaces an existing date and keeps the rest of the EXIF (${order})`, async () => {
      const original = jpeg(tiff(little, "2001:02:03 04:05:06"));
      const out = setJpegTakenAt(original, NEW);
      expect((await meta(out)).takenAt?.toISOString()).toBe(NEW.toISOString());
      const t = exifOf(out);
      const info = parseExif(t);
      expect(info.orientation).toBe(6); // still turned the way it was
      expect(entryTags(t).tags).toEqual(expect.arrayContaining([0x010f, 0x0112, 0x0132, 0x8769]));
      expect(Buffer.from(out).includes(Buffer.from("Cam\0"))).toBe(true);
      // the picture itself is byte for byte what it was
      const scan = (b: Uint8Array) => Buffer.from(b).subarray(Buffer.from(b).indexOf(Buffer.from([0xff, 0xc0])));
      expect(scan(out).equals(scan(original))).toBe(true);
    });
    it(`adds a date to EXIF that has none, keeping its other entries (${order})`, async () => {
      const out = setJpegTakenAt(jpeg(tiff(little, null)), NEW);
      expect((await meta(out)).takenAt?.toISOString()).toBe(NEW.toISOString());
      expect(entryTags(exifOf(out)).exifTags).toEqual([0x9003, 0x9004, 0x927c]);
    });
  }
  it("gives a JPEG with no EXIF a small block of its own, after the JFIF header", async () => {
    const out = setJpegTakenAt(jpeg(null), NEW);
    expect((await meta(out)).takenAt?.toISOString()).toBe(NEW.toISOString());
    expect(out.subarray(0, 4)).toEqual(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]));
    expect(out[2 + 2 + 16]).toBe(0xff);
    expect(out[2 + 2 + 16 + 1]).toBe(0xe1);
  });
  it("can be done twice", async () => {
    const twice = setJpegTakenAt(setJpegTakenAt(jpeg(tiff(true, "2001:02:03 04:05:06")), new Date(Date.UTC(2010, 0, 1))), NEW);
    expect((await meta(twice)).takenAt?.toISOString()).toBe(NEW.toISOString());
    expect(parseExif(exifOf(twice)).orientation).toBe(6);
  });
  it("refuses what is not a JPEG or has damaged EXIF", () => {
    expect(() => setJpegTakenAt(Uint8Array.from([0x89, 0x50, 0x4e, 0x47]), NEW)).toThrow();
    const broken = jpeg([0x49, 0x49, 0x2a, 0, 0xff, 0xff, 0xff, 0x7f, 0, 0, 0, 0]);
    expect(() => setJpegTakenAt(broken, NEW)).toThrow();
  });
});

describe("setting and erasing the GPS position inside a JPEG", () => {
  const gps = { latRef: "N", lat: [37, 46, 3000] as [number, number, number], lonRef: "W", lon: [122, 25, 1500] as [number, number, number] };
  const withGps = (little: boolean) => realJpeg({ width: 40, height: 30, tiff: realTiff({ little, orientation: 6, dateTimeOriginal: "2019:05:06 07:08:09", gps }) });
  const gpsOf = async (b: Uint8Array) => (await meta(b)).gps;
  // The latitude numbers as the file stores them: 37, 46 and 30.00 seconds, as fractions (little-endian).
  const oldLat = Buffer.from([37, 0, 0, 0, 1, 0, 0, 0, 46, 0, 0, 0, 1, 0, 0, 0, 0xb8, 0x0b, 0, 0, 100, 0, 0, 0]);

  it("adds a position to a JPEG with none, in the southern and western hemispheres too", async () => {
    const out = editJpegExif(jpeg(null), { gps: { latitude: -33.8568, longitude: 151.2153 } });
    const g = (await gpsOf(out))!;
    expect(g.latitude).toBeCloseTo(-33.8568, 4);
    expect(g.longitude).toBeCloseTo(151.2153, 4);
    const w = (await gpsOf(editJpegExif(jpeg(tiff(false, "2001:02:03 04:05:06")), { gps: { latitude: 48.8584, longitude: -2.2945 } })))!;
    expect(w.longitude).toBeCloseTo(-2.2945, 4);
  });
  it("replaces a position and erases the old numbers from the file, keeping the date and orientation", async () => {
    const original = withGps(true);
    expect(Buffer.from(original).includes(oldLat)).toBe(true);
    const out = editJpegExif(original, { gps: { latitude: 10.5, longitude: 20.25 } });
    const g = (await gpsOf(out))!;
    expect(g.latitude).toBeCloseTo(10.5, 5);
    expect(Buffer.from(out).includes(oldLat)).toBe(false);
    expect((await meta(out)).takenAt?.toISOString()).toBe("2019-05-06T07:08:09.000Z");
    expect(parseExif(exifOf(out)).orientation).toBe(6);
  });
  it("removes a position completely: nothing to read, nothing left in the file", async () => {
    for (const little of [true, false]) {
      const out = editJpegExif(withGps(little), { gps: null });
      expect(await gpsOf(out)).toBeUndefined();
      expect(Buffer.from(out).includes(oldLat)).toBe(false);
      expect((await meta(out)).takenAt?.toISOString()).toBe("2019-05-06T07:08:09.000Z");
    }
    const bare = jpeg(null);
    expect(editJpegExif(bare, { gps: null })).toBe(bare); // no EXIF, nothing to remove: the file is returned as it was
  });
  it("can change the date and the position together", async () => {
    const out = editJpegExif(withGps(true), { takenAt: NEW, gps: { latitude: 1.5, longitude: 2.5 } });
    const m = await meta(out);
    expect(m.takenAt?.toISOString()).toBe(NEW.toISOString());
    expect(m.gps?.latitude).toBeCloseTo(1.5, 5);
  });
  it("refuses a position that isn't on Earth", () => {
    expect(() => editJpegExif(jpeg(null), { gps: { latitude: 91, longitude: 0 } })).toThrow();
  });
});
