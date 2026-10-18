/**
 * A small client for Trakt (trakt.tv): sign in with a code (the device flow, so nothing is typed on a TV or phone), send what a profile has
 * watched and rated, and read its history. The network is injected so everything is tested with pretend answers.
 */
import type { ItemRef, ProfileData, TitleRef } from "@/lib/backup/format";
import { emptyData } from "@/lib/backup/format";

const API = "https://api.trakt.tv";

export interface TraktConfig {
  clientId: string;
  clientSecret: string;
}

/** The credentials from the environment, or null when Trakt isn't set up on this server. */
export function traktConfig(env: Record<string, string | undefined> = process.env): TraktConfig | null {
  const clientId = env.TRAKT_CLIENT_ID?.trim();
  const clientSecret = env.TRAKT_CLIENT_SECRET?.trim();
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

export class TraktError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export interface TraktTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
}

export interface DeviceCode {
  deviceCode: string;
  userCode: string;
  verificationUrl: string;
  expiresIn: number;
  interval: number;
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export class Trakt {
  constructor(private readonly config: TraktConfig, private readonly fetchImpl: FetchLike = fetch, private readonly now: () => Date = () => new Date()) {}

  private async call(path: string, init: { method?: string; body?: unknown; token?: string } = {}): Promise<Response> {
    const res = await this.fetchImpl(`${API}${path}`, {
      method: init.method ?? (init.body === undefined ? "GET" : "POST"),
      headers: { "Content-Type": "application/json", "trakt-api-version": "2", "trakt-api-key": this.config.clientId, ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}) },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(20_000),
    }).catch(() => {
      throw new TraktError(0, "Couldn't reach Trakt. Try again in a moment.");
    });
    return res;
  }

  private tokens(body: { access_token: string; refresh_token: string; expires_in: number; created_at?: number }): TraktTokens {
    const created = body.created_at ? body.created_at * 1000 : this.now().getTime();
    return { accessToken: body.access_token, refreshToken: body.refresh_token, expiresAt: new Date(created + body.expires_in * 1000) };
  }

  async startDevice(): Promise<DeviceCode> {
    const res = await this.call("/oauth/device/code", { body: { client_id: this.config.clientId } });
    if (!res.ok) throw new TraktError(res.status, "Trakt didn't start the sign-in.");
    const b = (await res.json()) as { device_code: string; user_code: string; verification_url: string; expires_in: number; interval: number };
    return { deviceCode: b.device_code, userCode: b.user_code, verificationUrl: b.verification_url, expiresIn: b.expires_in, interval: b.interval };
  }

  /** Whether the code has been approved yet: tokens when it has, "pending" while waiting, "expired" (or denied) when it can't be. */
  async pollDevice(deviceCode: string): Promise<TraktTokens | "pending" | "expired"> {
    const res = await this.call("/oauth/device/token", { body: { code: deviceCode, client_id: this.config.clientId, client_secret: this.config.clientSecret } });
    if (res.status === 200) return this.tokens(await res.json());
    if (res.status === 400 || res.status === 429) return "pending";
    if ([404, 409, 410, 418].includes(res.status)) return "expired";
    throw new TraktError(res.status, "Trakt had a problem.");
  }

  async refresh(refreshToken: string): Promise<TraktTokens> {
    const res = await this.call("/oauth/token", { body: { refresh_token: refreshToken, client_id: this.config.clientId, client_secret: this.config.clientSecret, redirect_uri: "urn:ietf:wg:oauth:2.0:oob", grant_type: "refresh_token" } });
    if (!res.ok) throw new TraktError(res.status, "Trakt no longer accepts this connection: connect it again.");
    return this.tokens(await res.json());
  }

  async username(token: string): Promise<string | null> {
    const res = await this.call("/users/settings", { token });
    if (!res.ok) return null;
    return ((await res.json()) as { user?: { username?: string } }).user?.username ?? null;
  }

  /** Sends one finished movie or episode to the history. */
  async addToHistory(token: string, ref: ItemRef, watchedAt: Date): Promise<void> {
    const body = historyBody(ref, watchedAt);
    if (!body) return;
    const res = await this.call("/sync/history", { token, body });
    if (!res.ok) throw new TraktError(res.status, "Trakt didn't take that.");
  }

  /** Sends a rating (1 to 10) for a movie, show or episode. */
  async rate(token: string, ref: ItemRef, rating: number): Promise<void> {
    const ids = ref.tmdbId ? { tmdb: ref.tmdbId } : null;
    if (!ids) return;
    const body = ref.kind === "episode" ? { shows: [{ ids, seasons: [{ number: ref.season, episodes: [{ number: ref.number, rating }] }] }] } : ref.kind === "movie" ? { movies: [{ ids, rating }] } : { shows: [{ ids, rating }] };
    const res = await this.call("/sync/ratings", { token, body });
    if (!res.ok) throw new TraktError(res.status, "Trakt didn't take that.");
  }

  /** Everything watched and rated on Trakt, as a profile's data (movies, shows' episodes and ratings of movies and shows). */
  async pull(token: string): Promise<ProfileData> {
    const get = async <T,>(path: string): Promise<T[]> => {
      const res = await this.call(path, { token });
      if (!res.ok) throw new TraktError(res.status, "Couldn't read your Trakt history.");
      return (await res.json()) as T[];
    };
    const ref = (m: { title?: string; year?: number | null; ids?: { tmdb?: number | null } }, kind: "movie" | "show"): TitleRef => ({ kind, title: m.title ?? "", year: m.year ?? null, tmdbId: m.ids?.tmdb ?? null });
    const data = emptyData();
    type Movie = { title?: string; year?: number | null; ids?: { tmdb?: number | null } };
    for (const w of await get<{ last_watched_at?: string; movie: Movie }>("/sync/watched/movies")) {
      if (w.movie?.title) data.watched.push({ ref: ref(w.movie, "movie"), finished: true, positionSeconds: 0, durationSeconds: null, at: w.last_watched_at ?? null });
    }
    for (const w of await get<{ show: Movie; seasons?: { number: number; episodes?: { number: number; last_watched_at?: string }[] }[] }>("/sync/watched/shows")) {
      if (!w.show?.title) continue;
      for (const s of w.seasons ?? []) for (const e of s.episodes ?? []) data.watched.push({ ref: { ...ref(w.show, "show"), kind: "episode", season: s.number, number: e.number }, finished: true, positionSeconds: 0, durationSeconds: null, at: e.last_watched_at ?? null });
    }
    for (const r of await get<{ rating: number; movie: Movie }>("/sync/ratings/movies")) if (r.movie?.title && r.rating >= 1 && r.rating <= 10) data.ratings.push({ ref: ref(r.movie, "movie"), halfStars: r.rating });
    for (const r of await get<{ rating: number; show: Movie }>("/sync/ratings/shows")) if (r.show?.title && r.rating >= 1 && r.rating <= 10) data.ratings.push({ ref: ref(r.show, "show"), halfStars: r.rating });
    return data;
  }
}

/** The history request for one item (null when there is no TMDB id to name it by). */
export function historyBody(ref: ItemRef, watchedAt: Date): Record<string, unknown> | null {
  if (!ref.tmdbId) return null;
  const at = watchedAt.toISOString();
  if (ref.kind === "movie") return { movies: [{ ids: { tmdb: ref.tmdbId }, watched_at: at }] };
  if (ref.kind !== "episode") return null;
  return { shows: [{ ids: { tmdb: ref.tmdbId }, seasons: [{ number: ref.season, episodes: [{ number: ref.number, watched_at: at }] }] }] };
}
