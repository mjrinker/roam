import { requireViewer } from "@/lib/auth/guards";
import { ViewerMarker } from "@/components/offline/viewer-marker";

/**
 * Thin shell for everything under (app) — just requires a signed-in
 * profile with a selected "Who's watching?" choice. Server-specific chrome (nav, server switcher, Admin link) lives
 * in the nested s/[serverId]/layout.tsx, since it depends on which server
 * is current and the profile's role on THAT server, not a global role.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const { viewer } = await requireViewer();
  return (
    <>
      <ViewerMarker viewerId={viewer.id} />
      {children}
    </>
  );
}
