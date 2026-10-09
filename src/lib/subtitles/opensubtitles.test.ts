import { describe, expect, it } from "vitest";
import { OpenSubtitles, OpenSubtitlesError, openSubtitlesConfig, type OpenSubtitlesConfig } from "./opensubtitles";
import { MAX_SUBTITLE_BYTES } from "./cues";

const config: OpenSubtitlesConfig = { apiKey: "key123", username: "user", password: "pw" };
type Call = { url: string; init: RequestInit };

/** A pretend OpenSubtitles: records every call and answers from a list of handlers (first one that matches). */
function pretend(handlers: ((url: URL, init: RequestInit, n: number) => Response | undefined)[]) {
  const calls: Call[] = [];
  const fetchImpl = async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    for (const h of handlers) {
      const r = h(new URL(url), init, calls.length);
      if (r) return r;
    }
    return new Response("not handled", { status: 500 });
  };
  return { calls, client: (c = config, now = () => 1_000) => new OpenSubtitles(c, fetchImpl, now) };
}
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers });
const login = (token = "tok", extra: Record<string, unknown> = {}) => (u: URL) => (u.pathname === "/api/v1/login" ? json({ token, ...extra }) : undefined);

const hit = (fileId: number, over: Record<string, unknown> = {}) => ({ id: String(fileId), attributes: { language: "en", download_count: 10, release: "Rel", files: [{ file_id: fileId, file_name: "a.srt" }], ...over } });

describe("configuration", () => {
  it("needs the key, the username and the password; any one missing means not set up", () => {
    expect(openSubtitlesConfig({ OPENSUBTITLES_API_KEY: "k", OPENSUBTITLES_USERNAME: "u", OPENSUBTITLES_PASSWORD: "p" })).toEqual({ apiKey: "k", username: "u", password: "p" });
    for (const missing of ["OPENSUBTITLES_API_KEY", "OPENSUBTITLES_USERNAME", "OPENSUBTITLES_PASSWORD"]) {
      const env: Record<string, string> = { OPENSUBTITLES_API_KEY: "k", OPENSUBTITLES_USERNAME: "u", OPENSUBTITLES_PASSWORD: "p" };
      delete env[missing];
      expect(openSubtitlesConfig(env), missing).toBeNull();
    }
    expect(openSubtitlesConfig({})).toBeNull();
    expect(openSubtitlesConfig({ OPENSUBTITLES_API_KEY: " ", OPENSUBTITLES_USERNAME: "u", OPENSUBTITLES_PASSWORD: "p" })).toBeNull();
  });
});

describe("search", () => {
  it("logs in once, sends the key and a user agent, and asks by TMDB id with sorted lower-case parameters", async () => {
    const { calls, client } = pretend([login(), (u) => (u.pathname === "/api/v1/subtitles" ? json({ data: [hit(1)] }) : undefined)]);
    const c = client();
    await c.search({ type: "movie", tmdbId: 603, languages: ["EN", "es"] });
    await c.search({ type: "movie", tmdbId: 603, languages: ["en"] });
    expect(calls.filter((x) => x.url.endsWith("/login"))).toHaveLength(1); // the token is reused
    const search = calls.find((x) => x.url.includes("/subtitles?"))!;
    expect(search.url).toBe("https://api.opensubtitles.com/api/v1/subtitles?languages=en%2Ces&tmdb_id=603&type=movie");
    const h = search.init.headers as Record<string, string>;
    expect(h["Api-Key"]).toBe("key123");
    expect(h["User-Agent"]).toMatch(/^Roam v/);
    expect(h.Authorization).toBe("Bearer tok");
  });
  it("asks for an episode by the show's TMDB id, season and episode", async () => {
    const { calls, client } = pretend([login(), (u) => (u.pathname === "/api/v1/subtitles" ? json({ data: [] }) : undefined)]);
    await client().search({ type: "episode", parentTmdbId: 1396, season: 2, episode: 5, languages: ["en"] });
    expect(calls.find((x) => x.url.includes("/subtitles?"))!.url).toBe("https://api.opensubtitles.com/api/v1/subtitles?episode_number=5&languages=en&parent_tmdb_id=1396&season_number=2&type=episode");
  });
  it("reads results, puts trusted uploads first and then the most downloaded, flags hearing-impaired and machine-translated, and skips odd rows", async () => {
    const { client } = pretend([
      login(),
      () =>
        json({
          data: [
            hit(1, { download_count: 5 }),
            hit(2, { download_count: 900, hearing_impaired: true }),
            hit(3, { download_count: 1, from_trusted: true, fps: 23.976 }),
            hit(4, { ai_translated: true, download_count: 50 }),
            { attributes: { language: "en", files: [] } }, // no file
            { attributes: { language: "NOT A LANG!", files: [{ file_id: 9 }] } },
            { attributes: { language: "en", files: [{ file_id: "x" }] } },
            null,
          ],
        }),
    ]);
    const r = await client().search({ type: "movie", tmdbId: 1, languages: ["en"] });
    expect(r.map((x) => x.fileId)).toEqual([3, 2, 4, 1]);
    expect(r[0]).toMatchObject({ trusted: true, fps: 23.976 });
    expect(r[1].hearingImpaired).toBe(true);
    expect(r[2].aiTranslated).toBe(true);
  });
  it("refuses an empty or malformed language list without calling out", async () => {
    const { calls, client } = pretend([login()]);
    await expect(client().search({ type: "movie", tmdbId: 1, languages: [] })).rejects.toMatchObject({ kind: "not_found" });
    await expect(client().search({ type: "movie", tmdbId: 1, languages: ["../x", "e n"] })).rejects.toMatchObject({ kind: "not_found" });
    expect(calls).toHaveLength(0);
  });
  it("replaces a rejected token once and then gives up with a clear message", async () => {
    let logins = 0;
    const { client } = pretend([
      (u) => (u.pathname === "/api/v1/login" ? json({ token: `t${++logins}` }) : undefined),
      (u, init) => (u.pathname === "/api/v1/subtitles" ? ((init.headers as Record<string, string>).Authorization === "Bearer t2" ? json({ data: [hit(1)] }) : json({}, 401)) : undefined),
    ]);
    expect(await client().search({ type: "movie", tmdbId: 1, languages: ["en"] })).toHaveLength(1);
    expect(logins).toBe(2);
    const stuck = pretend([login(), () => json({}, 401)]);
    await expect(stuck.client().search({ type: "movie", tmdbId: 1, languages: ["en"] })).rejects.toMatchObject({ kind: "auth" });
  });
  it("turns failures into kinds a person can be told about", async () => {
    const bad = pretend([(u) => (u.pathname === "/api/v1/login" ? json({ message: "bad" }, 401) : undefined)]);
    await expect(bad.client().search({ type: "movie", tmdbId: 1, languages: ["en"] })).rejects.toMatchObject({ kind: "auth" });
    const busy = pretend([login(), () => json({}, 429, { "retry-after": "30" })]);
    await expect(busy.client().search({ type: "movie", tmdbId: 1, languages: ["en"] })).rejects.toMatchObject({ kind: "rate", retryAfterSeconds: 30 });
    const broken = pretend([login(), () => new Response("oops", { status: 503 })]);
    await expect(broken.client().search({ type: "movie", tmdbId: 1, languages: ["en"] })).rejects.toMatchObject({ kind: "upstream" });
    const down = new OpenSubtitles(config, async () => {
      throw new Error("network");
    });
    await expect(down.search({ type: "movie", tmdbId: 1, languages: ["en"] })).rejects.toBeInstanceOf(OpenSubtitlesError);
  });
  it("only ever uses one of OpenSubtitles' own hosts, even if the login names another", async () => {
    const { calls, client } = pretend([login("tok", { base_url: "evil.example.com" }), () => json({ data: [] })]);
    await client().search({ type: "movie", tmdbId: 1, languages: ["en"] });
    expect(calls.every((c) => new URL(c.url).hostname === "api.opensubtitles.com")).toBe(true);
    const own = pretend([login("tok", { base_url: "vip-api.opensubtitles.com" }), () => json({ data: [] })]);
    await own.client().search({ type: "movie", tmdbId: 1, languages: ["en"] });
    expect(new URL(own.calls[1].url).hostname).toBe("vip-api.opensubtitles.com");
  });
});

describe("download", () => {
  const srt = "1\n00:00:01,000 --> 00:00:02,000\nHi\n";
  const downloadHandlers = (link: string, over: Record<string, unknown> = {}) => [
    login(),
    (u: URL) => (u.pathname === "/api/v1/download" ? json({ link, file_name: "x.srt", remaining: 18, reset_time: "2026-10-10T00:00:00Z", ...over }) : undefined),
    (u: URL) => (u.hostname === "dl.opensubtitles.org" ? new Response(srt) : undefined),
  ];
  it("asks for the file by id, follows the link, and reports the downloads left", async () => {
    const { calls, client } = pretend(downloadHandlers("https://dl.opensubtitles.org/en/download/sub/1"));
    const d = await client().download(998877);
    expect(new TextDecoder().decode(d.bytes)).toBe(srt);
    expect(d).toMatchObject({ fileName: "x.srt", remaining: 18, resetTime: "2026-10-10T00:00:00Z" });
    expect(JSON.parse(calls.find((c) => c.url.endsWith("/download"))!.init.body as string)).toEqual({ file_id: 998877, sub_format: "srt" });
  });
  it("refuses a download link that isn't https on an OpenSubtitles domain, without fetching it", async () => {
    for (const link of ["http://dl.opensubtitles.org/x", "https://evil.example.com/x", "https://opensubtitles.org.evil.com/x", "file:///etc/passwd", "not a url", "https://169.254.169.254/latest"]) {
      const { calls, client } = pretend(downloadHandlers(link));
      await expect(client().download(1), link).rejects.toMatchObject({ kind: "upstream" });
      expect(calls.some((c) => c.url === link), link).toBe(false);
    }
  });
  it("refuses an oversize file, whether it says so or just keeps sending", async () => {
    const declared = pretend([...downloadHandlers("https://dl.opensubtitles.org/x").slice(0, 2), (u) => (u.hostname === "dl.opensubtitles.org" ? new Response("x", { headers: { "content-length": String(MAX_SUBTITLE_BYTES + 1) } }) : undefined)]);
    await expect(declared.client().download(1)).rejects.toMatchObject({ kind: "upstream", message: expect.stringContaining("too large") });
    const stream = new ReadableStream({ pull: (c) => c.enqueue(new Uint8Array(500_000)) });
    const endless = pretend([...downloadHandlers("https://dl.opensubtitles.org/x").slice(0, 2), (u) => (u.hostname === "dl.opensubtitles.org" ? new Response(stream) : undefined)]);
    await expect(endless.client().download(1)).rejects.toMatchObject({ kind: "upstream", message: expect.stringContaining("too large") });
  });
  it("explains the daily limit, a missing subtitle and a bad id", async () => {
    const limit = pretend([login(), (u) => (u.pathname === "/api/v1/download" ? json({ message: "limit" }, 406) : undefined)]);
    await expect(limit.client().download(1)).rejects.toMatchObject({ kind: "quota" });
    const gone = pretend([login(), (u) => (u.pathname === "/api/v1/download" ? json({}, 404) : undefined)]);
    await expect(gone.client().download(1)).rejects.toMatchObject({ kind: "not_found" });
    for (const id of [0, -3, 1.5, NaN]) await expect(pretend([login()]).client().download(id)).rejects.toMatchObject({ kind: "not_found" });
  });
});
