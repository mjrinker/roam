/** Thin typed wrappers over the playlist API for the client components. Never throws: callers get `{ ok, ... }`. */

export type ApiResult<T> = { ok: true; data: T } | { ok: false; status: number; error: string };

async function call<T>(url: string, init?: RequestInit): Promise<ApiResult<T>> {
  try {
    const res = await fetch(url, {
      ...init,
      headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) return { ok: false, status: res.status, error: typeof body.error === "string" ? body.error : "Something went wrong." };
    return { ok: true, data: body as T };
  } catch {
    return { ok: false, status: 0, error: "Couldn't reach the server." };
  }
}

export type ItemTarget = { titleId: string } | { episodeId: string };

export interface EditablePlaylist {
  id: string;
  name: string;
  itemId: string | null;
}

export interface ItemRow {
  id: string;
  titleId: string | null;
  episodeId: string | null;
  titleKind: "movie" | "show" | "audiobook" | null;
  name: string | null;
  year: number | null;
  posterUrl: string | null;
  seasonNumber: number | null;
  episodeNumber: number | null;
  showName: string | null;
  showId: string | null;
  playable: boolean;
}

export interface MemberRow {
  id: string;
  name: string;
  avatarKey: string;
  role: "viewer" | "sharer" | "editor";
  isMe: boolean;
  grantedByMe: boolean;
}

export interface PickerViewer {
  id: string;
  name: string;
  avatarKey: string;
}

export const playlistApi = {
  create: (serverId: string, name: string) =>
    call<{ id: string; name: string }>(`/api/servers/${serverId}/playlists`, { method: "POST", body: JSON.stringify({ name }) }),

  forItem: (serverId: string, target: ItemTarget) => {
    const q = "titleId" in target ? `titleId=${target.titleId}` : `episodeId=${target.episodeId}`;
    return call<{ playlists: EditablePlaylist[] }>(`/api/servers/${serverId}/playlists/for-item?${q}`);
  },

  addItem: (playlistId: string, target: ItemTarget) =>
    call<{ id: string }>(`/api/playlists/${playlistId}/items`, { method: "POST", body: JSON.stringify(target) }),

  removeItem: (playlistId: string, itemId: string) =>
    call<{ ok: true }>(`/api/playlists/${playlistId}/items/${itemId}`, { method: "DELETE" }),

  moveItem: (playlistId: string, itemId: string, afterItemId: string | null) =>
    call<{ ok: true }>(`/api/playlists/${playlistId}/items`, { method: "PATCH", body: JSON.stringify({ itemId, afterItemId }) }),

  items: (playlistId: string, after: string | null) =>
    call<{ items: ItemRow[]; nextCursor: string | null }>(`/api/playlists/${playlistId}/items${after ? `?after=${encodeURIComponent(after)}` : ""}`),

  rename: (playlistId: string, name: string) =>
    call<{ id: string; name: string }>(`/api/playlists/${playlistId}`, { method: "PATCH", body: JSON.stringify({ name }) }),

  remove: (playlistId: string) => call<{ ok: true }>(`/api/playlists/${playlistId}`, { method: "DELETE" }),

  copy: (playlistId: string) => call<{ id: string; name: string; itemsCopied: number }>(`/api/playlists/${playlistId}/copy`, { method: "POST", body: "{}" }),

  leave: (playlistId: string) => call<{ ok: true }>(`/api/playlists/${playlistId}/members`, { method: "DELETE" }),

  setVisibility: (playlistId: string, visibility: "private" | "server") =>
    call<{ id: string; visibility: "private" | "server" }>(`/api/playlists/${playlistId}`, { method: "PATCH", body: JSON.stringify({ visibility }) }),

  members: (playlistId: string, after: string | null) =>
    call<{ members: MemberRow[]; nextCursor: string | null }>(`/api/playlists/${playlistId}/members${after ? `?after=${encodeURIComponent(after)}` : ""}`),

  share: (playlistId: string, viewerId: string, role: MemberRow["role"]) =>
    call<{ viewerId: string; role: MemberRow["role"] }>(`/api/playlists/${playlistId}/members`, { method: "POST", body: JSON.stringify({ viewerId, role }) }),

  changeRole: (playlistId: string, viewerId: string, role: MemberRow["role"]) =>
    call<{ viewerId: string; role: MemberRow["role"] }>(`/api/playlists/${playlistId}/members`, { method: "PATCH", body: JSON.stringify({ viewerId, role }) }),

  removeMember: (playlistId: string, viewerId: string) =>
    call<{ ok: true }>(`/api/playlists/${playlistId}/members?viewerId=${viewerId}`, { method: "DELETE" }),

  picker: (serverId: string, after: string | null) =>
    call<{ viewers: PickerViewer[]; nextCursor: string | null }>(`/api/servers/${serverId}/viewers${after ? `?after=${encodeURIComponent(after)}` : ""}`),

  transfer: (playlistId: string, viewerId: string) =>
    call<{ ok: true }>(`/api/playlists/${playlistId}/transfer`, { method: "POST", body: JSON.stringify({ viewerId }) }),
};
