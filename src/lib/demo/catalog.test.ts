import { describe, expect, it } from "vitest";
import { parseEpisodeFileName, parseSeasonFolderName, parseTitleFolderName, isVideoFile } from "@/lib/scan/conventions";
import { CLIP_SECONDS, DEMO_MOVIES, DEMO_SHOWS, DEMO_SOURCES, HOME_VIDEO_CLIPS, PHOTO_VIDEO_CLIPS, demoCredits, planDemoMedia, planExtraVideos, safeName } from "./catalog";

describe("planDemoMedia", () => {
  const plan = planDemoMedia();

  it("plans one file per movie and per episode", () => {
    expect(plan).toHaveLength(DEMO_MOVIES.length + DEMO_SHOWS.reduce((n, s) => n + s.episodes.length, 0));
  });

  it("never plans the same path twice, and every name is safe for Box", () => {
    const paths = plan.map((f) => [...f.folders, f.fileName].join("/"));
    expect(new Set(paths).size).toBe(paths.length);
    for (const f of plan) for (const part of [...f.folders, f.fileName]) expect(part, part).toBe(safeName(part));
  });

  it("names movies the way the scanner reads them: a title (year) folder holding a video of the same name", () => {
    for (const f of plan.filter((p) => p.folders[0] === "Movies")) {
      const parsed = parseTitleFolderName(f.folders[1]);
      expect(parsed.year, f.label).not.toBeNull();
      expect(f.fileName).toBe(`${f.folders[1]}.mp4`);
      expect(isVideoFile(f.fileName)).toBe(true);
    }
  });

  it("names episodes the way the scanner reads them: show folder, Season 01, S01Exx - title", () => {
    for (const f of plan.filter((p) => p.folders[0] === "TV Shows")) {
      expect(parseTitleFolderName(f.folders[1]).year).not.toBeNull();
      expect(parseSeasonFolderName(f.folders[2])).toBe(1);
      const ep = parseEpisodeFileName(f.fileName);
      expect(ep, f.fileName).not.toBeNull();
      expect(ep!.season).toBe(1);
    }
    expect(plan.filter((p) => p.folders[1] === "Breaking Bad (2008)")).toHaveLength(3);
  });

  it("cuts non-overlapping clips from each source, inside the film, so no two files show the same footage", () => {
    for (const source of DEMO_SOURCES) {
      const clips = plan.filter((f) => f.sourceId === source.id).sort((a, b) => a.startSeconds - b.startSeconds);
      for (const c of clips) {
        expect(c.durationSeconds).toBe(CLIP_SECONDS);
        expect(c.startSeconds).toBeGreaterThanOrEqual(0);
        expect(c.startSeconds + c.durationSeconds).toBeLessThanOrEqual(source.durationSeconds);
      }
      for (let i = 1; i < clips.length; i++) expect(clips[i].startSeconds).toBeGreaterThanOrEqual(clips[i - 1].startSeconds + clips[i - 1].durationSeconds);
    }
  });

  it("is deterministic, and says so plainly when the sources can't cover the files", () => {
    expect(planDemoMedia()).toEqual(plan);
    const tiny = DEMO_SOURCES.slice(0, 1).map((s) => ({ ...s, durationSeconds: 100 }));
    expect(() => planDemoMedia(tiny)).toThrow(/enough footage/);
  });
});

describe("demoCredits", () => {
  it("credits every source that is used, with a licence, a link and the files it plays", () => {
    const credits = demoCredits();
    expect(credits.length).toBeGreaterThan(0);
    for (const c of credits) {
      expect(c.credit).toMatch(/Blender Foundation/);
      expect(c.license).toBe("Creative Commons Attribution 3.0");
      expect(c.sourceUrl).toMatch(/^https:\/\//);
      expect(c.licenseUrl).toMatch(/^https:\/\/creativecommons\.org\//);
      expect(c.usedFor.length).toBeGreaterThan(0);
    }
    const allLabels = credits.flatMap((c) => c.usedFor);
    const extra = planExtraVideos();
    expect(new Set(allLabels).size).toBe(planDemoMedia().length + extra.homeVideos.length + extra.photoVideos.length); // every file is credited exactly once
  });

  it("leaves out a source nothing uses", () => {
    expect(demoCredits([], DEMO_SOURCES)).toEqual([]);
  });
});

describe("planExtraVideos", () => {
  const main = planDemoMedia();
  const extra = planExtraVideos();
  const all = [...main, ...extra.homeVideos, ...extra.photoVideos];

  it("plans the clips it was asked for, for the two libraries", () => {
    expect(extra.homeVideos).toHaveLength(HOME_VIDEO_CLIPS);
    expect(extra.photoVideos).toHaveLength(PHOTO_VIDEO_CLIPS);
  });
  it("never reuses footage that the movies and shows (or each other) already show", () => {
    for (const source of DEMO_SOURCES) {
      const clips = all.filter((f) => f.sourceId === source.id).sort((a, b) => a.startSeconds - b.startSeconds);
      for (let i = 1; i < clips.length; i++) expect(clips[i].startSeconds).toBeGreaterThanOrEqual(clips[i - 1].startSeconds + clips[i - 1].durationSeconds);
      for (const c of clips) expect(c.startSeconds + c.durationSeconds).toBeLessThanOrEqual(source.durationSeconds);
    }
  });
  it("names each clip for what it is, in a folder named for the film (home videos) or at the top (photos), never as something else", () => {
    for (const f of extra.homeVideos) {
      const film = DEMO_SOURCES.find((s) => s.id === f.sourceId)!.title;
      expect(f.folders).toEqual([film]);
      expect(f.fileName).toMatch(new RegExp(`^${film} - \\d+m\\d{2}s\\.mp4$`));
    }
    for (const f of extra.photoVideos) expect(f.folders).toEqual([]);
    expect(new Set(all.map((f) => [...f.folders, f.fileName].join("/"))).size).toBe(all.length);
  });
  it("is deterministic", () => {
    expect(planExtraVideos()).toEqual(extra);
  });
});
