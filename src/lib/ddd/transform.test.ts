import { describe, expect, it } from "vitest";
import type { FilterCue } from "@/lib/content-filter/categories";
import { categoryForTopic } from "./mapping";
import { PAD_AFTER_SECONDS, PAD_BEFORE_SECONDS, dddCues, dddGuideLines, dddReports, dddUnskippable, mergeGuideLines, momentsFromRatings } from "./transform";
import type { DddTitleData } from "./types";

describe("categoryForTopic", () => {
  it("puts well-known topics in a category", () => {
    const cases: [string, string | null][] = [
      ["a dog dies", "animals"],
      ["an animal is abused", "animals"],
      ["there are jump scares", "fear"],
      ["someone is sexually assaulted", "sex"],
      ["there is nudity", "nudity"],
      ["a racist slur is used", "discrimination"],
      ["someone attempts suicide", "distress"],
      ["there is drug use", "drugs"],
      ["a character is shot", "violence"],
      ["there is a swearing scene", "language"],
      ["a character has a wooden leg", null],
      // From their real topic list:
      ["someone drowns", "violence"],
      ["there's blood/gore", "violence"],
      ["there's gun violence", "violence"],
      ["someone is stabbed", "violence"],
      ["reality is unstable or unhinged", null],
      ["a parent dies", "distress"],
      ["someone self harms", "distress"],
      ["there's child abuse", "distress"],
      ["there are snakes", "fear"],
      ["there are sudden loud noises", "fear"],
      ["there is obscene language/gestures", "language"],
      ["there are nude scenes", "nudity"],
      ["there's genital trauma/mutilation", "violence"],
      ["there's smoke or haze", null],
      ["someone smokes or vapes", "drugs"],
      ["someone has agoraphobia", null],
      ["there's Islamophobia", "discrimination"],
      ["someone says the n-word", "discrimination"],
      ["a bug is killed", null],
      ["a dragon dies", null],
      ["there's end credits scenes?", null],
      ["religion is discussed", null],
    ];
    for (const [name, category] of cases) expect(categoryForTopic(name), name).toBe(category);
  });
  it("checks animals before violence, so a pet's death is animal harm", () => {
    expect(categoryForTopic("a cat is killed")).toBe("animals");
  });
});

const names = new Map([[153, "a dog dies"], [7, "there are jump scares"], [9, "a character has a wooden leg"]]);
const rating = (over: object) => ({ yes: 1, voteSum: 0, isSceneAlert: false, index1: -1, index2: -1, position1: 1, position2: 18, position3: 42, safePosition1: 1, safePosition2: 20, safePosition3: 5, topicId: 153, ...over });

describe("momentsFromRatings", () => {
  it("takes a community yes report with both times, as seconds", () => {
    expect(momentsFromRatings([rating({})], names)).toEqual([{ topicId: 153, topicName: "a dog dies", season: -1, episode: -1, startSeconds: 4722, safeSeconds: 4805 }]);
  });
  it("leaves out what can't be skipped or isn't community data", () => {
    const bad = [
      rating({ isSceneAlert: true }),
      rating({ yes: 0 }),
      rating({ voteSum: -2 }),
      rating({ position1: null }),
      rating({ safePosition1: null }),
      rating({ safePosition1: 1, safePosition2: 18, safePosition3: 42 }), // safe is not after the start
      rating({ safePosition1: 5 }), // hours later: a typo
      rating({ topicId: 999 }), // no name for it
    ];
    expect(momentsFromRatings(bad, names)).toEqual([]);
  });
  it("keeps a TV moment's season and episode", () => {
    expect(momentsFromRatings([rating({ index1: 2, index2: 5 })], names)[0]).toMatchObject({ season: 2, episode: 5 });
  });
});

const movie: DddTitleData = { name: "Old Yeller", kind: "movie", stats: null, moments: momentsFromRatings([rating({}), rating({ topicId: 7, position1: 0, position2: 5, position3: 0, safePosition1: 0, safePosition2: 5, safePosition3: 30 }), rating({ topicId: 9 })], names) };
const show: DddTitleData = { name: "A Show", kind: "tv", stats: null, moments: momentsFromRatings([rating({ index1: 1, index2: 2 }), rating({ index1: 1, index2: 3 }), rating({ index1: -1, index2: -1 })], names) };

describe("dddCues", () => {
  it("makes cues for the mapped topics, widened a little each side, at every strength", () => {
    const cues = dddCues(movie, { kind: "movie" });
    expect(cues.map((c) => [c.category, c.startSeconds, c.endSeconds])).toEqual([
      ["fear", 300 - PAD_BEFORE_SECONDS, 330 + PAD_AFTER_SECONDS],
      ["animals", 4722 - PAD_BEFORE_SECONDS, 4805 + PAD_AFTER_SECONDS],
    ]);
    expect(cues.every((c) => c.severity === "high" && c.channel === "both" && c.note)).toBe(true);
  });
  it("gives an episode only its own moments, and a movie none of a show's", () => {
    expect(dddCues(show, { kind: "episode", season: 1, episode: 2 })).toHaveLength(1);
    expect(dddCues(show, { kind: "episode", season: 1, episode: 4 })).toEqual([]);
    expect(dddCues(show, { kind: "movie" })).toEqual([]);
    expect(dddCues(movie, { kind: "episode", season: 1, episode: 2 })).toEqual([]);
  });
});

describe("guide lines", () => {
  const cue = (category: FilterCue["category"], start: number, end: number): FilterCue => ({ startSeconds: start, endSeconds: end, category, severity: "high", channel: "both" });
  it("sums the community's scenes per category and marks them as community", () => {
    const lines = dddGuideLines([cue("animals", 10, 20), cue("animals", 50, 55), cue("fear", 0, 5)]);
    expect(lines).toEqual([
      { source: "community", category: "animals", severity: "high", scenes: 2, seconds: 15 },
      { source: "community", category: "fear", severity: "high", scenes: 1, seconds: 5 },
    ]);
  });
  it("merges with a file's lines, keeping the file's strength", () => {
    const file = [{ category: "animals" as const, severity: "low" as const, scenes: 1, seconds: 10 }, { category: "sex" as const, severity: "medium" as const, scenes: 1, seconds: 5 }];
    const out = mergeGuideLines(file, dddGuideLines([cue("animals", 10, 20), cue("fear", 0, 5)]));
    expect(out.find((l) => l.category === "animals")).toMatchObject({ severity: "low", scenes: 2, seconds: 20 });
    expect(out.find((l) => l.category === "fear")?.source).toBe("community");
    expect(out.find((l) => l.category === "sex")?.source).toBeUndefined();
  });
});

describe("dddReports", () => {
  it("lists topics more people said yes to than no, most agreed first, ignoring the barely reported", () => {
    const stats = [
      { topicId: 1, topicName: "a dog dies", yes: 57, no: 3, comments: 7 },
      { topicId: 2, topicName: "there are jump scares", yes: 10, no: 8, comments: 0 },
      { topicId: 3, topicName: "there is nudity", yes: 1, no: 0, comments: 0 },
      { topicId: 4, topicName: "a cat dies", yes: 3, no: 9, comments: 0 },
    ];
    expect(dddReports(stats).map((r) => r.topicName)).toEqual(["a dog dies", "there are jump scares"]);
    expect(dddReports(null)).toEqual([]);
  });
});

describe("dddUnskippable", () => {
  const data: DddTitleData = {
    name: "A Film",
    kind: "movie",
    stats: [
      { topicId: 153, topicName: "a dog dies", yes: 57, no: 3, comments: 0 },
      { topicId: 7, topicName: "there are jump scares", yes: 30, no: 2, comments: 0 },
      { topicId: 20, topicName: "there are snakes", yes: 12, no: 1, comments: 0 },
      { topicId: 21, topicName: "there's blood/gore", yes: 4, no: 6, comments: 0 },
      { topicId: 22, topicName: "religion is discussed", yes: 40, no: 0, comments: 0 },
    ],
    moments: [{ topicId: 7, topicName: "there are jump scares", season: -1, episode: -1, startSeconds: 10, safeSeconds: 20 }],
  };
  it("lists reported topics in categories the viewer skips that have no scene time, most agreed first", () => {
    expect(dddUnskippable(data, { animals: "low", fear: "low", violence: "low" }).map((u) => [u.topicName, u.category])).toEqual([
      ["a dog dies", "animals"],
      ["there are snakes", "fear"],
    ]); // jump scares has a time (skippable); gore has more no than yes; religion is no category
  });
  it("is empty for a viewer who chose nothing", () => {
    expect(dddUnskippable(data, {})).toEqual([]);
  });
});
