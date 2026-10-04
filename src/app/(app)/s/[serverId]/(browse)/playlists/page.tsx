import Link from "next/link";
import { notFound } from "next/navigation";
import { Globe, ListVideo, Lock, ShieldCheck } from "lucide-react";
import { db } from "@/lib/db/client";
import { requireServerMember } from "@/lib/auth/guards";
import { decodeCursor, encodeCursor } from "@/lib/playlists/http";
import { listPlaylists, type ListScope } from "@/lib/playlists/service";
import { Badge } from "@/components/ui/badge";
import { Breadcrumbs } from "@/components/shell/breadcrumbs";
import { NewPlaylistButton } from "@/components/playlists/new-playlist-button";
import { cn } from "@/lib/utils";
import { z } from "zod";

const TABS: { scope: ListScope; label: string }[] = [
  { scope: "all", label: "All" },
  { scope: "mine", label: "Mine" },
  { scope: "shared", label: "Shared with me" },
  { scope: "public", label: "Everyone on this server" },
];
const cursorSchema = z.object({ updatedAt: z.string().datetime(), id: z.string().uuid() });

export default async function PlaylistsPage({
  params,
  searchParams,
}: PageProps<"/s/[serverId]/playlists">) {
  const { serverId } = await params;
  const query = await searchParams;
  const { viewer, role } = await requireServerMember(serverId);

  const scopeParam = typeof query.scope === "string" ? query.scope : "all";
  const scope = TABS.some((t) => t.scope === scopeParam) ? (scopeParam as ListScope) : "all";
  const after = decodeCursor(typeof query.after === "string" ? query.after : null, cursorSchema);

  const result = await listPlaylists(db, {
    serverId,
    viewerId: viewer.id,
    scope,
    limit: 48,
    after: after === "invalid" ? null : after,
  });
  if (!result.ok) notFound();
  const { playlists, nextCursor } = result.value;

  const base = `/s/${serverId}/playlists`;
  return (
    <div className="flex flex-col gap-6 px-4 py-8 sm:px-8">
      <Breadcrumbs serverId={serverId} trail={[{ label: "Playlists" }]} className="-mb-2" />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="flex size-10 items-center justify-center rounded-xl bg-white/[0.06] ring-1 ring-white/10">
            <ListVideo className="size-5 text-primary" />
          </span>
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Playlists</h1>
        </div>
        <div className="flex items-center gap-2">
          {role === "admin" && viewer.role !== "limited" && (
            <Link
              href={`/s/${serverId}/playlists/moderation`}
              className="flex h-10 items-center gap-2 rounded-xl bg-white/[0.06] px-4 text-sm ring-1 ring-white/[0.08] transition hover:bg-white/[0.09]"
            >
              <ShieldCheck className="size-4" /> Moderate
            </Link>
          )}
          <NewPlaylistButton serverId={serverId} />
        </div>
      </div>

      <nav aria-label="Playlist filter" className="flex flex-wrap gap-2">
        {TABS.map((t) => (
          <Link
            key={t.scope}
            href={t.scope === "all" ? base : `${base}?scope=${t.scope}`}
            aria-current={t.scope === scope ? "page" : undefined}
            className={cn(
              "rounded-full px-3.5 py-1.5 text-sm ring-1 transition",
              t.scope === scope
                ? "bg-primary/15 text-primary ring-primary/40"
                : "bg-white/[0.05] text-muted-foreground ring-white/[0.08] hover:text-foreground"
            )}
          >
            {t.label}
          </Link>
        ))}
      </nav>

      {playlists.length === 0 ? (
        <div className="mx-auto flex max-w-sm flex-col items-center gap-3 py-24 text-center">
          <p className="text-lg font-medium">No playlists here yet</p>
          <p className="text-sm text-muted-foreground">
            Create one, or use “Add to playlist” on any movie, show or book.
          </p>
        </div>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {playlists.map((p) => (
            <li key={p.id}>
              <Link
                href={`${base}/${p.id}`}
                className="flex h-full flex-col gap-2 rounded-2xl bg-white/[0.04] p-4 ring-1 ring-white/[0.08] transition hover:bg-white/[0.07]"
              >
                <div className="flex items-start justify-between gap-2">
                  <p className="min-w-0 truncate text-base font-medium">{p.name}</p>
                  {p.visibility === "server" ? (
                    <Globe className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-label="Visible to everyone on this server" />
                  ) : (
                    <Lock className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-label="Private" />
                  )}
                </div>
                {p.description && <p className="line-clamp-2 text-sm text-muted-foreground">{p.description}</p>}
                <div className="mt-auto flex flex-wrap items-center gap-x-2 gap-y-1 pt-1 text-xs text-muted-foreground">
                  <span>
                    {p.itemCount} item{p.itemCount === 1 ? "" : "s"}
                  </span>
                  <span aria-hidden>·</span>
                  <span>{p.owner ? (p.myRole === "owner" ? "You" : p.owner.name) : "No owner"}</span>
                  {p.myRole !== "owner" && (
                    <Badge variant="secondary" className="ml-auto capitalize">
                      {p.visibility === "server" && p.myRole === "viewer" ? "Public" : p.myRole}
                    </Badge>
                  )}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}

      {nextCursor && (
        <Link
          href={`${base}?${scope === "all" ? "" : `scope=${scope}&`}after=${encodeCursor(nextCursor)}`}
          className="mx-auto flex h-10 items-center rounded-xl bg-white/[0.06] px-6 text-sm ring-1 ring-white/[0.08] transition hover:bg-white/[0.09]"
        >
          More playlists
        </Link>
      )}
    </div>
  );
}
