/**
 * A small client for the OpenSubtitles REST API (v1): log in for a token, search by TMDB id, download one file. The network is injected,
 * so everything here is tested with pretend responses. Nothing the service sends back is trusted: hosts are checked before they are
 * contacted, bodies are size-limited, and a downloaded file still goes through the subtitle reader.
 */
import { MAX_SUBTITLE_BYTES } from "./cues";

export interface OpenSubtitlesConfig {
  apiKey: string;
  username: string;
  password: string;
}

/** The credentials from the environment, or null when OpenSubtitles isn't set up (searching is then off; uploads still work). */
export function openSubtitlesConfig(env: Record<string, string | undefined> = process.env): OpenSubtitlesConfig | null {
  const apiKey = env.OPENSUBTITLES_API_KEY?.trim();
  const username = env.OPENSUBTITLES_USERNAME?.trim();
  const password = env.OPENSUBTITLES_PASSWORD;
  return apiKey && username && password ? { apiKey, username, password } : null;
}

export type OpenSubtitlesErrorKind = "not_configured" | "auth" | "quota" | "rate" | "not_found" | "upstream";
export class OpenSubtitlesError extends Error {
  constructor(readonly kind: OpenSubtitlesErrorKind, message: string, readonly retryAfterSeconds?: number) {
    super(message);
  }
}

export interface SubtitleSearch {
  type: "movie" | "episode";
  tmdbId?: number;
  /** For an episode: the show's TMDB id, with the season and episode numbers. */
  parentTmdbId?: number;
  season?: number;
  episode?: number;
  /** A title to search by when there is no TMDB id. */
  query?: string;
  /** Two-letter language codes ("en", "es", "pt-BR"). */
  languages: string[];
}

export interface SubtitleResult {
  fileId: number;
  language: string;
  release: string;
  fileName: string;
  downloads: number;
  hearingImpaired: boolean;
  aiTranslated: boolean;
  trusted: boolean;
  fps: number | null;
}

export interface SubtitleDownload {
  bytes: Uint8Array;
  fileName: string;
  /** Downloads left today, as OpenSubtitles reports it (null when it doesn't say). */
  remaining: number | null;
  resetTime: string | null;
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

const API_HOST = "api.opensubtitles.com";
const APP_NAME = "Roam v1.0";
const TIMEOUT_MS = 15_000;
const TOKEN_TTL_MS = 20 * 3600 * 1000;
const MAX_RESULTS = 30;
const LANGUAGE = /^[a-z]{2,3}(-[a-z]{2,4})?$/i;

const isOpenSubtitlesHost = (host: string) => host === "opensubtitles.com" || host.endsWith(".opensubtitles.com") || host === "opensubtitles.org" || host.endsWith(".opensubtitles.org");

export class OpenSubtitles {
  private token: { value: string; host: string; at: number } | null = null;

  constructor(private readonly config: OpenSubtitlesConfig, private readonly fetchImpl: FetchLike = fetch, private readonly now: () => number = Date.now) {}

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { "Api-Key": this.config.apiKey, "User-Agent": APP_NAME, "Content-Type": "application/json", Accept: "application/json", ...extra };
  }

  private async request(url: string, init: RequestInit): Promise<Response> {
    try {
      return await this.fetchImpl(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch {
      throw new OpenSubtitlesError("upstream", "Couldn't reach OpenSubtitles. Try again in a moment.");
    }
  }

  /** Logs in (once, then the token is reused for most of a day). */
  private async login(force = false): Promise<{ value: string; host: string }> {
    if (!force && this.token && this.now() - this.token.at < TOKEN_TTL_MS) return this.token;
    const res = await this.request(`https://${API_HOST}/api/v1/login`, { method: "POST", headers: this.headers(), body: JSON.stringify({ username: this.config.username, password: this.config.password }) });
    if (res.status === 401 || res.status === 403 || res.status === 400) throw new OpenSubtitlesError("auth", "OpenSubtitles didn't accept the username and password (or the API key) set for this server.");
    if (res.status === 429) throw new OpenSubtitlesError("rate", "OpenSubtitles is busy. Try again in a moment.", Number(res.headers.get("retry-after")) || undefined);
    if (!res.ok) throw new OpenSubtitlesError("upstream", `OpenSubtitles had a problem (${res.status}).`);
    const body = (await res.json().catch(() => null)) as { token?: unknown; base_url?: unknown } | null;
    if (!body || typeof body.token !== "string" || body.token === "") throw new OpenSubtitlesError("upstream", "OpenSubtitles sent an unexpected reply.");
    // The account's own server, as the service names it: only ever one of OpenSubtitles' own hosts.
    const named = typeof body.base_url === "string" ? body.base_url.replace(/^https?:\/\//, "").replace(/\/.*$/, "") : API_HOST;
    this.token = { value: body.token, host: isOpenSubtitlesHost(named) ? named : API_HOST, at: this.now() };
    return this.token;
  }

  /** Runs a call that needs the token; a rejected token (it may have expired early) is replaced once. */
  private async authed(path: string, init: RequestInit): Promise<Response> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const t = await this.login(attempt > 0);
      const res = await this.request(`https://${t.host}/api/v1${path}`, { ...init, headers: this.headers({ Authorization: `Bearer ${t.value}`, ...((init.headers as Record<string, string>) ?? {}) }) });
      if (res.status !== 401) return res;
    }
    throw new OpenSubtitlesError("auth", "OpenSubtitles didn't accept the login.");
  }

  async search(q: SubtitleSearch): Promise<SubtitleResult[]> {
    const languages = q.languages.map((l) => l.trim().toLowerCase()).filter((l) => LANGUAGE.test(l));
    if (languages.length === 0) throw new OpenSubtitlesError("not_found", "Choose at least one language.");
    // Parameters must be in alphabetical order, lower case, as the service documents.
    const p = new URLSearchParams();
    if (q.type === "episode") {
      if (q.episode !== undefined) p.set("episode_number", String(q.episode));
      if (q.parentTmdbId !== undefined) p.set("parent_tmdb_id", String(q.parentTmdbId));
      if (q.season !== undefined) p.set("season_number", String(q.season));
    }
    p.set("languages", languages.join(",").toLowerCase());
    if (q.query && q.tmdbId === undefined && q.parentTmdbId === undefined) p.set("query", q.query.slice(0, 200));
    if (q.type === "movie" && q.tmdbId !== undefined) p.set("tmdb_id", String(q.tmdbId));
    p.set("type", q.type);
    const sorted = new URLSearchParams([...p.entries()].sort(([a], [b]) => a.localeCompare(b)));
    const res = await this.authed(`/subtitles?${sorted.toString()}`, { method: "GET" });
    if (res.status === 429) throw new OpenSubtitlesError("rate", "OpenSubtitles is busy. Try again in a moment.", Number(res.headers.get("retry-after")) || undefined);
    if (!res.ok) throw new OpenSubtitlesError("upstream", `OpenSubtitles had a problem (${res.status}).`);
    const body = (await res.json().catch(() => null)) as { data?: unknown } | null;
    const rows = Array.isArray(body?.data) ? (body!.data as unknown[]) : [];
    const results: SubtitleResult[] = [];
    for (const row of rows) {
      const a = (row as { attributes?: Record<string, unknown> })?.attributes;
      const file = Array.isArray(a?.files) ? (a!.files as { file_id?: unknown; file_name?: unknown }[])[0] : undefined;
      if (!a || !file || typeof file.file_id !== "number" || typeof a.language !== "string" || !LANGUAGE.test(a.language)) continue;
      const fps = typeof a.fps === "number" && a.fps > 0 ? a.fps : null;
      results.push({
        fileId: file.file_id,
        language: a.language,
        release: typeof a.release === "string" ? a.release.slice(0, 200) : "",
        fileName: typeof file.file_name === "string" ? file.file_name.slice(0, 200) : "",
        downloads: typeof a.download_count === "number" ? a.download_count : 0,
        hearingImpaired: a.hearing_impaired === true,
        aiTranslated: a.ai_translated === true || a.machine_translated === true,
        trusted: a.from_trusted === true,
        fps,
      });
    }
    // Trusted uploaders first, then the most downloaded.
    return results.sort((x, y) => Number(y.trusted) - Number(x.trusted) || y.downloads - x.downloads).slice(0, MAX_RESULTS);
  }

  /** One subtitle file, as SRT bytes. Uses one of the account's daily downloads. */
  async download(fileId: number): Promise<SubtitleDownload> {
    if (!Number.isInteger(fileId) || fileId <= 0) throw new OpenSubtitlesError("not_found", "That subtitle isn't available.");
    const res = await this.authed("/download", { method: "POST", body: JSON.stringify({ file_id: fileId, sub_format: "srt" }) });
    if (res.status === 406) throw new OpenSubtitlesError("quota", "The daily OpenSubtitles download limit has been reached. It resets within a day.");
    if (res.status === 429) throw new OpenSubtitlesError("rate", "OpenSubtitles is busy. Try again in a moment.", Number(res.headers.get("retry-after")) || undefined);
    if (res.status === 404) throw new OpenSubtitlesError("not_found", "That subtitle isn't available any more.");
    if (!res.ok) throw new OpenSubtitlesError("upstream", `OpenSubtitles had a problem (${res.status}).`);
    const body = (await res.json().catch(() => null)) as { link?: unknown; file_name?: unknown; remaining?: unknown; reset_time?: unknown } | null;
    let link: URL;
    try {
      link = new URL(String(body?.link));
    } catch {
      throw new OpenSubtitlesError("upstream", "OpenSubtitles sent an unexpected reply.");
    }
    // The link is followed only if it is an https address on OpenSubtitles' own domains.
    if (link.protocol !== "https:" || !isOpenSubtitlesHost(link.hostname)) throw new OpenSubtitlesError("upstream", "OpenSubtitles sent an unexpected download address.");
    const file = await this.request(link.toString(), { method: "GET", redirect: "manual", headers: { "User-Agent": APP_NAME } }); // a redirect is not followed: it would leave the checked host
    if (!file.ok) throw new OpenSubtitlesError("upstream", `The subtitle file couldn't be fetched (${file.status}).`);
    const bytes = await readLimited(file, MAX_SUBTITLE_BYTES);
    if (bytes === null) throw new OpenSubtitlesError("upstream", "That subtitle file is too large.");
    return {
      bytes,
      fileName: typeof body?.file_name === "string" ? body.file_name.slice(0, 200) : "",
      remaining: typeof body?.remaining === "number" ? body.remaining : null,
      resetTime: typeof body?.reset_time === "string" ? body.reset_time : null,
    };
  }
}

/** A response body, or null when it runs past `max` bytes (it is read in pieces and abandoned as soon as it does). */
async function readLimited(res: Response, max: number): Promise<Uint8Array | null> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) return null;
  if (!res.body) return new Uint8Array(await res.arrayBuffer());
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}
