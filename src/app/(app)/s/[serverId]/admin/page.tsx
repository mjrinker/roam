import Link from "next/link";
import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { invites, libraries, scanRuns, servers, titles } from "@/lib/db/schema";
import { requireServerAdmin } from "@/lib/auth/guards";
import { LibraryManager } from "@/components/admin/library-manager";
import { InviteManager } from "@/components/admin/invite-manager";
import { UnmatchedTitles } from "@/components/admin/unmatched-titles";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";

const BOX_ERROR_MESSAGES: Record<string, string> = {
  "box-connect-cancelled": "Box connection was cancelled.",
  "box-connect-failed": "Couldn't connect to Box. Try again.",
};

export default async function AdminPage({
  params,
  searchParams,
}: PageProps<"/s/[serverId]/admin">) {
  const { serverId } = await params;
  await requireServerAdmin(serverId);
  const query = await searchParams;
  const errorParam = typeof query.error === "string" ? query.error : null;

  const [server] = await db.select().from(servers).where(eq(servers.id, serverId)).limit(1);
  const boxConnected = server?.boxAuthStatus === "connected";

  const allLibraries = await db
    .select()
    .from(libraries)
    .where(eq(libraries.serverId, serverId))
    .orderBy(desc(libraries.createdAt));
  const libraryIds = allLibraries.map((l) => l.id);

  const allInvites = await db
    .select()
    .from(invites)
    .where(eq(invites.serverId, serverId))
    .orderBy(desc(invites.createdAt));

  const unmatchedTitles = libraryIds.length
    ? await db
        .select()
        .from(titles)
        .where(
          and(
            inArray(titles.libraryId, libraryIds),
            inArray(titles.metadataStatus, ["pending", "not_found"])
          )
        )
        .orderBy(desc(titles.addedAt))
    : [];

  // Most-recent scan_runs rows across this server's libraries, enough to
  // find the latest one per library.
  const recentScans = libraryIds.length
    ? await db
        .select()
        .from(scanRuns)
        .where(inArray(scanRuns.libraryId, libraryIds))
        .orderBy(desc(scanRuns.startedAt))
        .limit(50)
    : [];
  const lastScanByLibrary = new Map<string, (typeof recentScans)[number]>();
  for (const run of recentScans) {
    if (!lastScanByLibrary.has(run.libraryId)) lastScanByLibrary.set(run.libraryId, run);
  }

  return (
    <div className="flex flex-col gap-10 px-6 py-8">
      {errorParam && (
        <p className="text-sm text-destructive">
          {BOX_ERROR_MESSAGES[errorParam] ?? "Something went wrong."}
        </p>
      )}

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">Box connection</h2>
        <Card>
          <CardContent className="flex items-center justify-between py-4">
            <div className="flex items-center gap-2">
              {server?.boxAuthStatus === "connected" && (
                <Badge variant="secondary">Connected</Badge>
              )}
              {server?.boxAuthStatus === "needs_reauth" && (
                <Badge variant="destructive">Needs reconnecting</Badge>
              )}
              {server?.boxAuthStatus === "disconnected" && (
                <Badge variant="outline">Not connected</Badge>
              )}
            </div>
            <Button render={<Link href={`/api/box/connect?serverId=${serverId}`} />} size="sm">
              {boxConnected ? "Reconnect Box" : "Connect Box"}
            </Button>
          </CardContent>
        </Card>
      </section>

      <LibraryManager
        serverId={serverId}
        boxConnected={boxConnected}
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
        serverId={serverId}
        invites={allInvites.map((i) => ({
          ...i,
          acceptedAt: i.acceptedAt?.toISOString() ?? null,
          expiresAt: i.expiresAt.toISOString(),
        }))}
      />
    </div>
  );
}
