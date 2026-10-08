import { describe, expect, it } from "vitest";
import { isAudioFile } from "@/lib/scan/conventions";
import { CLIP_SECONDS, FAKE_ALBUMS, TOLKIEN_BOOKS, planFakeMusic, tolkienPath, type SourceAudio } from "./fake-catalog";

describe("Tolkien placeholder books", () => {
  it("has each book once, with real-looking years", () => {
    expect(new Set(TOLKIEN_BOOKS.map((b) => b.title)).size).toBe(TOLKIEN_BOOKS.length);
    for (const b of TOLKIEN_BOOKS) expect(b.year, b.title).toBeGreaterThanOrEqual(1937);
    expect(TOLKIEN_BOOKS.map((b) => b.title)).toEqual(expect.arrayContaining(["The Hobbit", "The Silmarillion", "The Two Towers", "The Children of Húrin"]));
  });
  it("numbers each series 1..n without gaps or repeats", () => {
    const bySeries = new Map<string, number[]>();
    for (const b of TOLKIEN_BOOKS) if (b.series) bySeries.set(b.series.name, [...(bySeries.get(b.series.name) ?? []), b.series.position]);
    expect([...bySeries.keys()].sort()).toEqual(["The History of Middle-earth", "The Lord of the Rings"]);
    for (const [name, positions] of bySeries) expect([...positions].sort((a, b) => a - b), name).toEqual(positions.map((_, i) => i + 1));
  });
  it("files them under the author, series in their own folders in reading order, with names safe for Box", () => {
    const paths = TOLKIEN_BOOKS.map((b) => tolkienPath(b));
    expect(new Set(paths.map((p) => [...p.folders, p.fileName].join("/"))).size).toBe(TOLKIEN_BOOKS.length);
    expect(tolkienPath(TOLKIEN_BOOKS[1])).toEqual({ folders: ["J.R.R. Tolkien", "The Lord of the Rings"], fileName: "01 - The Fellowship of the Ring.epub" });
    expect(tolkienPath(TOLKIEN_BOOKS[0])).toEqual({ folders: ["J.R.R. Tolkien"], fileName: "The Hobbit.epub" });
    for (const p of paths) expect([...p.folders, p.fileName].join("")).not.toMatch(/[\\/:*?"<>|]/);
  });
});

const sources = (n: number, seconds = 300): SourceAudio[] => Array.from({ length: n }, (_, i) => ({ file: `s${i}.mp3`, seconds }));

describe("fake albums", () => {
  it("are real-looking albums with a full track list each", () => {
    expect(FAKE_ALBUMS.length).toBeGreaterThanOrEqual(10);
    expect(new Set(FAKE_ALBUMS.map((a) => `${a.artist}/${a.album}`)).size).toBe(FAKE_ALBUMS.length);
    for (const a of FAKE_ALBUMS) {
      expect(a.tracks.length, a.album).toBeGreaterThanOrEqual(5);
      expect(new Set(a.tracks).size, a.album).toBe(a.tracks.length);
    }
    expect(FAKE_ALBUMS.find((a) => a.album === "Abbey Road")!.tracks).toHaveLength(17);
  });
});

describe("planFakeMusic", () => {
  it("numbers songs per album, names files Roam can play, and files them Artist / Album", () => {
    const plan = planFakeMusic(FAKE_ALBUMS, sources(44));
    expect(plan).toHaveLength(FAKE_ALBUMS.reduce((n, a) => n + a.tracks.length, 0));
    const abbey = plan.filter((p) => p.album === "Abbey Road");
    expect(abbey.map((p) => p.track)).toEqual(abbey.map((_, i) => i + 1));
    expect(abbey[0]).toMatchObject({ folders: ["The Beatles", "Abbey Road"], fileName: "01 - Come Together.mp3", title: "Come Together", year: 1969 });
    for (const p of plan) {
      expect(isAudioFile(p.fileName), p.fileName).toBe(true);
      expect(p.fileName).not.toMatch(/[\\/:*?"<>|]/);
    }
    expect(new Set(plan.map((p) => [...p.folders, p.fileName].join("/"))).size).toBe(plan.length);
  });
  it("never plays the same moment of a recording twice, and stays inside each recording", () => {
    const src = sources(44);
    const plan = planFakeMusic(FAKE_ALBUMS, src);
    for (const s of src) {
      const clips = plan.filter((p) => p.sourceFile === s.file).sort((a, b) => a.startSeconds - b.startSeconds);
      for (let i = 1; i < clips.length; i++) expect(clips[i].startSeconds).toBeGreaterThanOrEqual(clips[i - 1].startSeconds + CLIP_SECONDS);
      for (const c of clips) expect(c.startSeconds + c.durationSeconds).toBeLessThanOrEqual(s.seconds);
    }
  });
  it("is deterministic and skips recordings that are too short", () => {
    const src = [...sources(44), { file: "tiny.mp3", seconds: 30 }];
    expect(planFakeMusic(FAKE_ALBUMS, src)).toEqual(planFakeMusic(FAKE_ALBUMS, [...src].reverse()));
    expect(planFakeMusic(FAKE_ALBUMS, src).some((p) => p.sourceFile === "tiny.mp3")).toBe(false);
  });
  it("says so when the recordings can't hold every song", () => {
    expect(() => planFakeMusic(FAKE_ALBUMS, sources(3, 100))).toThrow(/enough audio/);
    expect(() => planFakeMusic(FAKE_ALBUMS, [])).toThrow(/enough audio/);
  });
});
