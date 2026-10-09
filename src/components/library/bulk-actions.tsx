"use client";

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { CloudDownload, ListPlus, Loader2, Plus } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { NameDialog } from "@/components/playlists/name-dialog";
import { playlistApi } from "@/components/playlists/playlist-api";
import { pickOption, qualityChoices, summarizeBulk, type QualityTarget } from "@/lib/offline/bulk-choice";
import { formatBytes } from "@/lib/offline/format";
import { startDownload } from "@/lib/offline/manager";
import type { DownloadOptions } from "@/lib/offline/options";
import { offlineStorageSupported, storageUsage } from "@/lib/offline/storage";

/** "Add selected to playlist": pick one of the playlists this profile can edit (or start a new one) and everything selected goes in, in order. */
export function BulkPlaylistMenu({ serverId, titleIds, disabled }: { serverId: string; titleIds: string[]; disabled?: boolean }) {
  const [playlists, setPlaylists] = useState<{ id: string; name: string }[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [naming, setNaming] = useState(false);

  async function load() {
    setError(null);
    const res = await playlistApi.editable(serverId);
    if (res.ok) setPlaylists(res.data.playlists);
    else setError(res.error);
  }

  async function addTo(id: string, name: string): Promise<string | null> {
    setBusy(true);
    const res = await playlistApi.addTitles(id, titleIds);
    setBusy(false);
    if (!res.ok) return res.error;
    const { added, alreadyThere, unavailable } = res.data;
    const extra = [alreadyThere ? `${alreadyThere} already there` : null, unavailable ? `${unavailable} couldn't be added` : null].filter(Boolean).join(", ");
    toast.success(`Added ${added} to "${name}"${extra ? ` (${extra})` : ""}.`);
    return null;
  }

  async function createAndAdd(name: string): Promise<string | null> {
    const created = await playlistApi.create(serverId, name);
    if (!created.ok) return created.error;
    return addTo(created.data.id, created.data.name);
  }

  return (
    <>
      <DropdownMenu onOpenChange={(open) => open && void load()}>
        <DropdownMenuTrigger render={<Button variant="secondary" disabled={disabled || busy} className="h-10 gap-2 rounded-xl" />}>
          {busy ? <Loader2 className="size-4 animate-spin" /> : <ListPlus className="size-4" />} Add to playlist
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="max-h-80 min-w-56 overflow-y-auto">
          {playlists === null && !error && <DropdownMenuItem disabled>Loading…</DropdownMenuItem>}
          {error && <DropdownMenuItem disabled>{error}</DropdownMenuItem>}
          {playlists?.length === 0 && <DropdownMenuItem disabled>No playlists yet</DropdownMenuItem>}
          {playlists?.map((p) => (
            <DropdownMenuItem key={p.id} onClick={() => void addTo(p.id, p.name).then((e) => e && toast.error(e))}>
              <span className="truncate">{p.name}</span>
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => setNaming(true)}>
            <Plus className="size-4" /> New playlist…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {naming && <NameDialog open onOpenChange={setNaming} title="New playlist" description={`${titleIds.length} selected will go in. It stays private to you until you share it.`} submitLabel="Create and add" onSubmit={createAndAdd} />}
    </>
  );
}

/** "Download selected": shows what the selection comes to (a show counts as its episodes), lets you choose a resolution for all, then saves them one after another. */
export function BulkDownloadButton({ serverId, titleIds, disabled }: { serverId: string; titleIds: string[]; disabled?: boolean }) {
  const supported = useSyncExternalStore(() => () => undefined, offlineStorageSupported, () => false);
  const [open, setOpen] = useState(false);
  if (!supported) return null;
  return (
    <>
      <Button type="button" variant="secondary" disabled={disabled} onClick={() => setOpen(true)} className="h-10 gap-2 rounded-xl">
        <CloudDownload className="size-4" /> Download
      </Button>
      {open && <BulkDownloadDialog serverId={serverId} titleIds={titleIds} onClose={() => setOpen(false)} />}
    </>
  );
}

type Loaded = { items: DownloadOptions[]; skipped: number; truncated: boolean };

function BulkDownloadDialog({ serverId, titleIds, onClose }: { serverId: string; titleIds: string[]; onClose: () => void }) {
  const [data, setData] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [choice, setChoice] = useState<string>("best");
  const [space, setSpace] = useState<{ usage: number; quota: number } | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/download/bulk", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ titleIds }) })
      .then(async (res) => {
        if (res.ok) return (await res.json()) as Loaded;
        const body = await res.json().catch(() => ({}));
        throw new Error(typeof body.error === "string" ? body.error : "Couldn't load the download choices.");
      })
      .then((d) => !cancelled && setData(d))
      .catch((e: Error) => !cancelled && setError(e.message || "Couldn't reach the server."));
    storageUsage().then((s) => !cancelled && setSpace(s));
    return () => {
      cancelled = true;
    };
  }, [titleIds]);

  const target: QualityTarget = choice === "best" ? { kind: "best" } : choice === "smallest" ? { kind: "smallest" } : { kind: "height", height: Number(choice) };
  const choices = useMemo(() => (data ? qualityChoices(data.items) : []), [data]);
  const summary = data ? summarizeBulk(data.items, target) : null;
  const tooBig = !!(space && summary && summary.totalBytes > space.quota - space.usage);
  const episodes = data ? data.items.filter((i) => i.ownerKind === "episode").length : 0;

  async function begin() {
    if (!data) return;
    let started = 0;
    let failed = 0;
    setProgress({ done: 0, total: data.items.length });
    for (const [i, item] of data.items.entries()) {
      const option = pickOption(item.options, target);
      if (option) {
        try {
          await startDownload(serverId, item, option);
          started++;
        } catch (e) {
          failed++;
          if ((e as Error).message?.includes("enough room")) {
            toast.error((e as Error).message);
            break;
          }
        }
      }
      setProgress({ done: i + 1, total: data.items.length });
    }
    setProgress(null);
    onClose();
    if (started > 0) toast.success(`Downloading ${started} ${started === 1 ? "item" : "items"}${failed ? ` (${failed} couldn't start)` : ""}. Follow them under Downloads.`);
    else if (failed > 0) toast.error("Couldn't start those downloads.");
  }

  return (
    <Dialog open onOpenChange={(o) => !o && !progress && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Download {titleIds.length} selected</DialogTitle>
          <DialogDescription>Saved on this device, to watch and listen without a connection.</DialogDescription>
        </DialogHeader>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        {!data && !error && (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Checking what&apos;s available…
          </p>
        )}
        {data && summary && (
          <div className="flex flex-col gap-4">
            <p className="text-sm">
              {summary.count === 0
                ? "Nothing here can be downloaded."
                : `${summary.count} ${summary.count === 1 ? "item" : "items"}${episodes > 0 ? ` (including ${episodes} episode${episodes === 1 ? "" : "s"})` : ""} · ${formatBytes(summary.totalBytes)}${summary.unknownSizes ? ` and ${summary.unknownSizes} of unknown size` : ""}`}
            </p>
            {choices.length > 0 && (
              <label className="flex flex-col gap-1.5 text-sm">
                <span className="text-muted-foreground">Resolution (the closest available is used for each)</span>
                <select value={choice} onChange={(e) => setChoice(e.target.value)} disabled={!!progress} className="h-10 rounded-lg border border-input bg-transparent px-3 text-sm">
                  <option value="best">Best available</option>
                  {choices.map((c) => (
                    <option key={c.height} value={c.height}>
                      {c.name}
                    </option>
                  ))}
                  <option value="smallest">Smallest</option>
                </select>
              </label>
            )}
            {data.skipped > 0 && <p className="text-xs text-muted-foreground">{data.skipped} selected {data.skipped === 1 ? "item" : "items"} can&apos;t be downloaded and will be left out.</p>}
            {data.truncated && <p className="text-xs text-muted-foreground">That is a lot: only the first part of the selection is included. Download the rest in another go.</p>}
            {space && <p className={tooBig ? "text-xs text-destructive" : "text-xs text-muted-foreground"}>{tooBig ? "That is more than the room left on this device." : `About ${formatBytes(Math.max(0, space.quota - space.usage))} free to use on this device.`}</p>}
            {summary.count > 0 && (
              <Button type="button" disabled={!!progress || tooBig} onClick={begin} className="gap-2 rounded-xl">
                {progress ? <Loader2 className="size-4 animate-spin" /> : <CloudDownload className="size-4" />}
                {progress ? `Starting ${progress.done} of ${progress.total}…` : "Download"}
              </Button>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
