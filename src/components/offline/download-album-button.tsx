"use client";

import { useState, useSyncExternalStore } from "react";
import { CloudDownload, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { formatBytes } from "@/lib/offline/format";
import { startDownload } from "@/lib/offline/manager";
import type { DownloadOptions } from "@/lib/offline/options";
import { offlineStorageSupported } from "@/lib/offline/storage";
import { downloadId } from "@/lib/offline/types";
import { useDownloads } from "@/lib/offline/use-downloads";

const AT_ONCE = 6;

/** Download every song of an album: shows how many there are and how big, then saves them one after another. */
export function DownloadAlbumButton({ serverId, songIds, albumName }: { serverId: string; songIds: string[]; albumName: string }) {
  const supported = useSyncExternalStore(() => () => undefined, offlineStorageSupported, () => false);
  const have = useDownloads();
  const [open, setOpen] = useState(false);
  const [all, setAll] = useState<DownloadOptions[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!supported || songIds.length === 0) return null;

  const onDevice = new Set(have.filter((r) => r.kind === "listen" && r.status === "complete").map((r) => r.ownerId));
  const missing = songIds.filter((id) => !onDevice.has(id));

  async function openDialog() {
    setOpen(true);
    setAll(null);
    setError(null);
    const results: DownloadOptions[] = [];
    try {
      for (let i = 0; i < missing.length; i += AT_ONCE) {
        const batch = await Promise.all(
          missing.slice(i, i + AT_ONCE).map(async (id) => {
            const res = await fetch(`/api/download/title/${id}/options`, { cache: "no-store" });
            if (!res.ok) throw new Error("Couldn't load the download choices.");
            return (await res.json()) as DownloadOptions;
          })
        );
        results.push(...batch);
      }
      setAll(results);
    } catch (e) {
      setError((e as Error).message || "Couldn't reach the server.");
    }
  }

  async function begin() {
    if (!all) return;
    setBusy(true);
    let failed = 0;
    for (const options of all) {
      const choice = options.options[0];
      if (!choice) continue;
      try {
        await startDownload(serverId, options, choice);
      } catch (e) {
        failed++;
        if (failed === 1) toast.error((e as Error).message || "Couldn't start a download.");
        if ((e as Error).message?.includes("enough room")) break;
      }
    }
    setBusy(false);
    setOpen(false);
    if (failed < all.length) toast.success("Downloading. You can follow it under Downloads.");
  }

  const total = all?.every((o) => o.options[0]?.sizeBytes != null) ? all.reduce((n, o) => n + (o.options[0].sizeBytes ?? 0), 0) : null;
  const running = have.filter((r) => r.kind === "listen" && songIds.includes(r.ownerId) && r.status !== "complete" && downloadId("listen", "title", r.ownerId, "") === r.id).length;
  return (
    <>
      <Button type="button" variant="secondary" onClick={openDialog} className="h-12 gap-2 rounded-xl px-5 text-sm font-medium">
        {running > 0 ? <Loader2 className="size-4 animate-spin" /> : <CloudDownload className="size-4" />}
        {missing.length === 0 ? "Album downloaded" : running > 0 ? `Downloading ${running} ${running === 1 ? "song" : "songs"}` : "Download album"}
      </Button>
      {open && (
        <Dialog open onOpenChange={(o) => !o && setOpen(false)}>
          <DialogContent className="sm:max-w-sm">
            <DialogHeader>
              <DialogTitle>{albumName}</DialogTitle>
              <DialogDescription>Saved on this device, to listen without a connection.</DialogDescription>
            </DialogHeader>
            {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
            {!all && !error && (
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" /> Checking the songs…
              </p>
            )}
            {all && (
              <>
                <p className="text-sm">
                  {all.length === 0 ? "Every song is already on this device." : `${all.length} ${all.length === 1 ? "song" : "songs"} · ${formatBytes(total)}`}
                </p>
                {all.length > 0 && (
                  <Button type="button" disabled={busy} onClick={begin} className="gap-2 rounded-xl">
                    {busy ? <Loader2 className="size-4 animate-spin" /> : <CloudDownload className="size-4" />} Download
                  </Button>
                )}
              </>
            )}
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}
