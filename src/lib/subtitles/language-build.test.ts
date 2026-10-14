import { describe, expect, it } from "vitest";
import { buildLanguageCues } from "./language-build";
import { HASH_CHUNK, computeMovieHash, movieHashFromParts } from "./moviehash";
import { OpenSubtitlesError, type SubtitleResult } from "./opensubtitles";

/** The fingerprint written out the slow, obvious way, to check the fast one against. */
function reference(size: number, first: Uint8Array, last: Uint8Array): string {
  let hash = BigInt(size);
  const add = (b: Uint8Array) => {
    for (let i = 0; i + 8 <= b.length; i += 8) {
      let w = BigInt(0);
      for (let k = 7; k >= 0; k--) w = (w << BigInt(8)) | BigInt(b[i + k]);
      hash = (hash + w) % (BigInt(1) << BigInt(64));
    }
  };
  add(first);
  add(last);
  return hash.toString(16).padStart(16, "0");
}

describe("the file fingerprint", () => {
  const size = 5_000_000;
  const file = new Uint8Array(size).map((_, i) => (i * 31 + (i >> 8)) & 0xff);
  const fetchRange = async (s: number, e: number) => file.slice(s, e + 1).buffer as ArrayBuffer;
  it("matches the plain definition", async () => {
    const first = file.slice(0, HASH_CHUNK);
    const last = file.slice(size - HASH_CHUNK);
    expect(movieHashFromParts(size, first, last)).toBe(reference(size, first, last));
    expect(await computeMovieHash(fetchRange, size)).toBe(reference(size, first, last));
    expect(await computeMovieHash(fetchRange, size)).toMatch(/^[0-9a-f]{16}$/);
  });
  it("has none for a file too small to have one", async () => {
    expect(await computeMovieHash(fetchRange, 100_000)).toBeNull();
  });
  it("wraps around instead of overflowing, and pads to 16 digits", () => {
    const ones = new Uint8Array(HASH_CHUNK).fill(0xff);
    expect(movieHashFromParts(1, ones, ones)).toBe(reference(1, ones, ones));
    expect(movieHashFromParts(1, new Uint8Array(HASH_CHUNK), new Uint8Array(HASH_CHUNK))).toBe("0000000000000001");
  });
});

const SRT = `1\n00:00:10,000 --> 00:00:12,000\nWhat the hell?\n\n2\n00:09:50,000 --> 00:09:52,000\nThe end.\n`;
const result = (over: Partial<SubtitleResult> = {}): SubtitleResult => ({ fileId: 1, language: "en", release: "r", fileName: "a.srt", downloads: 5, hearingImpaired: false, aiTranslated: false, trusted: true, fps: 24, hashMatch: false, ...over });
const fake = (searches: SubtitleResult[][], opts: { srt?: string; quota?: boolean } = {}) => {
  const log: string[] = [];
  let n = 0;
  return {
    log,
    os: {
      search: async (q: { movieHash?: string }) => (log.push(q.movieHash ? "search+hash" : "search"), searches[n++] ?? []),
      download: async (id: number) => {
        log.push(`download ${id}`);
        if (opts.quota) throw new OpenSubtitlesError("quota", "limit");
        return { bytes: new TextEncoder().encode(opts.srt ?? SRT), fileName: "a.srt", remaining: 7, resetTime: null };
      },
    },
    fetchRange: async (s: number, e: number) => new Uint8Array(e - s + 1).fill(3).buffer as ArrayBuffer,
  };
};
const input = { target: { type: "movie" as const, tmdbId: 1 }, sizeBytes: 1_000_000, durationSeconds: 600 };

describe("buildLanguageCues", () => {
  it("builds mutes from a subtitle made for this exact file", async () => {
    const f = fake([[result({ hashMatch: true })]]);
    const r = await buildLanguageCues(f, input);
    expect(r).toMatchObject({ status: "built", guess: false, remaining: 7 });
    expect(r.status === "built" && r.cues).toHaveLength(1);
    expect(f.log).toEqual(["search+hash", "download 1"]);
  });
  it("downloads nothing when no subtitle was made for the file and loose mode is off", async () => {
    const f = fake([[result()]]);
    expect(await buildLanguageCues(f, input)).toEqual({ status: "unmatched" });
    expect(f.log).toEqual(["search+hash"]);
  });
  it("in loose mode uses the best one for the film, as a guess, if it is about the right length", async () => {
    const f = fake([[], [result({ fileId: 9 })]]);
    const r = await buildLanguageCues(f, { ...input, loose: true });
    expect(r).toMatchObject({ status: "built", guess: true });
    expect(f.log).toEqual(["search+hash", "search", "download 9"]);
  });
  it("rejects a guess whose length is wrong for the film", async () => {
    const f = fake([[], [result()]], { srt: "1\n00:00:10,000 --> 00:00:12,000\nshit\n" });
    expect(await buildLanguageCues(f, { ...input, loose: true })).toEqual({ status: "unmatched" });
  });
  it("prefers the version without sound descriptions, and never an AI translation", async () => {
    const f = fake([[result({ fileId: 1, hashMatch: true, hearingImpaired: true }), result({ fileId: 2, hashMatch: true }), result({ fileId: 3, hashMatch: true, aiTranslated: true })]]);
    await buildLanguageCues(f, input);
    expect(f.log).toContain("download 2");
  });
  it("stops on the daily limit, and reports other trouble without throwing", async () => {
    expect(await buildLanguageCues(fake([[result({ hashMatch: true })]], { quota: true }), input)).toEqual({ status: "quota" });
    const broken = { os: { search: async () => { throw new Error("down"); }, download: async () => { throw new Error("x"); } }, fetchRange: async () => new ArrayBuffer(300_000) };
    expect((await buildLanguageCues(broken as never, input)).status).toBe("error");
    expect(await buildLanguageCues(fake([]), { ...input, sizeBytes: 1000 })).toEqual({ status: "no_hash" });
  });
});
