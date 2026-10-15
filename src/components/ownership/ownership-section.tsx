import { db } from "@/lib/db/client";
import { ownershipView } from "@/lib/ownership/view";
import { OwnershipPanel } from "@/components/ownership/ownership-panel";

/** The ownership panel for a title page: nothing at all when the server doesn't track who owns what. */
export async function OwnershipSection({ serverId, titleId, libraryKind, accountId, viewerId, isAdmin, limited }: { serverId: string; titleId: string; libraryKind: string; accountId: string; viewerId: string; isAdmin: boolean; limited: boolean }) {
  const view = await ownershipView(db, { serverId, titleId, libraryKind, accountId, viewerId, isAdmin: isAdmin && !limited });
  if (!view) return null;
  return <OwnershipPanel titleId={titleId} view={view} canClaim={!limited} isAdmin={isAdmin && !limited} />;
}
