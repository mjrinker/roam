/** Who is using a TV page, and for which server: the checks every TV page makes before it reads anything. */
import { getCurrentViewer } from "@/lib/auth/viewer";
import { getServerMembership } from "@/lib/auth/guards";
import { normalizePrefs, type ContentFilterPrefs } from "@/lib/content-filter/categories";
import { libraryActor } from "@/lib/content/library-access";
import type { TvScope } from "@/lib/tv/data";
import { html, redirectTo } from "@/lib/tv/http";
import { messagePage } from "@/tv/render";

export const notFoundPage = () => html(messagePage("Not found", "That isn't available.", { href: "/tv", label: "Home" }), 404);

/** What a TV page knows about who is looking, beyond the scope its queries use. */
export interface TvWho {
  accountId: string;
  isAdmin: boolean;
  /** A child's profile: it can look, not change who owns what. */
  limited: boolean;
  filterPrefs: ContentFilterPrefs;
}

export type TvAccess = { ok: true; scope: TvScope; base: string; profileName: string; serverId: string; who: TvWho } | { ok: false; response: Response };

export type Resolved =
  | { ok: true; scope: TvScope; profileName: string; serverId: string; who: TvWho }
  | { ok: false; reason: "signed_out" | "no_profile" | "not_member" };

/** Who is asking and whether they belong to the server: the checks every TV page and every /api/v1 route makes before reading anything. */
export async function resolveAccess(serverId: string): Promise<Resolved> {
  const resolved = await getCurrentViewer();
  if (!resolved) return { ok: false, reason: "signed_out" };
  if (!resolved.viewer) return { ok: false, reason: "no_profile" };
  const membership = await getServerMembership(resolved.account.id, serverId);
  if (!membership) return { ok: false, reason: "not_member" };
  return {
    ok: true,
    serverId,
    profileName: resolved.viewer.name,
    who: { accountId: resolved.account.id, isAdmin: membership.role === "admin", limited: resolved.viewer.role === "limited", filterPrefs: normalizePrefs(resolved.viewer.contentFilter) },
    scope: { actor: libraryActor({ profile: resolved.account, role: membership.role }, serverId), viewer: resolved.viewer, viewerId: resolved.viewer.id },
  };
}

/** Signed out goes to the pairing screen, no chosen profile to the profile screen, a server you're not in to "not found". */
export async function tvAccess(request: Request, serverId: string): Promise<TvAccess> {
  const r = await resolveAccess(serverId);
  if (!r.ok) return { ok: false, response: r.reason === "signed_out" ? redirectTo(request, "/tv/pair") : r.reason === "no_profile" ? redirectTo(request, "/tv/profiles") : notFoundPage() };
  return { ok: true, serverId, base: `/tv/s/${serverId}`, profileName: r.profileName, scope: r.scope, who: r.who };
}

/** A path parameter that is a UUID, or null: anything else is "not found" without touching the database. */
export const asUuid = (v: string): string | null => (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v) ? v : null);
