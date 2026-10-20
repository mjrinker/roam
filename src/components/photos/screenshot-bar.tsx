"use client";

import { useState } from "react";
import { Loader2, X } from "lucide-react";
import { toast } from "sonner";

/** Marks (or unmarks) pictures as screenshots, for the admin; the same call serves one picture and a selection. Answers how many changed, or null if it failed. */
export async function markScreenshots(serverId: string, ids: string[], screenshot: boolean): Promise<number | null> {
  let changed = 0;
  // The route takes at most 500 at a time.
  for (let i = 0; i < ids.length; i += 500) {
    const res = await fetch("/api/photos/screenshots", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ serverId, ids: ids.slice(i, i + 500), screenshot }) }).catch(() => null);
    if (!res?.ok) return null;
    changed += ((await res.json().catch(() => ({}))) as { changed?: number }).changed ?? 0;
  }
  return changed;
}

/** The bar shown while pictures are selected: mark them as screenshots, or as not. */
export function ScreenshotBar({ serverId, ids, onDone, onCancel }: { serverId: string; ids: string[]; onDone: (ids: string[], screenshot: boolean) => void; onCancel: () => void }) {
  const [busy, setBusy] = useState(false);
  async function apply(screenshot: boolean) {
    setBusy(true);
    const changed = await markScreenshots(serverId, ids, screenshot);
    setBusy(false);
    if (changed === null) return toast.error("Couldn't change those.");
    toast.success(`${changed} marked as ${screenshot ? "screenshots" : "not screenshots"}.`);
    onDone(ids, screenshot);
  }
  const button = "h-9 rounded-lg bg-white/10 px-3 text-sm font-medium text-white transition hover:bg-white/20 disabled:opacity-50";
  return (
    <div role="toolbar" aria-label="Selected photos" className="fixed inset-x-3 bottom-4 z-40 mx-auto flex w-fit max-w-full flex-wrap items-center justify-center gap-2 rounded-2xl bg-black/85 px-3 py-2 text-white shadow-xl ring-1 ring-white/15 backdrop-blur">
      <span className="text-sm tabular-nums">{ids.length} selected</span>
      <button type="button" className={button} disabled={busy || ids.length === 0} onClick={() => void apply(true)}>
        Mark as screenshots
      </button>
      <button type="button" className={button} disabled={busy || ids.length === 0} onClick={() => void apply(false)}>
        Not screenshots
      </button>
      {busy ? <Loader2 className="size-4 animate-spin" /> : null}
      <button type="button" aria-label="Cancel selection" className="flex size-9 items-center justify-center rounded-lg hover:bg-white/10" onClick={onCancel}>
        <X className="size-4" />
      </button>
    </div>
  );
}
