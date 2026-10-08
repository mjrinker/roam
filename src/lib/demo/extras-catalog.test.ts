import { describe, expect, it } from "vitest";
import { isAudioFile } from "@/lib/scan/conventions";
import { AUDIOBOOKS, MUSIC_ALBUMS, PHOTO_ALBUMS, audiobookFolders, chapterFileName, planMusic } from "./extras-catalog";

describe("planMusic", () => {
  const plan = planMusic();
  it("plans every track, in numbered order inside its album, under the composer", () => {
    expect(plan).toHaveLength(MUSIC_ALBUMS.reduce((n, a) => n + a.tracks.length, 0));
    for (const album of MUSIC_ALBUMS) {
      const files = plan.filter((p) => p.tags.album === album.name);
      expect(files.map((f) => f.tags.track)).toEqual(album.tracks.map((_, i) => i + 1));
      expect(files.map((f) => f.fileName)).toEqual([...files.map((f) => f.fileName)].sort());
      for (const f of files) expect(f.folders).toEqual(["Frédéric Chopin", album.name]);
    }
  });
  it("tags the composer and album, credits the performer in the comment, and names files Roam can play", () => {
    for (const p of plan) {
      expect(p.tags).toMatchObject({ artist: "Frédéric Chopin" });
      expect(p.tags.comment).toContain("Aaron Dunn");
      expect(isAudioFile(p.fileName)).toBe(true);
      expect(p.fileName).not.toMatch(/[\\/:*?"<>|]/);
    }
    expect(new Set(plan.map((p) => [...p.folders, p.fileName].join("/"))).size).toBe(plan.length);
    expect(new Set(plan.map((p) => p.sourceFile)).size).toBe(plan.length); // no recording twice
  });
});

describe("audiobooks", () => {
  it("lay out as Author / Title (Year), the way the audiobook scanner reads them", () => {
    expect(audiobookFolders(AUDIOBOOKS[0])).toEqual(["Lewis Carroll", "Alice's Adventures in Wonderland (1865)"]);
    for (const b of AUDIOBOOKS) {
      expect(audiobookFolders(b)[1]).toMatch(/ \(\d{4}\)$/);
      expect(b.chapters).toBeGreaterThan(0);
    }
    expect(new Set(AUDIOBOOKS.map((b) => b.item)).size).toBe(AUDIOBOOKS.length);
  });
  it("names chapters in order, without doubling the number the archive's title already has", () => {
    expect(chapterFileName(0, "01 Down the Rabbit Hole", "x")).toBe("01 - Down the Rabbit Hole.mp3");
    expect(chapterFileName(1, "02 - Vol. I, Letter I", "x")).toBe("02 - Vol. I, Letter I.mp3");
    expect(chapterFileName(2, "Chapter 03", "chapter-3")).toBe("03 - Chapter 03.mp3");
    expect(chapterFileName(0, "Chapters 1-3", "x")).toBe("01 - Chapters 1-3.mp3");
    expect(chapterFileName(0, null, "Part 1")).toBe("01 - Part 1.mp3");
    expect(chapterFileName(0, "07", "fallback name")).toBe("01 - fallback name.mp3"); // nothing left once the number is dropped
    expect(isAudioFile(chapterFileName(0, "A/B:C", "x"))).toBe(true);
  });
});

describe("photo albums", () => {
  it("each searches only CC0 files and asks for a few, to about thirty in all", () => {
    for (const a of PHOTO_ALBUMS) {
      expect(a.search).toContain('incategory:"CC-Zero"');
      expect(a.take).toBeGreaterThan(0);
    }
    const total = PHOTO_ALBUMS.reduce((n, a) => n + a.take, 0);
    expect(total).toBeGreaterThanOrEqual(25);
    expect(total).toBeLessThanOrEqual(40);
    expect(new Set(PHOTO_ALBUMS.map((a) => a.album)).size).toBe(PHOTO_ALBUMS.length);
  });
});
