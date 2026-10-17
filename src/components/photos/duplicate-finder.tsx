"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Artwork as Image } from "@/components/ui/artwork";
import { Check, EyeOff, Loader2, RotateCcw, ScanSearch } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { formatBytes } from "@/lib/offline/format";
import type { DupGroup, DupItem, HiddenItem, Progress } from "@/lib/photos/dedupe/service";

type Match = "exact" | "similar" | "loose";
const MATCH_WORDS: Record<Match, { label: string; hint: string }> = {
  exact: { label: "Identical", hint: "The same picture, perhaps saved again or resized." },
  similar: { label: "Look the same", hint: "Also edits and crops of the same picture." },
  loose: { label: "Alike", hint: "Includes a burst of shots of one scene: look before you hide any." },
};

async function call(method: string, url: string, body?: unknown): Promise<{ ok: boolean; data: Record<string, any> }> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const res = await fetch(url, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { ok: res.ok, data: await res.json().catch(() => ({})) };
}

const sizeWords = (i: DupItem) => [i.width && i.height ? `${i.width}×${i.height}` : null, i.sizeBytes ? formatBytes(i.sizeBytes) : null].filter(Boolean).join(" · ");

function Thumb({ item, kept, onPick, picked }: { item: DupItem; kept: boolean; onPick: () => void; picked: boolean }) {
  return (
    <button type="button" onClick={onPick} aria-pressed={kept} className={cn("group relative flex w-40 shrink-0 flex-col gap-1.5 rounded-xl p-1.5 text-left outline-none ring-1 transition focus-visible:ring-2 focus-visible:ring-primary", kept ? "bg-primary/10 ring-primary" : "bg-white/[0.04] ring-white/[0.08] hover:bg-white/[0.07]", picked && "opacity-100")}>
      <div className="relative aspect-square overflow-hidden rounded-lg bg-muted">
        <Image src={item.thumbUrl} alt={item.name} fill sizes="160px" className="object-cover" />
        {kept && (
          <span className="absolute top-1.5 left-1.5 flex items-center gap-1 rounded-full bg-primary px-2 py-0.5 text-[11px] font-semibold text-primary-foreground">
            <Check className="size-3" /> Keep
          </span>
        )}
      </div>
      <p className="truncate px-0.5 text-xs font-medium" title={item.name}>{item.name}</p>
      <p className="truncate px-0.5 text-[11px] text-muted-foreground">{sizeWords(item) || "—"}</p>
      <p className="truncate px-0.5 text-[11px] text-muted-foreground">{item.takenAt ? new Date(item.takenAt).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" }) : "No date"}{item.folderPath ? ` · ${item.folderPath}` : ""}</p>
    </button>
  );
}

/** One group: pick the photo to keep (the biggest is suggested), then hide the rest. */
function Group({ group, busy, onHide }: { group: DupGroup; busy: boolean; onHide: (keepId: string, hideIds: string[]) => void }) {
  const [keepId, setKeepId] = useState(group.keepId);
  const others = group.items.filter((i) => i.id !== keepId).map((i) => i.id);
  return (
    <li className="flex flex-col gap-3 rounded-2xl bg-white/[0.03] p-3 ring-1 ring-white/[0.08]">
      <div className="flex flex-wrap items-center gap-2">
        <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-medium", group.match === "exact" ? "bg-primary/15 text-primary" : "bg-white/[0.07] text-muted-foreground")}>{group.match === "exact" ? "Identical" : "Look alike"}</span>
        <span className="text-xs text-muted-foreground">{group.items.length} photos. Click the one to keep.</span>
        <Button size="sm" className="ml-auto gap-1.5" disabled={busy || others.length === 0} onClick={() => onHide(keepId, others)}>
          <EyeOff className="size-3.5" /> Hide the other {others.length === 1 ? "one" : others.length}
        </Button>
      </div>
      <div className="flex gap-2 overflow-x-auto pb-1">
        {group.items.map((i) => (
          <Thumb key={i.id} item={i} kept={i.id === keepId} picked={i.id === keepId} onPick={() => setKeepId(i.id)} />
        ))}
      </div>
    </li>
  );
}

/** Finds photos that are the same picture in a photo library and lets the admin hide the extra copies (nothing in the storage is touched). */
export function DuplicateFinder({ libraryId }: { libraryId: string }) {
  const [match, setMatch] = useState<Match>("similar");
  const [groups, setGroups] = useState<DupGroup[] | null>(null);
  const [hidden, setHidden] = useState<HiddenItem[]>([]);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [checking, setChecking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const stop = useRef(false);

  const [tick, setTick] = useState(0);
  const load = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    let cancelled = false;
    void call("GET", `/api/libraries/${libraryId}/duplicates?match=${match}`).then((res) => {
      if (cancelled) return;
      if (!res.ok) return setError(typeof res.data.error === "string" ? res.data.error : "Couldn't load the duplicates.");
      setGroups(res.data.groups as DupGroup[]);
      setHidden(res.data.hidden as HiddenItem[]);
      setProgress(res.data.progress as Progress);
    });
    return () => {
      cancelled = true;
    };
  }, [libraryId, match, tick]);

  async function check() {
    setChecking(true);
    setError(null);
    stop.current = false;
    for (let guard = 0; guard < 500 && !stop.current; guard++) {
      const res = await call("POST", `/api/libraries/${libraryId}/duplicates/hash`, {});
      if (!res.ok) {
        setError(typeof res.data.error === "string" ? res.data.error : "Checking stopped.");
        break;
      }
      const r = res.data as { total: number; checked: number; hashed: number; failed: number; budgetUsedUp: boolean };
      setProgress((p) => ({ total: r.total, checked: r.checked, failed: p?.failed ?? 0 }));
      if (r.budgetUsedUp) {
        setError("The photo service needs a minute to catch up. Press Check again in a moment.");
        break;
      }
      if (r.hashed + r.failed === 0) break; // nothing left to look at
    }
    setChecking(false);
    load();
  }

  async function hide(keepId: string, hideIds: string[]) {
    setBusy(true);
    const res = await call("POST", `/api/libraries/${libraryId}/duplicates/hide`, { keepId, hideIds });
    setBusy(false);
    if (!res.ok) return void toast.error(typeof res.data.error === "string" ? res.data.error : "Couldn't hide those.");
    toast.success(`Hidden ${hideIds.length === 1 ? "1 copy" : `${hideIds.length} copies`}. They can be restored below.`);
    load();
  }

  async function restore(ids: string[]) {
    setBusy(true);
    const res = await call("POST", `/api/libraries/${libraryId}/duplicates/restore`, { ids });
    setBusy(false);
    if (!res.ok) return void toast.error("Couldn't restore those.");
    toast.success(ids.length === 1 ? "Restored." : `Restored ${ids.length}.`);
    load();
  }

  const left = progress ? progress.total - progress.checked - progress.failed : 0;
  const pct = progress && progress.total > 0 ? Math.round((progress.checked / progress.total) * 100) : 0;

  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-3 rounded-2xl bg-white/[0.04] p-4 ring-1 ring-white/[0.08]">
        <div className="flex flex-wrap items-center gap-3">
          <ScanSearch className="size-5 text-primary" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">{progress ? `${progress.checked} of ${progress.total} photos checked` : "Loading…"}</p>
            <p className="text-xs text-muted-foreground">Each photo&apos;s small preview is looked at once (nothing is downloaded in full). Hiding a copy only leaves it out of the timeline.</p>
          </div>
          <Button variant="secondary" disabled={checking || (progress !== null && left <= 0 && progress.failed === 0)} onClick={() => void check()} className="gap-2">
            {checking ? <Loader2 className="size-4 animate-spin" /> : <ScanSearch className="size-4" />}
            {checking ? "Checking…" : progress && progress.checked > 0 && left > 0 ? "Check the rest" : progress && left <= 0 ? "Check again" : "Check photos"}
          </Button>
          {checking && (
            <Button variant="ghost" onClick={() => (stop.current = true)}>
              Stop
            </Button>
          )}
        </div>
        {progress && progress.total > 0 && (
          <div className="h-1.5 overflow-hidden rounded-full bg-white/10" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
            <div className="h-full bg-primary transition-all" style={{ width: `${pct}%` }} />
          </div>
        )}
        {progress && progress.failed > 0 && <p className="text-xs text-muted-foreground">{progress.failed} couldn&apos;t be read (a video, or a preview the storage hasn&apos;t made yet). They are tried again later.</p>}
        {error && <p className="text-sm text-destructive">{error}</p>}
      </section>

      <div className="flex flex-wrap items-center gap-1.5" role="radiogroup" aria-label="How alike">
        {(Object.keys(MATCH_WORDS) as Match[]).map((m) => (
          <button key={m} type="button" role="radio" aria-checked={match === m} onClick={() => setMatch(m)} className={cn("rounded-full px-3 py-1.5 text-xs font-medium ring-1 transition-colors", match === m ? "bg-primary text-primary-foreground ring-primary" : "bg-white/[0.06] text-muted-foreground ring-white/10 hover:bg-white/10")}>
            {MATCH_WORDS[m].label}
          </button>
        ))}
        <span className="text-xs text-muted-foreground">{MATCH_WORDS[match].hint}</span>
      </div>

      {groups === null ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : groups.length === 0 ? (
        <p className="px-1 py-6 text-sm text-muted-foreground">{progress && progress.checked === 0 ? "Press Check photos to look for duplicates." : "No duplicates found among the photos checked so far."}</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {groups.map((g) => (
            <Group key={g.items.map((i) => i.id).join()} group={g} busy={busy} onHide={(keep, ids) => void hide(keep, ids)} />
          ))}
        </ul>
      )}

      {hidden.length > 0 && (
        <section className="flex flex-col gap-3">
          <div className="flex items-center gap-3">
            <h2 className="text-lg font-semibold tracking-tight">Hidden copies ({hidden.length})</h2>
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => void restore(hidden.map((h) => h.id))} className="ml-auto gap-1.5">
              <RotateCcw className="size-3.5" /> Restore all
            </Button>
          </div>
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6">
            {hidden.map((h) => (
              <li key={h.id} className="flex flex-col gap-1.5 rounded-xl bg-white/[0.03] p-1.5 ring-1 ring-white/[0.08]">
                <div className="relative aspect-square overflow-hidden rounded-lg bg-muted">
                  <Image src={h.thumbUrl} alt={h.name} fill sizes="160px" className="object-cover opacity-70" />
                </div>
                <p className="truncate px-0.5 text-xs font-medium" title={h.name}>{h.name}</p>
                <p className="truncate px-0.5 text-[11px] text-muted-foreground">Copy of {h.keptName ?? "another photo"}</p>
                <Button size="sm" variant="secondary" disabled={busy} onClick={() => void restore([h.id])} className="gap-1.5">
                  <RotateCcw className="size-3" /> Restore
                </Button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
