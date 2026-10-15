import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { libraries, librarySources, scanRuns, servers, titles, viewers } from "@/lib/db/schema";
import { requireServerAdmin } from "@/lib/auth/guards";
import { LibraryManager } from "@/components/admin/library-manager";
import { DeleteServerButton } from "@/components/admin/delete-server-button";
import { StorageConnections } from "@/components/admin/storage-connections";
import { availableProviders } from "@/lib/storage/available";
import { listInvitesForAdmin } from "@/lib/auth/invites";
import { listConnectionSummaries } from "@/lib/storage/connections";
import { parseStorageId } from "@/lib/storage/ids";
import { InviteManager } from "@/components/admin/invite-manager";
import { JoinLinkManager } from "@/components/admin/join-link-manager";
import { UnmatchedTitles } from "@/components/admin/unmatched-titles";
import { OwnershipManager } from "@/components/admin/ownership-manager";
import { loadSettings, openClaims } from "@/lib/ownership/owners";
import { Breadcrumbs } from "@/components/shell/breadcrumbs";
import { libraryKindUsesExternalMetadata } from "@/lib/libraries/profile";

const BOX_ERROR_MESSAGES: Record<string, string> = {
  "box-connect-cancelled": "Box connection was cancelled.",
  "box-connect-failed": "Couldn't connect to Box. Try again.",
  "storage-connect-cancelled": "The connection was cancelled.",
  "storage-connect-failed": "Couldn't connect that storage. Try again.",
};

export default async function AdminPage({
  params,
  searchParams,
}: PageProps<"/s/[serverId]/admin">) {
  const { serverId } = await params;
  const { profile: adminAccount } = await requireServerAdmin(serverId);
  const query = await searchParams;
  const errorParam = typeof query.error === "string" ? query.error : null;

  const [server] = await db.select().from(servers).where(eq(servers.id, serverId)).limit(1);
  const connections = await listConnectionSummaries(serverId);
  const connectionLabel = (storedId: string) => connections.find((c) => c.id === parseStorageId(serverId, storedId).connectionId)?.label ?? "Unknown storage";

  // The names visitors will be able to see for the admin's own profiles (a profile is named from its email address by default).
  const visibleProfileNames = (await db.select({ name: viewers.name }).from(viewers).where(and(eq(viewers.accountId, adminAccount.id), eq(viewers.visibleOnServer, true)))).map((v) => v.name);

  const allLibraries = await db
    .select()
    .from(libraries)
    .where(eq(libraries.serverId, serverId))
    .orderBy(desc(libraries.createdAt));
  const libraryIds = allLibraries.map((l) => l.id);
  const sourceRows = libraryIds.length ? await db.select().from(librarySources).where(inArray(librarySources.libraryId, libraryIds)).orderBy(asc(librarySources.position), asc(librarySources.createdAt)) : [];

  const allInvites = await listInvitesForAdmin(serverId);

  // Video libraries take everything from the files themselves, so nothing there is ever "unmatched".
  const matchableLibraryIds = allLibraries.filter((l) => libraryKindUsesExternalMetadata(l.kind)).map((l) => l.id);
  const unmatchedTitles = matchableLibraryIds.length
    ? await db
        .select()
        .from(titles)
        .where(
          and(
            inArray(titles.libraryId, matchableLibraryIds),
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

  const ownership = await loadSettings(db, serverId);
  const claims = ownership.enabled ? await openClaims(db, serverId) : [];

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-10 px-4 py-8 sm:px-8">
      <Breadcrumbs serverId={serverId} trail={[{ label: "Server settings" }]} className="-mb-6" />
      <div>
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Server settings</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Manage <span className="font-medium text-foreground">{server?.name}</span> — its storage,
          libraries, and who can watch.
        </p>
      </div>

      {errorParam && (
        <p className="rounded-xl bg-destructive/10 px-4 py-3 text-sm text-destructive ring-1 ring-destructive/20">
          {BOX_ERROR_MESSAGES[errorParam] ?? "Something went wrong."}
        </p>
      )}

      <StorageConnections serverId={serverId} connections={connections} available={availableProviders()} />

      <LibraryManager
        serverId={serverId}
        connections={connections.filter((c) => c.authStatus === "connected")}
        libraries={allLibraries.map((l) => {
          const lastScan = lastScanByLibrary.get(l.id);
          return {
            ...l,
            firstFolderConnection: connectionLabel(l.boxFolderId),
            sources: sourceRows.filter((r) => r.libraryId === l.id).map((r) => ({ id: r.id, label: r.label, connection: connectionLabel(r.rootId) })),
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
          author: t.folderAuthor,
          metadataStatus: t.metadataStatus as "pending" | "not_found",
        }))}
      />
      <OwnershipManager
        serverId={serverId}
        initial={ownership}
        claims={claims.map((c) => ({ ...c, createdAt: c.createdAt.toISOString() }))}
      />
      {adminAccount.canManageOpenLinks && <JoinLinkManager serverId={serverId} initialToken={server?.joinToken ?? null} initialDemo={server?.isDemo ?? false} visibleProfileNames={visibleProfileNames} />}

      <InviteManager
        serverId={serverId}
        invites={allInvites.map((i) => ({
          ...i,
          acceptedAt: i.acceptedAt?.toISOString() ?? null,
          expiresAt: i.expiresAt.toISOString(),
        }))}
      />

      {server && <DeleteServerButton serverId={serverId} serverName={server.name} />}
    </div>
  );
}
