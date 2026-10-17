import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { SAMPLE_RATE } from "./fingerprint";
import { decodeAudio, pcmArgs, pcmToFloat } from "./extract";
import { detectSeasonMarks, marksFrom, windowsFor, type Listen } from "./season";
import { concat, music, talk } from "./test-audio";

vi.setConfig({ testTimeout: 120_000 });

describe("what to listen to", () => {
  it("is the first eight minutes for the opening and the last seven for the credits, the latter only for a long enough episode", () => {
    expect(windowsFor(2700)).toEqual({ intro: { start: 0, seconds: 480 }, outro: { start: 2280, seconds: 420 } });
    expect(windowsFor(600)).toEqual({ intro: { start: 0, seconds: 300 }, outro: null });
    expect(windowsFor(840).outro).toEqual({ start: 420, seconds: 420 });
  });
});

describe("what to keep", () => {
  const found = (startSeconds: number, endSeconds: number) => ({ startSeconds, endSeconds, support: 4, tried: 6 });
  it("keeps an opening that is long enough and credits that run to the end (to the very end)", () => {
    expect(marksFrom(found(62.04, 101.5), found(2540, 2695), 2700)).toEqual([
      { kind: "intro", startSeconds: 62, endSeconds: 101.5 },
      { kind: "outro", startSeconds: 2540, endSeconds: 2700 },
    ]);
  });
  it("drops credits that stop well short of the end, ones that start too early, and anything too short or past the file", () => {
    expect(marksFrom(null, found(2000, 2300), 2700)).toEqual([]);
    expect(marksFrom(null, found(900, 2695), 2700)).toEqual([]);
    expect(marksFrom(found(10, 20), null, 2700)).toEqual([]);
    expect(marksFrom(found(-3, 40), null, 2700)).toEqual([]);
    expect(marksFrom(found(2680, 2710), null, 2700)).toEqual([]);
    expect(marksFrom(null, null, 2700)).toEqual([]);
  });
});

describe("a season", () => {
  /** Episodes of 11 minutes' worth of made-up sound: story, the opening, story, and (for some) the same closing music. */
  const intro = music(501, 30);
  const credits = music(502, 40);
  const episodes = Array.from({ length: 4 }, (_, i) => ({ id: `e${i}`, durationSeconds: 900, introAt: 25 + i * 31, introLen: 30 }));
  const audio = new Map<string, Float32Array>();
  for (const e of episodes) audio.set(e.id, concat(talk(70 + e.introAt, e.introAt), intro, talk(80 + e.introAt, e.durationSeconds - e.introAt - 30 - 45), credits.slice(0, 40 * SAMPLE_RATE), talk(90, 5)));
  const listen: Listen = vi.fn(async (id, start, seconds) => {
    const a = audio.get(id)!;
    return a.slice(start * SAMPLE_RATE, Math.min(a.length, (start + seconds) * SAMPLE_RATE));
  });

  it("finds each episode's opening and its credits at the end, in the episode's own time", async () => {
    const result = await detectSeasonMarks(episodes, listen, { references: 3 });
    for (const e of episodes) {
      const marks = result!.get(e.id)!;
      const intro = marks.find((m) => m.kind === "intro");
      expect(intro, `${e.id} intro`).toBeDefined();
      expect(Math.abs(intro!.startSeconds - e.introAt), `${e.id} start`).toBeLessThan(2.5);
      expect(Math.abs(intro!.endSeconds - (e.introAt + e.introLen)), `${e.id} end`).toBeLessThan(3.5);
      const outro = marks.find((m) => m.kind === "outro");
      expect(outro, `${e.id} outro`).toBeDefined();
      expect(outro!.endSeconds).toBe(900);
      expect(Math.abs(outro!.startSeconds - 855), `${e.id} outro start`).toBeLessThan(10);
    }
  });

  it("looks only for the kinds asked for, and gives nothing for a season too small to compare", async () => {
    const onlyIntro = await detectSeasonMarks(episodes, listen, { kinds: ["intro"], references: 3 });
    expect([...onlyIntro!.values()].every((marks) => marks.every((m) => m.kind === "intro"))).toBe(true);
    expect(await detectSeasonMarks(episodes.slice(0, 2), listen)).toBeNull();
  });

  it("skips an episode that could not be heard and still works out the rest", async () => {
    const broken: Listen = async (id, s, n) => (id === "e1" ? null : listen(id, s, n));
    const result = await detectSeasonMarks(episodes, broken, { kinds: ["intro"], references: 3 });
    expect(result!.get("e0")!.length).toBe(1);
    expect(result!.get("e1")).toEqual([]);
  });
});

describe("listening with ffmpeg", () => {
  it("asks ffmpeg for mono 8 kHz raw sound of just that stretch", () => {
    const args = pcmArgs("https://box.example/f.mp4", 12.5, 480);
    expect(args).toEqual(expect.arrayContaining(["-ss", "12.5", "-t", "480", "-i", "https://box.example/f.mp4", "-ac", "1", "-ar", "8000", "-f", "s16le", "pipe:1"]));
    expect(args.indexOf("-ss")).toBeLessThan(args.indexOf("-i")); // seeking before the input reads only what is needed
    expect(pcmArgs("x", -5, 10)).toContain("0");
  });

  it("turns raw 16-bit sound into numbers from -1 to 1", () => {
    const bytes = new Uint8Array(new Int16Array([0, 16384, -32768, 32767]).buffer);
    expect(Array.from(pcmToFloat(bytes))).toEqual([0, 0.5, -1, 32767 / 32768]);
    expect(pcmToFloat(new Uint8Array(3))).toHaveLength(1);
  });

  /** A stand-in ffmpeg process. */
  const fake = (chunks: Buffer[], code: number | null, then: "close" | "hang" | "error" = "close") => (() => {
    const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill: vi.fn() });
    setTimeout(() => {
      if (then === "error") return child.emit("error", new Error("spawn failed"));
      for (const c of chunks) child.stdout.emit("data", c);
      if (then === "close") child.emit("close", code);
    }, 0);
    return child;
  }) as never;

  it("gives the sound when ffmpeg succeeds, and nothing when it fails, says too little, cannot start, or hangs", async () => {
    const pcm = Buffer.from(new Int16Array(SAMPLE_RATE * 3).buffer);
    expect((await decodeAudio("ffmpeg", "u", 0, 3, { spawn: fake([pcm.subarray(0, 5000), pcm.subarray(5000)], 0) }))?.length).toBe(SAMPLE_RATE * 3);
    expect(await decodeAudio("ffmpeg", "u", 0, 3, { spawn: fake([pcm], 1) })).toBeNull();
    expect(await decodeAudio("ffmpeg", "u", 0, 3, { spawn: fake([Buffer.alloc(100)], 0) })).toBeNull();
    expect(await decodeAudio("ffmpeg", "u", 0, 3, { spawn: fake([], 0, "error") })).toBeNull();
    const killed = vi.fn();
    const hang = (() => Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill: killed })) as never;
    expect(await decodeAudio("ffmpeg", "u", 0, 3, { spawn: hang, timeoutMs: 20 })).toBeNull();
    expect(killed).toHaveBeenCalled();
  });
});
