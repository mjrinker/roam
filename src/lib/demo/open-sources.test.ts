import { describe, expect, it } from "vitest";
import { isOpenArchiveLicence, isOpenCommonsLicence, parseCommonsDate, photoTitle, pickPhotos, plainText, safeFileName, usablePhoto, type PhotoCandidate } from "./open-sources";

describe("licence rules fail closed", () => {
  it("accepts only CC0 and public domain on Commons, nothing else", () => {
    for (const ok of ["CC0", "CC0 1.0", "Public domain", " CC0 "]) expect(isOpenCommonsLicence(ok), ok).toBe(true);
    for (const no of ["CC BY 4.0", "CC BY-SA 3.0", "CC BY-NC 2.0", "GFDL", "Attribution", "cc0-ish", "", null, undefined]) expect(isOpenCommonsLicence(no as never), String(no)).toBe(false);
  });
  it("accepts only the Internet Archive's public-domain and CC0 licence URLs, and an item with none is refused", () => {
    for (const ok of ["http://creativecommons.org/publicdomain/zero/1.0/", "http://creativecommons.org/publicdomain/mark/1.0/", "http://creativecommons.org/licenses/publicdomain/"]) expect(isOpenArchiveLicence(ok), ok).toBe(true);
    for (const no of ["http://creativecommons.org/licenses/by/4.0/", "http://creativecommons.org/licenses/by-nc/3.0/", "http://creativecommons.org/licenses/by-nd/3.0/", "http://creativecommons.org/publicdomain/zero/1.0/x", "https://evil.example/publicdomain/zero/1.0/", "", null, undefined]) {
      expect(isOpenArchiveLicence(no as never), String(no)).toBe(false);
    }
  });
});

describe("plainText", () => {
  it("drops tags, decodes entities, tidies space and caps the length", () => {
    expect(plainText('<a href="//x">Jane &amp; Co</a>\n  <b>Smith</b>')).toBe("Jane & Co Smith");
    expect(plainText("&lt;not a tag&gt; &quot;q&quot;")).toBe('<not a tag> "q"');
    expect(plainText("x".repeat(500), 20)).toHaveLength(20);
    expect(plainText(null)).toBe("");
  });
});

describe("parseCommonsDate", () => {
  const now = new Date("2026-10-07T00:00:00Z");
  it("reads exact dates and times, giving a bare date noon so no zone can move it a day", () => {
    expect(parseCommonsDate("2016-07-25", now)).toEqual(new Date("2016-07-25T12:00:00Z"));
    expect(parseCommonsDate("2015-02-25 13:11:44", now)).toEqual(new Date("2015-02-25T13:11:44Z"));
    expect(parseCommonsDate("2018-08-01 09:55", now)).toEqual(new Date("2018-08-01T09:55:00Z"));
    expect(parseCommonsDate('<time class="x">2021-02-27</time>', now)).toEqual(new Date("2021-02-27T12:00:00Z"));
  });
  it("refuses anything that isn't one exact modern moment", () => {
    for (const bad of ["circa 1870", "between 1762 and 1765", "Unknown date", "None", "2016", "2016-07", "1999-12-31", "2016-13-01", "2016-02-30", "2016-07-25 24:00", "2016-07-25 12:61", "2027-01-01", "", null, undefined, "2016-07-25 to 2016-07-27"]) {
      expect(parseCommonsDate(bad as never, now), String(bad)).toBeNull();
    }
  });
});

describe("photoTitle / safeFileName", () => {
  it("makes a readable title", () => {
    expect(photoTitle("File:Lake Tahoe Sunset (39995495833).jpg")).toBe("Lake Tahoe Sunset");
    expect(photoTitle("File:Sunset_Over  Lake Michigan.JPG")).toBe("Sunset Over Lake Michigan");
    expect(photoTitle('File:Bad:/\\name?.jpg')).toBe("Badname");
  });
  it("makes names that are safe in Box", () => {
    expect(safeFileName('a/b\\c:d*e?"f<g>h|i\u0000')).toBe("abcdefghi");
  });
});

const cand = (over: Partial<PhotoCandidate> = {}): PhotoCandidate => ({
  title: "File:Mountain.jpg", mime: "image/jpeg", width: 4000, height: 3000, licence: "CC0", takenAt: new Date("2018-05-05T12:00:00Z"),
  pageUrl: "https://commons.wikimedia.org/wiki/File:Mountain.jpg", downloadUrl: "https://upload.wikimedia.org/x.jpg", artist: "A. Person", ...over,
});

describe("usablePhoto / pickPhotos", () => {
  it("needs an open licence, a JPEG, enough pixels and an exact date", () => {
    expect(usablePhoto(cand())).toBe(true);
    for (const over of [{ licence: "CC BY 4.0" }, { licence: null }, { mime: "image/png" }, { width: 1999 }, { takenAt: null }, { title: "File:.jpg" }, { title: "File:கும்பை8.jpg" }]) expect(usablePhoto(cand(over as never)), JSON.stringify(over)).toBe(false);
  });
  it("takes one of each title, newest first, evenly across the years", () => {
    const all = Array.from({ length: 40 }, (_, i) => cand({ title: `File:Photo ${i}.jpg`, takenAt: new Date(Date.UTC(2005 + Math.floor(i / 2), i % 12, 10, 12)) }));
    all.push(cand({ title: "File:Photo 3.jpg" }), cand({ title: "File:Bad.jpg", licence: "GFDL" }));
    const picked = pickPhotos(all, 10);
    expect(picked).toHaveLength(10);
    expect(new Set(picked.map((p) => p.title)).size).toBe(10);
    expect(picked.map((p) => p.takenAt!.getTime())).toEqual([...picked.map((p) => p.takenAt!.getTime())].sort((a, b) => b - a));
    expect(picked[0].takenAt!.getUTCFullYear() - picked[9].takenAt!.getUTCFullYear()).toBeGreaterThanOrEqual(14); // spans the range, not the newest ten
    expect(picked.some((p) => p.title === "File:Bad.jpg")).toBe(false);
  });
  it("returns what there is when there are fewer than asked for, and nothing from nothing", () => {
    expect(pickPhotos([cand(), cand({ title: "File:Other.jpg" })], 10)).toHaveLength(2);
    expect(pickPhotos([], 10)).toEqual([]);
  });
});
