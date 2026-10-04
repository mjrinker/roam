import Link from "next/link";
import { notFound } from "next/navigation";
import { ShieldCheck } from "lucide-react";
import { z } from "zod";
import { db } from "@/lib/db/client";
import { requireServerMember } from "@/lib/auth/guards";
import { decodeCursor, encodeCursor } from "@/lib/playlists/http";
import { listPublicForAdmin } from "@/lib/playlists/member-service";
import { Breadcrumbs } from "@/components/shell/breadcrumbs";
import { ModerationList } from "@/components/playlists/moderation-list";

const cursorSchema = z.object({ name: z.string(), id: z.string().uuid() });

/** Server admins only: delete public playlists. Private playlists are never listed here. */
export default async function PlaylistModerationPage({
  params,
  searchParams,
}: PageProps<"/s/[serverId]/playlists/moderation">) {
  const { serverId } = await params;
  const query = await searchParams;
  const { viewer } = await requireServerMember(serverId);

  const after = decodeCursor(typeof query.after === "string" ? query.after : null, cursorSchema);
  const result = await listPublicForAdmin(db, {
    serverId,
    viewerId: viewer.id,
    limit: 50,
    after: after === "invalid" ? null : after,
  });
  // Non-admins, limited profiles and non-members all get the same 404.
  if (!result.ok) notFound();
  const { playlists, nextCursor } = result.value;

  return (
    <div className="flex flex-col gap-6 px-4 py-8 sm:px-8">
      <Breadcrumbs
        serverId={serverId}
        trail={[{ label: "Playlists", href: `/s/${serverId}/playlists` }, { label: "Moderation" }]}
        className="-mb-2"
      />
      <div className="flex items-center gap-3">
        <span className="flex size-10 items-center justify-center rounded-xl bg-white/[0.06] ring-1 ring-white/10">
          <ShieldCheck className="size-5 text-primary" />
        </span>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Public playlists</h1>
          <p className="text-sm text-muted-foreground">Playlists everyone on this server can see. Private playlists aren&apos;t shown here.</p>
        </div>
      </div>

      {playlists.length === 0 ? (
        <p className="py-16 text-center text-sm text-muted-foreground">No public playlists.</p>
      ) : (
        <ModerationList
          serverId={serverId}
          playlists={playlists.map((p) => ({
            id: p.id,
            name: p.name,
            owner: p.owner ? { name: p.owner.name, avatarKey: p.owner.avatarKey } : null,
          }))}
        />
      )}

      {nextCursor && (
        <Link
          href={`/s/${serverId}/playlists/moderation?after=${encodeCursor(nextCursor)}`}
          className="mx-auto flex h-10 items-center rounded-xl bg-white/[0.06] px-6 text-sm ring-1 ring-white/[0.08] transition hover:bg-white/[0.09]"
        >
          More playlists
        </Link>
      )}
    </div>
  );
}
