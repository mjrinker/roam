/**
 * Dropbox as a storage provider. Talks to Dropbox's HTTP API directly (no SDK): list a folder, mint a temporary direct link for
 * streaming (good for four hours, supports Range), read a few bytes, fetch a thumbnail. A file or folder is identified by its Dropbox id
 * ("id:..."), which survives renames and moves; the top of the account is the empty path.
 */
import { ListingTruncatedError, type PreviewImage, type StorageEntry, type StorageProvider, type StreamingUrl } from "@/lib/storage/provider";
import { OAuthInvalidGrantError, type OAuthTokens, type Refresher } from "@/lib/storage/oauth-tokens";
import { authorizedCall, StorageHttpError } from "@/lib/storage/http";

const API = "https://api.dropboxapi.com/2";
const CONTENT = "https://content.dropboxapi.com/2";
const TOKEN_URL = "https://api.dropboxapi.com/oauth2/token";
/** The most entries one folder listing returns before it is cut off (or, strictly, refused). */
const LIST_LIMIT = 50_000;
/** A temporary link lasts four hours; this much is taken off so one is never handed out just as it dies. */
const LINK_TTL_MS = (4 * 60 - 20) * 60_000;

export const dropboxAppKey = (): string => {
  const v = process.env.DROPBOX_APP_KEY;
  if (!v) throw new Error("DROPBOX_APP_KEY is not set");
  return v;
};
const appSecret = (): string => {
  const v = process.env.DROPBOX_APP_SECRET;
  if (!v) throw new Error("DROPBOX_APP_SECRET is not set");
  return v;
};

/** Where to send an admin to approve access. Dropbox is told to ask who is signing in every time, so a second account can be connected from a browser that is already signed in to the first. `redirectUri` must be one registered on the Dropbox app. */
export function dropboxAuthorizeUrl(redirectUri: string, state: string): string {
  const u = new URL("https://www.dropbox.com/oauth2/authorize");
  u.search = new URLSearchParams({ client_id: dropboxAppKey(), response_type: "code", token_access_type: "offline", redirect_uri: redirectUri, state, force_reauthentication: "true", force_reapprove: "true" }).toString();
  return u.toString();
}

async function tokenRequest(form: Record<string, string>): Promise<{ access_token: string; refresh_token?: string; expires_in?: number; account_id?: string }> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Basic ${Buffer.from(`${dropboxAppKey()}:${appSecret()}`).toString("base64")}` },
    body: new URLSearchParams(form),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    if (res.status === 400 && /invalid_grant/.test(text)) throw new OAuthInvalidGrantError(text.slice(0, 200));
    throw new Error(`Dropbox sign-in failed (${res.status}): ${text.slice(0, 200)}`);
  }
  return res.json();
}

/** Trades the code Dropbox sent back after the admin approved access for the tokens. */
export async function dropboxExchangeCode(code: string, redirectUri: string): Promise<OAuthTokens> {
  const t = await tokenRequest({ grant_type: "authorization_code", code, redirect_uri: redirectUri });
  return { accessToken: t.access_token, refreshToken: t.refresh_token ?? null, expiresInSeconds: t.expires_in ?? null };
}

/** Unlinks the account from Roam's Dropbox app (the access token stops working, and the account stops counting against the app's user limit). */
export async function dropboxRevoke(accessToken: string): Promise<void> {
  const res = await fetch(`${API}/auth/token/revoke`, { method: "POST", headers: { Authorization: `Bearer ${accessToken}` } });
  // An already-dead token answers 401: nothing left to unlink.
  if (!res.ok && res.status !== 401) throw new Error(`Dropbox revoke failed (${res.status})`);
}

export const dropboxRefresher: Refresher = async (refreshToken) => {
  const t = await tokenRequest({ grant_type: "refresh_token", refresh_token: refreshToken });
  // Dropbox keeps the same refresh token, so none comes back.
  return { accessToken: t.access_token, refreshToken: null, expiresInSeconds: t.expires_in ?? null };
};

/** Who the access token belongs to (their email address), for showing beside the connection. */
export async function dropboxAccountName(accessToken: string): Promise<string | null> {
  const res = await fetch(`${API}/users/get_current_account`, { method: "POST", headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) return null;
  const a = (await res.json()) as { email?: string; name?: { display_name?: string } };
  return a.email ?? a.name?.display_name ?? null;
}

async function call(connectionId: string, build: (token: string) => Promise<Response>): Promise<Response> {
  try {
    return await authorizedCall(connectionId, dropboxRefresher, "Dropbox", build);
  } catch (err) {
    // The app was approved before it was given this permission: signing in again (after turning it on) is the fix.
    const scope = err instanceof StorageHttpError && err.status === 400 ? /required scope '([\w.]+)'/.exec(err.body)?.[1] : null;
    if (scope) throw new StorageHttpError(`The Dropbox app doesn't have the "${scope}" permission. Turn it on in the app's Permissions tab on dropbox.com/developers, press Submit, then use Reconnect on this connection.`, 400, err instanceof StorageHttpError ? err.body : "");
    throw err;
  }
}

const rpc = async <T>(connectionId: string, route: string, body: unknown): Promise<T> =>
  (await call(connectionId, (token) => fetch(`${API}${route}`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) }))).json() as Promise<T>;

type Meta = { ".tag": "file" | "folder" | "deleted"; id?: string; name: string; size?: number; client_modified?: string; server_modified?: string };

function entryOf(m: Meta): StorageEntry | null {
  if ((m[".tag"] !== "file" && m[".tag"] !== "folder") || !m.id) return null;
  const date = (v?: string) => {
    const d = v ? new Date(v) : null;
    return d && !Number.isNaN(d.getTime()) ? d : undefined;
  };
  return m[".tag"] === "folder"
    ? { id: m.id, name: m.name, kind: "folder" }
    : { id: m.id, name: m.name, kind: "file", sizeBytes: m.size, createdAt: date(m.client_modified), modifiedAt: date(m.server_modified) };
}

const isNotFound = (err: unknown) => err instanceof StorageHttpError && err.status === 409 && /not_found/.test(err.body);

export function createDropboxProvider(connectionId: string): StorageProvider {
  const links = new Map<string, { url: string; expiresAt: Date }>();

  async function link(fileId: string, fresh = false): Promise<StreamingUrl> {
    const cached = links.get(fileId);
    if (!fresh && cached && cached.expiresAt.getTime() - Date.now() > 10 * 60_000) return cached;
    const r = await rpc<{ link: string }>(connectionId, "/files/get_temporary_link", { path: fileId });
    const made = { url: r.link, expiresAt: new Date(Date.now() + LINK_TTL_MS) };
    links.set(fileId, made);
    return made;
  }

  async function thumbnail(fileId: string, size: string): Promise<Uint8Array | null> {
    try {
      const res = await call(connectionId, (token) =>
        fetch(`${CONTENT}/files/get_thumbnail_v2`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Dropbox-API-Arg": JSON.stringify({ resource: { ".tag": "path", path: fileId }, format: "jpeg", size, mode: "bestfit" }) },
        })
      );
      return new Uint8Array(await res.arrayBuffer());
    } catch (err) {
      // Not a kind of file Dropbox makes pictures of, or not ready: no picture, not an error.
      if (err instanceof StorageHttpError && err.status === 409) return null;
      throw err;
    }
  }

  return {
    rootFolderId: () => "",

    async listFolder(folderId, opts) {
      const out: StorageEntry[] = [];
      let r = await rpc<{ entries: Meta[]; cursor: string; has_more: boolean }>(connectionId, "/files/list_folder", { path: folderId, recursive: false, include_deleted: false, limit: 2000 });
      for (;;) {
        for (const m of r.entries) {
          const e = entryOf(m);
          if (e) out.push(e);
        }
        if (!r.has_more) break;
        if (out.length >= LIST_LIMIT) {
          if (opts?.strict) throw new ListingTruncatedError(folderId);
          break;
        }
        r = await rpc(connectionId, "/files/list_folder/continue", { cursor: r.cursor });
      }
      return out;
    },

    async getFolder(folderId) {
      try {
        const m = await rpc<Meta>(connectionId, "/files/get_metadata", { path: folderId });
        return m[".tag"] === "folder" ? entryOf(m) : null;
      } catch (err) {
        if (isNotFound(err)) return null;
        throw err;
      }
    },

    getStreamingUrl: (fileId) => link(fileId),
    getFreshDownloadUrl: (fileId) => link(fileId, true),

    async fetchByteRange(fileId, startByte, endByte) {
      const { url } = await link(fileId);
      const res = await fetch(url, { headers: { Range: `bytes=${startByte}-${endByte}` } });
      if (res.status !== 206 && res.status !== 200) throw new Error(`Dropbox byte range failed (${res.status})`);
      const bytes = await res.arrayBuffer();
      // A server that ignores Range sends the whole file; keep only what was asked for.
      return res.status === 200 ? bytes.slice(startByte, endByte + 1) : bytes;
    },

    async fetchThumbnail(fileId) {
      const bytes = await thumbnail(fileId, "w480h320");
      return bytes ? { contentType: "image/jpeg", bytes } : null;
    },

    async fetchPreview(fileId): Promise<PreviewImage | null> {
      const bytes = await thumbnail(fileId, "w2048h1536");
      return bytes ? { contentType: "image/jpeg", bytes, size: 2048 } : null;
    },

    async fileExists(fileId) {
      try {
        const m = await rpc<Meta>(connectionId, "/files/get_metadata", { path: fileId });
        return m[".tag"] !== "deleted";
      } catch (err) {
        if (isNotFound(err)) return false;
        throw err;
      }
    },
  };
}
