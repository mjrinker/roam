import Link from "next/link";
import { after } from "next/server";
import { requireServerMember } from "@/lib/auth/guards";
import { listServerMemberships } from "@/lib/auth/servers";
import { findResumableLibraries, scanLibrary } from "@/lib/scan/scanner";
import { SignOutButton } from "@/components/nav/sign-out-button";
import { ServerSwitcher } from "@/components/nav/server-switcher";
import { LibrarySidebarProvider } from "@/components/nav/library-sidebar-context";
import { LibraryMenuButton } from "@/components/nav/library-menu-button";

// Gives the after() background resume-scan below (see findResumableLibraries)
// the full budget to run after the page response has already been sent,
// rather than being cut off by a shorter platform default.
export const maxDuration = 60;

export default async function ServerLayout({
  children,
  params,
}: LayoutProps<"/s/[serverId]">) {
  const { serverId } = await params;
  const { profile, role } = await requireServerMember(serverId);
  const memberships = await listServerMemberships(profile.id);
  const current = memberships.find((m) => m.serverId === serverId);

  // Auto-resume any library whose last scan stopped early due to its time
  // budget — runs after the response is sent, so it never delays the page.
  const resumable = await findResumableLibraries(serverId);
  for (const libraryId of resumable) {
    after(() =>
      scanLibrary(libraryId, "resume").catch((err) => {
        console.error(`Resume scan failed for library ${libraryId}:`, err);
      })
    );
  }

  return (
    <LibrarySidebarProvider>
      <div className="flex min-h-full flex-col">
        {/* h-14 is explicit (not content-driven) so the mobile library
            drawer can offset itself to start exactly below this header —
            see top-14 in LibrarySidebar. */}
        <header className="sticky top-0 z-20 flex h-14 items-center justify-between border-b border-border bg-background/95 px-6 backdrop-blur">
          <nav className="flex items-center gap-6">
            <LibraryMenuButton serverId={serverId} />
            <Link href={`/s/${serverId}/library`} className="text-lg font-semibold tracking-tight">
              Roam
            </Link>
            <ServerSwitcher
              memberships={memberships}
              currentServerId={serverId}
              currentServerName={current?.serverName ?? "Server"}
            />
            <Link
              href={`/s/${serverId}/library`}
              className="text-sm text-muted-foreground transition-colors hover:text-foreground"
            >
              Library
            </Link>
            {role === "admin" && (
              <Link
                href={`/s/${serverId}/admin`}
                className="text-sm text-muted-foreground transition-colors hover:text-foreground"
              >
                Admin
              </Link>
            )}
          </nav>
          <div className="flex items-center gap-3">
            <span className="text-sm text-muted-foreground">
              {profile.displayName ?? profile.email}
            </span>
            <SignOutButton />
          </div>
        </header>
        <main className="flex-1">{children}</main>
      </div>
    </LibrarySidebarProvider>
  );
}
