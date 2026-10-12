/**
 * Google Drive as a storage provider (Drive API v3, read-only). A file or folder is identified by its Drive id, which survives renames
 * and moves; the top of My Drive is the alias "root". Google has no per-file download links, so playback goes through Roam's own
 * stream route with a signed per-file token (see stream-token.ts); everything Roam itself reads (listing, probing bytes, thumbnails)
 * uses the account token directly on the server and never exposes it.
 */
import { ListingTruncatedError, type PreviewImage, type StorageEntry, type StorageProvider } from "@/lib/storage/provider";
import { OAuthInvalidGrantError, accessTokenFor, type OAuthTokens, type Refresher } from "@/lib/storage/oauth-tokens";
import { authorizedCall, StorageHttpError } from "@/lib/storage/http";
import { signStreamToken, streamUrl } from "@/lib/storage/stream-token";

const API = "https://www.googleapis.com/drive/v3";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
/** Read-only access to the files in the account (and in shared drives). */
const SCOPE = "https://www.googleapis.com/auth/drive.readonly";
const LIST_LIMIT = 50_000;
const FOLDER = "application/vnd.google-apps.folder";

const clientId = (): string => {
  const v = process.env.GOOGLE_CLIENT_ID;
  if (!v) throw new Error("GOOGLE_CLIENT_ID is not set");
  return v;
};
const clientSecret = (): string => {
  const v = process.env.GOOGLE_CLIENT_SECRET;
  if (!v) throw new Error("GOOGLE_CLIENT_SECRET is not set");
  return v;
};

export function googleAuthorizeUrl(redirectUri: string, state: string): string {
  const u = new URL(AUTH_URL);
  // offline + consent: Google only hands out a refresh token when asked for one, and not again to an app that was approved before.
  u.search = new URLSearchParams({ client_id: clientId(), redirect_uri: redirectUri, response_type: "code", scope: SCOPE, access_type: "offline", prompt: "consent", include_granted_scopes: "true", state }).toString();
  return u.toString();
}

async function tokenRequest(form: Record<string, string>): Promise<{ access_token: string; refresh_token?: string; expires_in?: number }> {
  const res = await fetch(TOKEN_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: clientId(), client_secret: clientSecret(), ...form }) });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    if (res.status === 400 && /invalid_grant/.test(text)) throw new OAuthInvalidGrantError(text.slice(0, 200));
    throw new Error(`Google sign-in failed (${res.status}): ${text.slice(0, 200)}`);
  }
  return res.json();
}

export async function googleExchangeCode(code: string, redirectUri: string): Promise<OAuthTokens> {
  const t = await tokenRequest({ grant_type: "authorization_code", code, redirect_uri: redirectUri });
  return { accessToken: t.access_token, refreshToken: t.refresh_token ?? null, expiresInSeconds: t.expires_in ?? null };
}

/** Google keeps the same refresh token, so none comes back. */
export const googleRefresher: Refresher = async (refreshToken) => {
  const t = await tokenRequest({ grant_type: "refresh_token", refresh_token: refreshToken });
  return { accessToken: t.access_token, refreshToken: null, expiresInSeconds: t.expires_in ?? null };
};

/** Who the access token belongs to (their email address), for showing beside the connection. */
export async function googleAccountName(accessToken: string): Promise<string | null> {
  const res = await fetch(`${API}/about?fields=user(emailAddress,displayName)`, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) return null;
  const a = (await res.json()) as { user?: { emailAddress?: string; displayName?: string } };
  return a.user?.emailAddress ?? a.user?.displayName ?? null;
}

/** Google answers a quota or rate problem with a 403 carrying one of these reasons. */
const isRateLimit = (status: number, body: string) => status === 403 && /rateLimitExceeded|userRateLimitExceeded|quotaExceeded/.test(body);

type DriveFile = { id: string; name: string; mimeType?: string; size?: string; createdTime?: string; modifiedTime?: string; trashed?: boolean; thumbnailLink?: string };

function entryOf(f: DriveFile): StorageEntry | null {
  if (f.trashed) return null;
  if (f.mimeType === FOLDER) return { id: f.id, name: f.name, kind: "folder" };
  // Google's own documents, sheets and shortcuts have no bytes to read; only real files (which carry a size) are listed.
  if (f.mimeType?.startsWith("application/vnd.google-apps.") || f.size === undefined) return null;
  const date = (v?: string) => {
    const d = v ? new Date(v) : null;
    return d && !Number.isNaN(d.getTime()) ? d : undefined;
  };
  return { id: f.id, name: f.name, kind: "file", sizeBytes: Number(f.size), createdAt: date(f.createdTime), modifiedAt: date(f.modifiedTime) };
}

const isNotFound = (err: unknown) => err instanceof StorageHttpError && err.status === 404;
/** The id goes into a Drive query inside quotes. */
const quoted = (id: string) => `'${id.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
const SHARED = "supportsAllDrives=true";

export function createGoogleDriveProvider(connectionId: string): StorageProvider {
  const call = (build: (token: string) => Promise<Response>) => authorizedCall(connectionId, googleRefresher, "Google Drive", build, isRateLimit);
  const get = (url: string, headers: Record<string, string> = {}) => call((token) => fetch(url, { headers: { Authorization: `Bearer ${token}`, ...headers } }));
  const meta = async (id: string, fields: string): Promise<DriveFile> => (await get(`${API}/files/${encodeURIComponent(id)}?fields=${encodeURIComponent(fields)}&${SHARED}`)).json() as Promise<DriveFile>;

  const link = (fileId: string) => {
    const { token, expiresAt } = signStreamToken(connectionId, fileId);
    return { url: streamUrl(token), expiresAt };
  };

  /** The picture Google made for a file, at a width, or null when it has none or it isn't a JPEG. */
  async function picture(fileId: string, width: number): Promise<Uint8Array | null> {
    let thumb: string | undefined;
    try {
      thumb = (await meta(fileId, "thumbnailLink,trashed")).thumbnailLink;
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
    if (!thumb) return null;
    // The link ends in a size ("=s220"); another can be asked for in its place.
    const sized = thumb.replace(/=s\d+(-[a-z-]*)?$/i, `=s${width}`);
    let res = await fetch(sized);
    if (res.status === 401 || res.status === 403) res = await get(sized);
    if (!res.ok || !(res.headers.get("content-type") ?? "").startsWith("image/jpeg")) return null;
    return new Uint8Array(await res.arrayBuffer());
  }

  return {
    rootFolderId: () => "root",

    async listFolder(folderId, opts) {
      const out: StorageEntry[] = [];
      let pageToken: string | undefined;
      do {
        const params = new URLSearchParams({
          q: `${quoted(folderId)} in parents and trashed = false`,
          fields: "nextPageToken,files(id,name,mimeType,size,createdTime,modifiedTime)",
          pageSize: "1000",
          supportsAllDrives: "true",
          includeItemsFromAllDrives: "true",
        });
        if (pageToken) params.set("pageToken", pageToken);
        const page = (await (await get(`${API}/files?${params}`)).json()) as { files?: DriveFile[]; nextPageToken?: string };
        for (const f of page.files ?? []) {
          const e = entryOf(f);
          if (e) out.push(e);
        }
        pageToken = page.nextPageToken;
        if (pageToken && out.length >= LIST_LIMIT) {
          if (opts?.strict) throw new ListingTruncatedError(folderId);
          break;
        }
      } while (pageToken);
      return out;
    },

    async getFolder(folderId) {
      try {
        const f = await meta(folderId, "id,name,mimeType,trashed");
        return f.mimeType === FOLDER && !f.trashed ? entryOf(f) : null;
      } catch (err) {
        if (isNotFound(err)) return null;
        throw err;
      }
    },

    async getStreamingUrl(fileId) {
      return link(fileId);
    },
    async getFreshDownloadUrl(fileId) {
      return link(fileId);
    },

    async fetchByteRange(fileId, startByte, endByte) {
      const res = await get(`${API}/files/${encodeURIComponent(fileId)}?alt=media&${SHARED}`, { Range: `bytes=${startByte}-${endByte}` });
      const bytes = await res.arrayBuffer();
      return res.status === 200 ? bytes.slice(startByte, endByte + 1) : bytes;
    },

    async fetchThumbnail(fileId) {
      const bytes = await picture(fileId, 480);
      return bytes ? { contentType: "image/jpeg", bytes } : null;
    },

    async fetchPreview(fileId): Promise<PreviewImage | null> {
      const bytes = await picture(fileId, 2048);
      return bytes ? { contentType: "image/jpeg", bytes, size: 2048 } : null;
    },

    async fileExists(fileId) {
      try {
        return !(await meta(fileId, "id,trashed")).trashed;
      } catch (err) {
        if (isNotFound(err)) return false;
        throw err;
      }
    },
  };
}

/** What the stream route needs: Google's bytes for one file, with the caller's Range, using the connection's token. */
export async function googleDownload(connectionId: string, fileId: string, range: string | null): Promise<Response> {
  let forced = false;
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await accessTokenFor(connectionId, googleRefresher, forced);
    const res = await fetch(`${API}/files/${encodeURIComponent(fileId)}?alt=media&${SHARED}`, { headers: { Authorization: `Bearer ${token}`, ...(range ? { Range: range } : {}) } });
    if (res.status === 401 && !forced) {
      forced = true;
      continue;
    }
    return res;
  }
  throw new Error("Google Drive refused the stream");
}
