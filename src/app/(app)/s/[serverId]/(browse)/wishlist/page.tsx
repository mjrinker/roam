import { db } from "@/lib/db/client";
import { requireServerMember } from "@/lib/auth/guards";
import { libraryActor } from "@/lib/content/library-access";
import { listWishes } from "@/lib/wishlist/service";
import { WishlistView } from "@/components/wishlist/wishlist-view";

/** The server's shared wishlist: what members would like the household that buys media to get next. */
export default async function WishlistPage({ params }: PageProps<"/s/[serverId]/wishlist">) {
  const { serverId } = await params;
  const { profile, viewer, role } = await requireServerMember(serverId);
  const items = await listWishes(db, { serverId, actor: libraryActor({ profile, role }, serverId), viewer, accountId: profile.id, isAdmin: role === "admin" && viewer.role !== "limited" });
  return (
    <div className="mx-auto max-w-4xl px-4 py-8 sm:px-8">
      <WishlistView serverId={serverId} initial={items} canEdit={viewer.role !== "limited"} />
    </div>
  );
}
