import { requireServerMember } from "@/lib/auth/guards";
import { Breadcrumbs } from "@/components/shell/breadcrumbs";
import { DownloadsList } from "@/components/offline/downloads-list-online";

/** What this device has saved for offline use, with room to manage it. (The list itself comes from the browser's own storage.) */
export default async function DownloadsPage({ params }: PageProps<"/s/[serverId]/downloads">) {
  const { serverId } = await params;
  await requireServerMember(serverId);
  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6 px-4 py-8 sm:px-8">
      <Breadcrumbs serverId={serverId} trail={[{ label: "Downloads" }]} />
      <header>
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Downloads</h1>
        <p className="mt-1 text-muted-foreground">Saved on this device for watching and listening without a connection.</p>
      </header>
      <DownloadsList serverId={serverId} />
    </div>
  );
}
