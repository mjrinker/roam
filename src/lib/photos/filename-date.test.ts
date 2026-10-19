import { describe, expect, it } from "vitest";
import { parseFilenameDate } from "./filename-date";

const NOW = Date.UTC(2026, 9, 19);
const at = (name: string) => parseFilenameDate(name, NOW)?.toISOString() ?? null;

describe("a date in a picture's file name", () => {
  it("reads the usual camera, phone and screenshot names", () => {
    expect(at("IMG_20190314_142530.jpg")).toBe("2019-03-14T14:25:30.000Z");
    expect(at("PXL_20210704_190102345.jpg")).toBe("2021-07-04T19:01:02.000Z");
    expect(at("Screenshot_2019-03-14-14-25-30.png")).toBe("2019-03-14T14:25:30.000Z");
    expect(at("2019-03-14 14.25.30.jpg")).toBe("2019-03-14T14:25:30.000Z");
    expect(at("2019-03-14T14:25:30.heic")).toBe("2019-03-14T14:25:30.000Z");
    expect(at("20190314142530.JPG")).toBe("2019-03-14T14:25:30.000Z");
    expect(at("VID_20190314_142530.mp4")).toBe("2019-03-14T14:25:30.000Z");
  });
  it("reads a date alone as the middle of that day", () => {
    expect(at("IMG-20190314-WA0007.jpg")).toBe("2019-03-14T12:00:00.000Z");
    expect(at("Holiday 2018-08-02.jpg")).toBe("2018-08-02T12:00:00.000Z");
  });
  it("reads milliseconds since 1970, and whole-name seconds", () => {
    expect(at("1552573530000.jpg")).toBe("2019-03-14T14:25:30.000Z");
    expect(at("received_1552573530000.jpeg")).toBe("2019-03-14T14:25:30.000Z");
    expect(at("1552573530.jpg")).toBe("2019-03-14T14:25:30.000Z");
    expect(at("a1552573530b.jpg")).toBeNull();
  });
  it("says nothing for names that only contain digits", () => {
    for (const name of ["IMG_1234.jpg", "DSC00123.JPG", "photo 12.png", "scan_300dpi.jpg", "20191345_000000.jpg", "20190230.jpg", "19801231.jpg", "99999999.jpg"]) {
      expect(at(name)).toBeNull();
    }
  });
  it("refuses a date in the future", () => {
    expect(at("IMG_20301231_101010.jpg")).toBeNull();
  });
});
