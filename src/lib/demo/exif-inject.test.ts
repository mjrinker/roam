import { describe, expect, it } from "vitest";
import { readImageMeta } from "@/lib/scan/image-meta";
import { parseExif } from "@/lib/scan/exif";
import { buildJpeg, buildTiff, rangeOfBytes } from "@/lib/scan/test-images";
import { exifDateString, injectExifDate } from "./exif-inject";

const read = (b: Uint8Array) => readImageMeta(rangeOfBytes(b), b.length);

describe("injectExifDate", () => {
  it("puts a date in that Roam's own reader gets back exactly, and leaves the picture's size readable", async () => {
    const jpeg = buildJpeg({ width: 2048, height: 1365 });
    const dated = injectExifDate(jpeg, new Date("2019-05-06T07:08:09Z"));
    expect(await read(dated)).toEqual({ takenAt: new Date("2019-05-06T07:08:09Z"), width: 2048, height: 1365 });
    expect(dated.slice(0, 2)).toEqual(Uint8Array.from([0xff, 0xd8]));
    expect(dated.slice(-2)).toEqual(Uint8Array.from([0xff, 0xd9])); // image data intact to the end
  });

  it("replaces EXIF the file already had instead of adding a second one, and keeps its other segments", async () => {
    const jpeg = buildJpeg({ width: 100, height: 80, tiff: buildTiff({ dateTimeOriginal: "2001:01:01 01:01:01", orientation: 6 }) });
    const dated = injectExifDate(jpeg, new Date("2024-12-31T23:59:59Z"));
    const meta = await read(dated);
    expect(meta.takenAt).toEqual(new Date("2024-12-31T23:59:59Z"));
    expect([meta.width, meta.height]).toEqual([100, 80]); // the old orientation (6) went with the old EXIF, so no swap
    const text = Buffer.from(dated).toString("latin1");
    expect(text.match(/Exif\0\0/g)).toHaveLength(1);
    expect(text).toContain("JFIF");
  });

  it("writes the date the way a camera does, in all three places", () => {
    const dated = injectExifDate(buildJpeg(), new Date("2008-02-29T04:05:06Z"));
    const seg = dated.subarray(4); // after SOI + marker bytes; find the TIFF
    const at = Buffer.from(dated).indexOf("Exif\0\0") + 6;
    const exif = parseExif(dated.subarray(at));
    expect(exif.takenAt).toEqual(new Date("2008-02-29T04:05:06Z"));
    expect(Buffer.from(seg).toString("latin1").match(/2008:02:29 04:05:06/g)).toHaveLength(1); // one shared string, referenced three times
  });

  it("refuses anything that isn't a JPEG or a real date", () => {
    for (const bad of [new Uint8Array(0), Uint8Array.from([1, 2, 3, 4, 5]), Uint8Array.from([0x89, 0x50, 0x4e, 0x47])]) expect(() => injectExifDate(bad, new Date())).toThrow(/Not a JPEG/);
    expect(() => injectExifDate(buildJpeg(), new Date(NaN))).toThrow(/valid date/);
  });

  it("handles awkward dates: years before 1000 are padded, and the formatter is UTC", () => {
    expect(exifDateString(new Date("0999-01-02T03:04:05Z"))).toBe("0999:01:02 03:04:05");
    expect(exifDateString(new Date("2024-03-10T23:59:59-08:00"))).toBe("2024:03:11 07:59:59");
  });

  it("survives a truncated or oddly-segmented file without throwing", () => {
    const good = buildJpeg();
    for (const cut of [4, 6, 10, 20, good.length - 3]) expect(() => injectExifDate(good.slice(0, cut), new Date("2020-01-01T00:00:00Z"))).not.toThrow();
  });
});
