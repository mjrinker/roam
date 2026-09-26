import { after } from "next/server";
import { requireServerMember } from "@/lib/auth/guards";
import { findResumableLibraries, scanLibrary } from "@/lib/scan/scanner";

// Gives the after() background resume-scan below (see findResumableLibraries)
// the full budget to run after the page response has already been sent,
// rather than being cut off by a shorter platform default.
export const maxDuration = 60;

/**
 * Guards every page under a server (browsing AND the player) and kicks off
 * any interrupted scans. The visible chrome — sidebar, top bar — lives in
 * the (browse) group's layout instead, so the player can go edge-to-edge.
 */
export default async function ServerLayout({
  children,
  params,
}: LayoutProps<"/s/[serverId]">) {
  const { serverId } = await params;
  await requireServerMember(serverId);

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

  return <>{children}</>;
}
