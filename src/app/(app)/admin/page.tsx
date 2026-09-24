import { desc, inArray } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { invites, libraries, scanRuns, titles } from "@/lib/db/schema";
import { requireAdmin } from "@/lib/auth/guards";
import { LibraryManager } from "@/components/admin/library-manager";
import { InviteManager } from "@/components/admin/invite-manager";
import { UnmatchedTitles } from "@/components/admin/unmatched-titles";

export default async function AdminPage() {
  await requireAdmin();

  const allLibraries = await db.select().from(libraries).orderBy(desc(libraries.createdAt));
  const allInvites = await db.select().from(invites).orderBy(desc(invites.createdAt));
  const unmatchedTitles = await db
    .select()
    .from(titles)
    .where(inArray(titles.metadataStatus, ["pending", "not_found"]))
    .orderBy(desc(titles.addedAt));

  // Most-recent scan_runs rows, enough to find the latest one per library.
  const recentScans = await db
    .select()
    .from(scanRuns)
    .orderBy(desc(scanRuns.startedAt))
    .limit(50);
  const lastScanByLibrary = new Map<string, (typeof recentScans)[number]>();
  for (const run of recentScans) {
    if (!lastScanByLibrary.has(run.libraryId)) lastScanByLibrary.set(run.libraryId, run);
  }

  return (
    <div className="flex flex-col gap-10 px-6 py-8">
      <LibraryManager
        libraries={allLibraries.map((l) => {
          const lastScan = lastScanByLibrary.get(l.id);
          return {
            ...l,
            lastScannedAt: l.lastScannedAt?.toISOString() ?? null,
            lastScan: lastScan
              ? {
                  trigger: lastScan.trigger,
                  finishedAt: lastScan.finishedAt?.toISOString() ?? null,
                  filesSeen: lastScan.filesSeen,
                  titlesAdded: lastScan.titlesAdded,
                  errors: lastScan.errors ?? [],
                }
              : null,
          };
        })}
      />
      <UnmatchedTitles
        titles={unmatchedTitles.map((t) => ({
          id: t.id,
          name: t.name,
          year: t.year,
          kind: t.kind,
          metadataStatus: t.metadataStatus as "pending" | "not_found",
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
