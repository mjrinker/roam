"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { Check, CloudDownload, Loader2, Pause, Play, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { formatBytes, percentOf } from "@/lib/offline/format";
import { pauseDownload, removeDownload, resumeDownload, savedBytes, startDownload } from "@/lib/offline/manager";
import type { DownloadOption, DownloadOptions } from "@/lib/offline/options";
import { offlineStorageSupported, storageUsage } from "@/lib/offline/storage";
import { downloadId, type DownloadRecord } from "@/lib/offline/types";
import { useDownloads } from "@/lib/offline/use-downloads";

interface Props {
  serverId: string;
  ownerKind: "title" | "episode";
  ownerId: string;
  /** "hero": a labelled button like the other detail-page actions; "icon": a round icon button for list rows. */
  variant?: "hero" | "icon";
}

/** What this device holds for the item, summarised for the button's label. */
function summary(records: DownloadRecord[]): { label: string; busy: boolean } {
  const running = records.find((r) => r.status === "downloading");
  if (running) {
    const pct = percentOf(savedBytes(running), running.totalBytes);
    return { label: pct === null ? "Downloading…" : `Downloading ${pct}%`, busy: true };
  }
  const done = records.filter((r) => r.status === "complete");
  if (done.length > 0) return { label: done.length === 1 && done[0].versionName ? `Downloaded · ${done[0].versionName}` : "Downloaded", busy: false };
  if (records.length > 0) return { label: "Download paused", busy: false };
  return { label: "Download", busy: false };
}

/** Download for offline use: opens a list of the versions (resolution and size), each with its own download, progress and remove. */
export function DownloadButton({ serverId, ownerKind, ownerId, variant = "hero" }: Props) {
  const all = useDownloads();
  const [open, setOpen] = useState(false);
  const mine = all.filter((r) => r.ownerKind === ownerKind && r.ownerId === ownerId);
  const { label, busy } = summary(mine);
  // False while the page is built on the server, then whether this browser can keep downloads.
  const supported = useSyncExternalStore(() => () => undefined, offlineStorageSupported, () => false);
  if (!supported) return null; // this browser can't keep downloads

  return (
    <>
      {variant === "icon" ? (
        <Button type="button" variant="ghost" size="icon" aria-label={label} title={label} onClick={() => setOpen(true)} className="rounded-full">
          {busy ? <Loader2 className="size-[18px] animate-spin" /> : mine.some((r) => r.status === "complete") ? <Check className="size-[18px] text-primary" /> : <CloudDownload className="size-[18px]" />}
        </Button>
      ) : (
        <Button type="button" variant="secondary" onClick={() => setOpen(true)} className="h-12 gap-2 rounded-xl px-5 text-sm font-medium">
          {busy ? <Loader2 className="size-4 animate-spin" /> : mine.some((r) => r.status === "complete") ? <Check className="size-4 text-primary" /> : <CloudDownload className="size-4" />}
          {label}
        </Button>
      )}
      {open && <DownloadDialog serverId={serverId} ownerKind={ownerKind} ownerId={ownerId} records={mine} onClose={() => setOpen(false)} />}
    </>
  );
}

function DownloadDialog({ serverId, ownerKind, ownerId, records, onClose }: { serverId: string; ownerKind: "title" | "episode"; ownerId: string; records: DownloadRecord[]; onClose: () => void }) {
  const [options, setOptions] = useState<DownloadOptions | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState<string | null>(null);
  const [space, setSpace] = useState<{ usage: number; quota: number } | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/download/${ownerKind}/${ownerId}/options`, { cache: "no-store" })
      .then(async (res) => {
        if (res.ok) return (await res.json()) as DownloadOptions;
        throw new Error(res.status === 404 ? "Nothing to download here yet." : "Couldn't load the download choices.");
      })
      .then((o) => !cancelled && setOptions(o))
      .catch((e: Error) => !cancelled && setError(e.message || "Couldn't reach the server."));
    storageUsage().then((s) => !cancelled && setSpace(s));
    return () => {
      cancelled = true;
    };
  }, [ownerKind, ownerId]);

  async function begin(option: DownloadOption) {
    if (!options) return;
    setStarting(option.label);
    try {
      await startDownload(serverId, options, option);
    } catch (e) {
      toast.error((e as Error).message || "Couldn't start that download.");
    } finally {
      setStarting(null);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{options?.title ?? "Download"}</DialogTitle>
          <DialogDescription>{options?.subtitle ? `${options.subtitle} · ` : ""}Saved on this device, to watch without a connection.</DialogDescription>
        </DialogHeader>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        {!options && !error && (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Loading…
          </p>
        )}
        {options && (
          <ul className="flex flex-col gap-2">
            {options.options.map((option) => {
              const record = records.find((r) => r.id === downloadId(options.kind, options.ownerKind, options.ownerId, option.label));
              return (
                <li key={option.label || "default"} className="flex items-center gap-3 rounded-xl bg-white/[0.04] px-4 py-3 ring-1 ring-white/[0.08]">
                  <div className="min-w-0 flex-1">
                    <p className="font-medium">{option.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {formatBytes(option.sizeBytes)}
                      {option.parts > 1 ? ` · ${option.parts} parts` : ""}
                      {record && record.status !== "complete" ? ` · ${progressText(record)}` : ""}
                      {record?.status === "complete" ? " · on this device" : ""}
                    </p>
                    {record?.status === "downloading" && <ProgressBar record={record} />}
                    {record?.error && <p className="mt-1 text-xs text-destructive">{record.error}</p>}
                  </div>
                  <RowActions record={record} busy={starting === option.label} onStart={() => begin(option)} />
                </li>
              );
            })}
          </ul>
        )}
        {space && (
          <p className="text-xs text-muted-foreground">
            {formatBytes(space.usage)} used on this device · about {formatBytes(Math.max(0, space.quota - space.usage))} free to use
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function progressText(record: DownloadRecord): string {
  const pct = percentOf(savedBytes(record), record.totalBytes);
  if (record.status === "downloading") return pct === null ? "downloading" : `${pct}%`;
  if (record.status === "paused") return pct === null ? "paused" : `paused at ${pct}%`;
  if (record.status === "error") return "stopped";
  return "";
}

export function ProgressBar({ record, className }: { record: DownloadRecord; className?: string }) {
  const pct = percentOf(savedBytes(record), record.totalBytes);
  return (
    <div className={cn("mt-1.5 h-1 overflow-hidden rounded-full bg-white/15", className)} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct ?? undefined}>
      <div className={cn("h-full rounded-full bg-primary", pct === null && "w-1/3 animate-pulse")} style={pct === null ? undefined : { width: `${pct}%` }} />
    </div>
  );
}

/** The buttons for one version: download, or pause/cancel while it runs, resume when stopped, remove once it is saved. */
export function RowActions({ record, busy, onStart }: { record: DownloadRecord | undefined; busy?: boolean; onStart?: () => void }) {
  if (!record) {
    return (
      <Button type="button" size="sm" variant="secondary" disabled={busy} onClick={onStart} className="gap-1.5 rounded-lg">
        {busy ? <Loader2 className="size-4 animate-spin" /> : <CloudDownload className="size-4" />} Download
      </Button>
    );
  }
  if (record.status === "complete") {
    return (
      <Button type="button" size="icon" variant="ghost" aria-label={`Remove ${record.versionName || "download"}`} onClick={() => void removeDownload(record.id)} className="rounded-full">
        <Trash2 className="size-4" />
      </Button>
    );
  }
  return (
    <div className="flex items-center gap-1">
      {record.status === "downloading" ? (
        <Button type="button" size="icon" variant="ghost" aria-label="Pause" onClick={() => void pauseDownload(record.id)} className="rounded-full">
          <Pause className="size-4" />
        </Button>
      ) : (
        <Button type="button" size="icon" variant="ghost" aria-label="Resume" onClick={() => void resumeDownload(record.id)} className="rounded-full">
          <Play className="size-4" />
        </Button>
      )}
      <Button type="button" size="icon" variant="ghost" aria-label="Cancel and remove" onClick={() => void removeDownload(record.id)} className="rounded-full">
        <X className="size-4" />
      </Button>
    </div>
  );
}
