"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { CloudDownload, Film, Headphones } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatBytes } from "@/lib/offline/format";
import { savedBytes } from "@/lib/offline/manager";
import { offlineStorageSupported, storageUsage } from "@/lib/offline/storage";
import type { DownloadRecord } from "@/lib/offline/types";
import { useDownloads } from "@/lib/offline/use-downloads";
import { useAudioActions } from "@/components/audio/audio-player-provider";
import { ProgressBar, progressText, RowActions } from "@/components/offline/download-button";

function Poster({ blob, kind }: { blob: Blob | null; kind: DownloadRecord["kind"] }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!blob) return;
    const made = URL.createObjectURL(blob);
    setUrl(made); // eslint-disable-line react-hooks/set-state-in-effect
    return () => URL.revokeObjectURL(made);
  }, [blob]);
  return (
    <div className="flex h-20 w-14 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-muted ring-1 ring-white/10">
      {url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={url} alt="" className="size-full object-cover" />
      ) : kind === "listen" ? (
        <Headphones className="size-5 text-muted-foreground/60" />
      ) : (
        <Film className="size-5 text-muted-foreground/60" />
      )}
    </div>
  );
}

/**
 * Everything saved on this device: what each is, how big, how far along; play it, pause or resume, remove it. `playTo` gives the link
 * that plays a finished one (online: the watch page; offline: the offline player).
 */
export function DownloadsList({ onPlayVideo }: { onPlayVideo: (record: DownloadRecord) => void }) {
  const audio = useAudioActions();
  const records = useDownloads();
  const supported = useSyncExternalStore(() => () => undefined, offlineStorageSupported, () => false);
  const [space, setSpace] = useState<{ usage: number; quota: number } | null>(null);
  useEffect(() => {
    storageUsage().then(setSpace);
  }, [records.length]);

  if (!supported) {
    return <p className="text-sm text-muted-foreground">This browser can&apos;t save downloads. Try the installed app, or Chrome, Edge, Firefox or Safari.</p>;
  }
  if (records.length === 0) {
    return (
      <div className="flex flex-col items-center gap-3 rounded-2xl bg-white/[0.04] px-6 py-14 text-center ring-1 ring-white/[0.08]">
        <CloudDownload className="size-8 text-muted-foreground" />
        <p className="font-medium">Nothing downloaded yet</p>
        <p className="max-w-sm text-sm text-muted-foreground">Use Download on a movie, episode, song or audiobook to keep it on this device and watch it without a connection.</p>
      </div>
    );
  }
  const total = records.reduce((n, r) => n + savedBytes(r), 0);
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <ul className="flex min-w-0 flex-col gap-2">
        {records.map((r) => (
          <li key={r.id} className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 rounded-xl bg-white/[0.04] p-3 ring-1 ring-white/[0.08]">
            <Poster blob={r.poster} kind={r.kind} />
            <div className="min-w-0 flex-1 basis-40">
              <p className="truncate font-medium">{r.title}</p>
              {r.subtitle && <p className="truncate text-sm text-muted-foreground">{r.subtitle}</p>}
              <p className="text-xs text-muted-foreground">
                {r.versionName} · {formatBytes(r.status === "complete" ? savedBytes(r) : r.totalBytes)}
                {r.status !== "complete" ? ` · ${progressText(r)}` : ""}
              </p>
              {r.status === "downloading" && <ProgressBar record={r} />}
              {r.error && <p className="mt-1 text-xs text-destructive">{r.error}</p>}
            </div>
            <div className="ml-auto flex shrink-0 items-center gap-2">
              {r.status === "complete" && (
                <Button
                  type="button"
                  size="sm"
                  className="rounded-lg"
                  disabled={r.kind === "listen" && !audio}
                  onClick={() => (r.kind === "listen" ? void audio?.load(r.ownerId, { autoplay: true }) : onPlayVideo(r))}
                >
                  Play
                </Button>
              )}
              <RowActions record={r} />
            </div>
          </li>
        ))}
      </ul>
      <p className="text-xs text-muted-foreground">
        {formatBytes(total)} downloaded{space ? ` · ${formatBytes(space.usage)} used on this device in all, about ${formatBytes(Math.max(0, space.quota - space.usage))} free to use` : ""}
      </p>
      <p className="text-xs text-muted-foreground">
        Downloads live in this browser on this device. Clearing the site&apos;s data removes them. Go to <Link href="/" className="underline">Roam</Link> when you&apos;re back online.
      </p>
    </div>
  );
}
