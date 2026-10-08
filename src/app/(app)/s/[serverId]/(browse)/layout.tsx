import { accountLabel } from "@/lib/auth/guests";
import { asc, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { libraries, servers } from "@/lib/db/schema";
import { requireServerMember } from "@/lib/auth/guards";
import { libraryActor, libraryVisible } from "@/lib/content/library-access";
import { listServerMemberships } from "@/lib/auth/servers";
import { MiniPlayer } from "@/components/audio/mini-player";
import { PlayerErrorBoundary } from "@/components/audio/player-error-boundary";
import { AppSidebar } from "@/components/shell/app-sidebar";
import { PullToRefresh } from "@/components/shell/pull-to-refresh";
import { ShellProvider } from "@/components/shell/shell-context";
import { TopBar } from "@/components/shell/top-bar";
import { DemoBanner } from "@/components/shell/demo-banner";
import { TmdbAttribution } from "@/components/shell/tmdb-attribution";

/** The browsing chrome: persistent sidebar (a drawer on mobile) + top bar with search and account menu. */
export default async function BrowseLayout({
  children,
  params,
}: LayoutProps<"/s/[serverId]">) {
  const { serverId } = await params;
  const { profile, viewer, role } = await requireServerMember(serverId);

  const [memberships, serverLibraries, [serverRow]] = await Promise.all([
    listServerMemberships(profile.id),
    db
      .select({ id: libraries.id, name: libraries.name, kind: libraries.kind })
      .from(libraries)
      .where(libraryVisible(db, libraryActor({ profile, role }, serverId)))
      .orderBy(asc(libraries.name)),
    db.select({ isDemo: servers.isDemo }).from(servers).where(eq(servers.id, serverId)).limit(1),
  ]);
  const current = memberships.find((m) => m.serverId === serverId);

  return (
    <ShellProvider>
      <PullToRefresh />
      <div className="flex min-h-dvh">
        <AppSidebar
          serverId={serverId}
          serverName={current?.serverName ?? "Server"}
          libraries={serverLibraries}
          memberships={memberships}
          isAdmin={role === "admin"}
        />
        <div className="flex min-w-0 flex-1 flex-col">
          {serverRow?.isDemo && <DemoBanner serverId={serverId} />}
          <TopBar
            serverId={serverId}
            email={accountLabel(profile)}
            profileName={viewer.name}
            avatarKey={viewer.avatarKey}
          />
          <main className="flex-1">{children}</main>
          <footer className="px-4 py-8">
            <TmdbAttribution />
          </footer>
          <PlayerErrorBoundary>
            <MiniPlayer serverId={serverId} />
          </PlayerErrorBoundary>
        </div>
      </div>
    </ShellProvider>
  );
}
