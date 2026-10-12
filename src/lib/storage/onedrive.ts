/**
 * OneDrive (personal, and work or school) as a storage provider, through Microsoft Graph. A file or folder is identified by its Graph item
 * id, which survives renames and moves; the top of the drive is the alias "root". Streaming uses the pre-authenticated download link
 * Graph puts on each file (good for about an hour, supports Range), so nothing passes through Roam.
 */
import { ListingTruncatedError, type PreviewImage, type StorageEntry, type StorageProvider, type StreamingUrl } from "@/lib/storage/provider";
import { OAuthInvalidGrantError, type OAuthTokens, type Refresher } from "@/lib/storage/oauth-tokens";
import { authorizedCall, StorageHttpError } from "@/lib/storage/http";

const GRAPH = "https://graph.microsoft.com/v1.0";
const AUTHORITY = "https://login.microsoftonline.com/common/oauth2/v2.0";
/** Reading files only; offline_access is what makes Microsoft hand back a refresh token. */
const SCOPES = "offline_access Files.Read.All User.Read";
const LIST_LIMIT = 50_000;
/** A download link lasts about an hour; it is treated as lasting this long so one is never handed out as it dies. */
const LINK_TTL_MS = 45 * 60_000;
const FIELDS = "id,name,size,folder,file,deleted,createdDateTime,lastModifiedDateTime";

const clientId = (): string => {
  const v = process.env.MICROSOFT_CLIENT_ID;
  if (!v) throw new Error("MICROSOFT_CLIENT_ID is not set");
  return v;
};
const clientSecret = (): string => {
  const v = process.env.MICROSOFT_CLIENT_SECRET;
  if (!v) throw new Error("MICROSOFT_CLIENT_SECRET is not set");
  return v;
};

export function onedriveAuthorizeUrl(redirectUri: string, state: string): string {
  const u = new URL(`${AUTHORITY}/authorize`);
  u.search = new URLSearchParams({ client_id: clientId(), response_type: "code", redirect_uri: redirectUri, response_mode: "query", scope: SCOPES, state }).toString();
  return u.toString();
}

async function tokenRequest(form: Record<string, string>): Promise<{ access_token: string; refresh_token?: string; expires_in?: number }> {
  const res = await fetch(`${AUTHORITY}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId(), client_secret: clientSecret(), scope: SCOPES, ...form }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    // "invalid_grant" covers a refresh token that expired, was revoked, or was replaced.
    if ((res.status === 400 || res.status === 401) && /invalid_grant|interaction_required/.test(text)) throw new OAuthInvalidGrantError(text.slice(0, 200));
    throw new Error(`Microsoft sign-in failed (${res.status}): ${text.slice(0, 200)}`);
  }
  return res.json();
}

export async function onedriveExchangeCode(code: string, redirectUri: string): Promise<OAuthTokens> {
  const t = await tokenRequest({ grant_type: "authorization_code", code, redirect_uri: redirectUri });
  return { accessToken: t.access_token, refreshToken: t.refresh_token ?? null, expiresInSeconds: t.expires_in ?? null };
}

/** Microsoft replaces the refresh token each time one is used, so the new one is returned and must be kept. */
export const onedriveRefresher: Refresher = async (refreshToken) => {
  const t = await tokenRequest({ grant_type: "refresh_token", refresh_token: refreshToken });
  return { accessToken: t.access_token, refreshToken: t.refresh_token ?? null, expiresInSeconds: t.expires_in ?? null };
};

/** Who the access token belongs to (their email address), for showing beside the connection. */
export async function onedriveAccountName(accessToken: string): Promise<string | null> {
  const res = await fetch(`${GRAPH}/me?$select=mail,userPrincipalName,displayName`, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) return null;
  const me = (await res.json()) as { mail?: string | null; userPrincipalName?: string; displayName?: string };
  return me.mail ?? me.userPrincipalName ?? me.displayName ?? null;
}

type Item = {
  id: string;
  name: string;
  size?: number;
  folder?: unknown;
  file?: unknown;
  deleted?: unknown;
  createdDateTime?: string;
  lastModifiedDateTime?: string;
  "@microsoft.graph.downloadUrl"?: string;
};

function entryOf(i: Item): StorageEntry | null {
  if (i.deleted) return null;
  const date = (v?: string) => {
    const d = v ? new Date(v) : null;
    return d && !Number.isNaN(d.getTime()) ? d : undefined;
  };
  if (i.folder) return { id: i.id, name: i.name, kind: "folder" };
  if (i.file) return { id: i.id, name: i.name, kind: "file", sizeBytes: i.size, createdAt: date(i.createdDateTime), modifiedAt: date(i.lastModifiedDateTime) };
  return null; // a shortcut to somebody else's item, a OneNote notebook ...
}

const itemPath = (id: string) => `/me/drive/items/${encodeURIComponent(id)}`;
const isNotFound = (err: unknown) => err instanceof StorageHttpError && err.status === 404;

export function createOneDriveProvider(connectionId: string): StorageProvider {
  const links = new Map<string, { url: string; expiresAt: Date }>();
  const get = (url: string): Promise<Response> => authorizedCall(connectionId, onedriveRefresher, "OneDrive", (token) => fetch(url, { headers: { Authorization: `Bearer ${token}` } }));
  const graph = async <T>(path: string): Promise<T> => (await get(`${GRAPH}${path}`)).json() as Promise<T>;

  async function link(fileId: string, fresh = false): Promise<StreamingUrl> {
    const cached = links.get(fileId);
    if (!fresh && cached && cached.expiresAt.getTime() - Date.now() > 5 * 60_000) return cached;
    // No $select: on personal accounts the link is left out of a response that selects fields, even when it is named.
    const item = await graph<Item>(itemPath(fileId));
    const url = item["@microsoft.graph.downloadUrl"];
    if (!url) throw new Error("OneDrive gave no download link for that item");
    const made = { url, expiresAt: new Date(Date.now() + LINK_TTL_MS) };
    links.set(fileId, made);
    return made;
  }

  /** The URL and pixel width of a thumbnail of the given size name, or null when OneDrive has none. */
  async function thumbnailUrl(fileId: string, sizes: string[]): Promise<{ url: string; size: number } | null> {
    try {
      const r = await graph<{ value: Record<string, { url?: string; width?: number } | undefined>[] }>(`${itemPath(fileId)}/thumbnails?$select=${sizes.join(",")}`);
      const set = r.value?.[0];
      for (const name of sizes) {
        const t = set?.[name];
        if (t?.url) return { url: t.url, size: t.width ?? 0 };
      }
      return null;
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }
  const pictureAt = async (fileId: string, sizes: string[]) => {
    const found = await thumbnailUrl(fileId, sizes);
    if (!found) return null;
    const res = await fetch(found.url);
    if (!res.ok) return null;
    return { bytes: new Uint8Array(await res.arrayBuffer()), size: found.size };
  };

  return {
    rootFolderId: () => "root",

    async listFolder(folderId, opts) {
      const out: StorageEntry[] = [];
      let url: string | null = `${GRAPH}${itemPath(folderId)}/children?$top=1000&$select=${FIELDS}`;
      while (url) {
        const page: { value: Item[]; "@odata.nextLink"?: string } = await (await get(url)).json();
        for (const i of page.value) {
          const e = entryOf(i);
          if (e) out.push(e);
        }
        url = page["@odata.nextLink"] ?? null;
        if (url && out.length >= LIST_LIMIT) {
          if (opts?.strict) throw new ListingTruncatedError(folderId);
          break;
        }
      }
      return out;
    },

    async getFolder(folderId) {
      try {
        const i = await graph<Item>(`${itemPath(folderId)}?$select=${FIELDS}`);
        return i.folder ? entryOf(i) : null;
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
      if (res.status !== 206 && res.status !== 200) throw new Error(`OneDrive byte range failed (${res.status})`);
      const bytes = await res.arrayBuffer();
      return res.status === 200 ? bytes.slice(startByte, endByte + 1) : bytes;
    },

    async fetchThumbnail(fileId) {
      const p = await pictureAt(fileId, ["large"]);
      return p ? { contentType: "image/jpeg", bytes: p.bytes } : null;
    },

    async fetchPreview(fileId): Promise<PreviewImage | null> {
      // The largest OneDrive will make: a custom 2048 if it offers one, else its "large" (about 800 pixels).
      const p = await pictureAt(fileId, ["2048x2048", "large"]);
      return p ? { contentType: "image/jpeg", bytes: p.bytes, size: p.size || 800 } : null;
    },

    async fileExists(fileId) {
      try {
        const i = await graph<Item>(`${itemPath(fileId)}?$select=id,deleted`);
        return !i.deleted;
      } catch (err) {
        if (isNotFound(err)) return false;
        throw err;
      }
    },
  };
}
