import { desc } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { invites, libraries } from "@/lib/db/schema";
import { requireAdmin } from "@/lib/auth/guards";
import { LibraryManager } from "@/components/admin/library-manager";
import { InviteManager } from "@/components/admin/invite-manager";

export default async function AdminPage() {
  await requireAdmin();

  const allLibraries = await db.select().from(libraries).orderBy(desc(libraries.createdAt));
  const allInvites = await db.select().from(invites).orderBy(desc(invites.createdAt));

  return (
    <div className="flex flex-col gap-10 px-6 py-8">
      <LibraryManager
        libraries={allLibraries.map((l) => ({
          ...l,
          lastScannedAt: l.lastScannedAt?.toISOString() ?? null,
        }))}
      />
      <InviteManager
        invites={allInvites.map((i) => ({
          ...i,
          acceptedAt: i.acceptedAt?.toISOString() ?? null,
          expiresAt: i.expiresAt.toISOString(),
        }))}
      />
    </div>
  );
}
