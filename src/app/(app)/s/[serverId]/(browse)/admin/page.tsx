import Link from "next/link";
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
import { cn } from "@/lib/utils";
import { healthIssueCount, serverHealth, type ServerHealth } from "@/lib/admin/health";

const TABS = [
  { id: "libraries", label: "Libraries", hint: "Storage and what is shared" },
  { id: "people", label: "People", hint: "Invites and join links" },
  { id: "ownership", label: "Ownership", hint: "Who owns which copies" },
  { id: "health", label: "Health", hint: "What needs attention" },
  { id: "more", label: "More", hint: "Statistics and deleting" },
] as const;
type Tab = (typeof TABS)[number]["id"];

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

  const tab: Tab = TABS.find((t) => t.id === query.tab)?.id ?? "libraries";
  const [server] = await db.select().from(servers).where(eq(servers.id, serverId)).limit(1);
  const health = await serverHealth(db, serverId);
  const attention = healthIssueCount(health);

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-4 py-8 sm:px-8">
      <Breadcrumbs serverId={serverId} trail={[{ label: "Server settings" }]} className="-mb-3" />
      <div>
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Server settings</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          <span className="font-medium text-foreground">{server?.name}</span>
        </p>
      </div>

      <nav aria-label="Server settings sections" className="flex gap-1 overflow-x-auto border-b border-white/10">
        {TABS.map((t) => (
          <Link
            key={t.id}
            href={t.id === "libraries" ? `/s/${serverId}/admin` : `/s/${serverId}/admin?tab=${t.id}`}
            aria-current={t.id === tab ? "page" : undefined}
            title={t.hint}
            className={cn("-mb-px shrink-0 border-b-2 px-3 py-2 text-sm font-medium transition-colors", t.id === tab ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground")}
          >
            {t.label}
            {t.id === "health" && attention > 0 && <span className="ml-1.5 rounded-full bg-amber-500/20 px-1.5 py-0.5 text-xs text-amber-200">{attention}</span>}
          </Link>
        ))}
      </nav>

      {errorParam && (
        <p className="rounded-xl bg-destructive/10 px-4 py-3 text-sm text-destructive ring-1 ring-destructive/20">
          {BOX_ERROR_MESSAGES[errorParam] ?? "Something went wrong."}
        </p>
      )}

      {tab === "libraries" && <LibrariesTab serverId={serverId} />}
      {tab === "people" && <PeopleTab serverId={serverId} canManageOpenLinks={adminAccount.canManageOpenLinks} adminAccountId={adminAccount.id} joinToken={server?.joinToken ?? null} isDemo={server?.isDemo ?? false} />}
      {tab === "ownership" && <OwnershipTab serverId={serverId} />}
      {tab === "health" && <HealthTab serverId={serverId} health={health} />}
      {tab === "more" && (
        <div className="flex flex-col gap-6">
          <Link href={`/s/${serverId}/admin/stats`} className="flex items-center justify-between gap-3 rounded-2xl bg-white/[0.04] px-4 py-3 text-sm ring-1 ring-white/[0.08] transition hover:bg-white/[0.07]">
            <span className="font-medium">Watch statistics</span>
            <span className="text-right text-muted-foreground">Time watched and the most watched</span>
          </Link>
          {server && <DeleteServerButton serverId={serverId} serverName={server.name} />}
        </div>
      )}
    </div>
  );
}

/** Storage connections, the libraries on them, and titles that still need matching. */
async function LibrariesTab({ serverId }: { serverId: string }) {
  const connections = await listConnectionSummaries(serverId);
  const connectionLabel = (storedId: string) => connections.find((c) => c.id === parseStorageId(serverId, storedId).connectionId)?.label ?? "Unknown storage";

  const allLibraries = await db
    .select()
    .from(libraries)
    .where(eq(libraries.serverId, serverId))
    .orderBy(desc(libraries.createdAt));
  const libraryIds = allLibraries.map((l) => l.id);
  const sourceRows = libraryIds.length ? await db.select().from(librarySources).where(inArray(librarySources.libraryId, libraryIds)).orderBy(asc(librarySources.position), asc(librarySources.createdAt)) : [];

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

  return (
    <div className="flex flex-col gap-8">
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
    </div>
  );
}

/** Who can join: invites, and (for those allowed) the open join link. */
async function PeopleTab({ serverId, canManageOpenLinks, adminAccountId, joinToken, isDemo }: { serverId: string; canManageOpenLinks: boolean; adminAccountId: string; joinToken: string | null; isDemo: boolean }) {
  // The names visitors will be able to see for the admin's own profiles (a profile is named from its email address by default).
  const visibleProfileNames = canManageOpenLinks ? (await db.select({ name: viewers.name }).from(viewers).where(and(eq(viewers.accountId, adminAccountId), eq(viewers.visibleOnServer, true)))).map((v) => v.name) : [];
  const allInvites = await listInvitesForAdmin(serverId);
  return (
    <div className="flex flex-col gap-8">
      <InviteManager
        serverId={serverId}
        invites={allInvites.map((i) => ({
          ...i,
          acceptedAt: i.acceptedAt?.toISOString() ?? null,
          expiresAt: i.expiresAt.toISOString(),
        }))}
      />
      {canManageOpenLinks && <JoinLinkManager serverId={serverId} initialToken={joinToken} initialDemo={isDemo} visibleProfileNames={visibleProfileNames} />}
    </div>
  );
}

async function OwnershipTab({ serverId }: { serverId: string }) {
  const ownership = await loadSettings(db, serverId);
  const claims = ownership.enabled ? await openClaims(db, serverId) : [];
  return <OwnershipManager serverId={serverId} initial={ownership} claims={claims.map((c) => ({ ...c, createdAt: c.createdAt.toISOString() }))} />;
}

function HealthSection({ title, ok, children }: { title: string; ok: boolean; children?: React.ReactNode }) {
  return (
    <section className="rounded-2xl bg-white/[0.04] p-4 ring-1 ring-white/[0.08]">
      <h2 className="flex items-center gap-2 text-sm font-semibold">
        <span aria-hidden className={cn("size-2.5 rounded-full", ok ? "bg-emerald-400" : "bg-amber-400")} />
        {title}
      </h2>
      {children && <div className="mt-2 text-sm text-muted-foreground">{children}</div>}
    </section>
  );
}

/** Everything that needs the admin's attention, each with where to fix it. */
function HealthTab({ serverId, health: h }: { serverId: string; health: ServerHealth }) {
  const base = `/s/${serverId}`;
  const titleHref = (t: { id: string; kind: string }) => `${base}/${t.kind === "show" ? "show" : "title"}/${t.id}`;
  const fixLink = (label: string) => (
    <Link href={`${base}/admin`} className="mt-1 inline-block text-foreground underline">
      {label}
    </Link>
  );
  return (
    <div className="flex flex-col gap-3">
      <HealthSection title={h.connections.length === 0 ? "Storage is signed in" : `${h.connections.length} storage connection${h.connections.length === 1 ? "" : "s"} need signing in`} ok={h.connections.length === 0}>
        {h.connections.length > 0 && (
          <>
            <ul className="list-disc pl-5">
              {h.connections.map((c) => (
                <li key={c.id}>{c.label}</li>
              ))}
            </ul>
            {fixLink("Open Libraries to reconnect")}
          </>
        )}
      </HealthSection>
      <HealthSection title={h.libraries.length === 0 ? "Libraries are scanned and clean" : `${h.libraries.length} librar${h.libraries.length === 1 ? "y needs" : "ies need"} a look`} ok={h.libraries.length === 0}>
        {h.libraries.length > 0 && (
          <>
            <ul className="list-disc pl-5">
              {h.libraries.map((l) => (
                <li key={l.id}>
                  {l.name}: {l.detail}
                </li>
              ))}
            </ul>
            {fixLink("Open Libraries to rescan")}
          </>
        )}
      </HealthSection>
      <HealthSection title={h.noFile.total === 0 ? "Every movie and show has something to play" : `${h.noFile.total} movie${h.noFile.total === 1 ? "" : "s"} or show${h.noFile.total === 1 ? "" : "s"} with nothing to play`} ok={h.noFile.total === 0}>
        {h.noFile.total > 0 && (
          <>
            <p>These are hidden from members until a file turns up (a rescan may find it).</p>
            <ul className="mt-1 list-disc pl-5">
              {h.noFile.sample.map((t) => (
                <li key={t.id}>
                  <Link href={titleHref(t)} className="text-foreground underline">
                    {t.name}
                    {t.year ? ` (${t.year})` : ""}
                  </Link>{" "}
                  · {t.libraryName}
                </li>
              ))}
            </ul>
            {h.noFile.total > h.noFile.sample.length && <p className="mt-1">…and {h.noFile.total - h.noFile.sample.length} more.</p>}
          </>
        )}
      </HealthSection>
      <HealthSection title={h.unreadable.total === 0 ? "Every file could be read" : `${h.unreadable.total} file${h.unreadable.total === 1 ? "" : "s"} couldn't be read`} ok={h.unreadable.total === 0}>
        {h.unreadable.total > 0 && (
          <>
            <p>Roam tried and failed to read these (a damaged or unsupported file). They can&apos;t be played.</p>
            <ul className="mt-1 list-disc pl-5 break-all">
              {h.unreadable.sample.map((f) => (
                <li key={f.id}>{f.filename}</li>
              ))}
            </ul>
          </>
        )}
      </HealthSection>
      <HealthSection title={h.unmatched === 0 ? "Every title is matched" : `${h.unmatched} title${h.unmatched === 1 ? "" : "s"} still to match`} ok={h.unmatched === 0}>
        {h.unmatched > 0 && fixLink("Open Libraries to match them")}
      </HealthSection>
      <HealthSection title={h.duplicates.length === 0 ? "No titles listed twice" : `${h.duplicates.length} title${h.duplicates.length === 1 ? "" : "s"} that look listed twice`} ok={h.duplicates.length === 0}>
        {h.duplicates.length > 0 && (
          <>
            <p>The same name and year more than once in a library. If they are the same film, keep one folder (or save the other as a resolution version).</p>
            <ul className="mt-1 list-disc pl-5">
              {h.duplicates.map((d) => (
                <li key={d.ids.join()}>
                  {d.name}
                  {d.year ? ` (${d.year})` : ""} ×{d.count} · {d.libraryName}
                </li>
              ))}
            </ul>
          </>
        )}
      </HealthSection>
    </div>
  );
}
