"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Flag, Lock, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CATEGORY_LABELS, SEVERITY_LABELS, FILTER_SEVERITIES, type FilterCue, type FilterSeverity } from "@/lib/content-filter/categories";
import { MARK_CATEGORIES, type MarkCategory } from "@/lib/content-filter/marks";
import { formatClock } from "@/lib/player/timeline";
import type { SkipKind, SkipSegment } from "@/lib/skipdb/client";
import { SKIP_KINDS, SKIP_KIND_LABELS } from "@/lib/skipdb/marks";
import { cn } from "@/lib/utils";

interface MarkSet {
  writesFiles: boolean;
  durationSeconds: number;
  editable: FilterCue[];
  readOnly: FilterCue[];
}

const stamp = (seconds: number) => formatClock(seconds);
const selectClass = "h-9 w-full min-w-0 rounded-md border border-input bg-transparent px-2 text-sm";

/**
 * Where a server's admin marks scenes while watching: press Start where a scene begins and End where it is over, say what it is, and it is
 * saved (as a file beside the video where Roam can write one, otherwise in Roam). It acts from the next play. Times here are the video's
 * own clock, not the shortened bar.
 */
export function MarkPanel({
  ownerKind,
  ownerId,
  version,
  getTime,
  seekTo,
  pause,
  onClose,
}: {
  ownerKind: "title" | "episode";
  ownerId: string;
  version: string;
  getTime: () => number;
  seekTo: (seconds: number) => void;
  pause: () => void;
  onClose: () => void;
}) {
  const [marks, setMarks] = useState<MarkSet | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [start, setStart] = useState<number | null>(null);
  const [end, setEnd] = useState<number | null>(null);
  const [category, setCategory] = useState<MarkCategory>("violence");
  const [severity, setSeverity] = useState<FilterSeverity>("high");
  const [soundOnly, setSoundOnly] = useState(false);
  const [note, setNote] = useState("");
  // Two kinds of marks share the start/end controls: scenes to skip or mute (filtering), and the times behind the Skip intro-style buttons.
  const [tab, setTab] = useState<"scenes" | "buttons">("scenes");
  const [skipMarks, setSkipMarks] = useState<SkipSegment[] | null>(null);
  const [skipKind, setSkipKind] = useState<SkipKind>("intro");

  const url = `/api/marks/${ownerKind}/${ownerId}`;
  useEffect(() => {
    let cancelled = false;
    fetch(`${url}?version=${encodeURIComponent(version)}`)
      .then(async (res) => {
        if (cancelled) return;
        if (!res.ok) return setError(res.status === 409 ? "This isn't ready to mark yet." : "Couldn't load the marks.");
        setMarks((await res.json()) as MarkSet);
      })
      .catch(() => !cancelled && setError("Couldn't load the marks."));
    return () => {
      cancelled = true;
    };
  }, [url, version]);

  const skipUrl = `/api/skip-marks/${ownerKind}/${ownerId}`;
  useEffect(() => {
    let cancelled = false;
    fetch(`${skipUrl}?version=${encodeURIComponent(version)}`)
      .then(async (res) => !cancelled && res.ok && setSkipMarks(((await res.json()) as { marks: SkipSegment[] }).marks))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [skipUrl, version]);

  const saveSkips = useCallback(
    async (list: SkipSegment[]) => {
      setSaving(true);
      const res = await fetch(skipUrl, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ version, marks: list }) }).catch(() => null);
      setSaving(false);
      if (!res || !res.ok) {
        toast.error("Couldn't save. Nothing was changed.");
        return false;
      }
      setSkipMarks(((await res.json()) as { marks: SkipSegment[] }).marks);
      toast.success("Saved. These times are used for the skip buttons from the next play.");
      return true;
    },
    [skipUrl, version]
  );

  const save = useCallback(
    async (list: FilterCue[]) => {
      setSaving(true);
      const res = await fetch(url, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ version, cues: list }) }).catch(() => null);
      setSaving(false);
      if (!res || !res.ok) {
        toast.error("Couldn't save. Nothing was changed.");
        return false;
      }
      const next = (await res.json()) as MarkSet;
      setMarks(next);
      toast.success(next.writesFiles ? "Saved to a file beside the video. It applies from the next play." : "Saved. It applies from the next play.");
      return true;
    },
    [url, version]
  );

  const ready = start !== null && end !== null && end > start;
  async function addSkip() {
    if (!skipMarks || !ready) return;
    // One time per kind: marking a kind again replaces the earlier one.
    const next = [...skipMarks.filter((m) => m.kind !== skipKind), { kind: skipKind, startSeconds: start!, endSeconds: end! }];
    if (await saveSkips(next)) {
      setStart(null);
      setEnd(null);
    }
  }
  async function add() {
    if (!marks || !ready) return;
    const cue: FilterCue = { startSeconds: start!, endSeconds: end!, category, severity, channel: soundOnly ? "sound" : "both", ...(note.trim() ? { note: note.trim() } : {}) };
    if (await save([...marks.editable, cue])) {
      setStart(null);
      setEnd(null);
      setNote("");
    }
  }
  const nudge = (which: "start" | "end", by: number) => (which === "start" ? setStart((s) => (s === null ? s : Math.max(0, s + by))) : setEnd((e) => (e === null ? e : Math.max(0, e + by))));

  return (
    <div role="dialog" aria-label="Mark a scene" className="absolute right-2 bottom-24 z-30 flex max-h-[70dvh] w-[min(calc(100vw-1rem),26rem)] flex-col gap-3 overflow-y-auto rounded-xl bg-black/90 p-4 text-sm text-white ring-1 ring-white/15 backdrop-blur">
      <div className="flex items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 font-medium">
          <Flag className="size-4" aria-hidden="true" /> Mark a scene
        </h2>
        <Button variant="ghost" size="icon-sm" aria-label="Close" onClick={onClose} className="text-white hover:bg-white/15">
          <X className="size-4" />
        </Button>
      </div>

      {error ? (
        <p className="text-white/80">{error}</p>
      ) : !marks ? (
        <p className="text-white/70">Loading…</p>
      ) : (
        <>
          <div role="tablist" aria-label="What to mark" className="grid grid-cols-2 gap-1 rounded-lg bg-white/[0.06] p-1">
            {([["scenes", "Scenes to skip"], ["buttons", "Skip buttons"]] as const).map(([id, label]) => (
              <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)} className={cn("rounded-md px-2 py-1.5 text-xs font-medium", tab === id ? "bg-white text-black" : "text-white/70 hover:bg-white/10")}>
                {label}
              </button>
            ))}
          </div>
          <p className="text-xs text-white/60">
            {tab === "scenes"
              ? `${marks.writesFiles ? "Saved as a scene file beside the video." : "Saved in Roam (this storage can't take a file)."} Times are the video's own. Applies from the next play.`
              : "The times behind Skip intro, Skip recap, Next episode and Skip credits for this video. Saved in Roam, and used instead of SkipDB's for the same part. Applies from the next play."}
          </p>

          <div className="grid grid-cols-[minmax(0,1fr)] gap-2 rounded-lg bg-white/[0.06] p-3">
            <div className="grid grid-cols-2 gap-2">
              <Button type="button" variant="secondary" size="sm" onClick={() => { setStart(getTime()); setEnd(null); }}>
                Scene starts here
              </Button>
              <Button type="button" variant="secondary" size="sm" disabled={start === null} onClick={() => { setEnd(getTime()); pause(); }}>
                Scene ends here
              </Button>
            </div>
            <div className="grid grid-cols-2 gap-2 text-xs tabular-nums text-white/80">
              {(["start", "end"] as const).map((which) => {
                const value = which === "start" ? start : end;
                return (
                  <div key={which} className="flex min-w-0 items-center justify-between gap-1">
                    <span className="truncate">{which === "start" ? "From" : "To"} {value === null ? "—" : stamp(value)}</span>
                    {value !== null && (
                      <span className="flex shrink-0 gap-0.5">
                        <button type="button" aria-label={`${which} 1 second earlier`} onClick={() => nudge(which, -1)} className="rounded bg-white/10 px-1.5 hover:bg-white/20">−1s</button>
                        <button type="button" aria-label={`${which} 1 second later`} onClick={() => nudge(which, 1)} className="rounded bg-white/10 px-1.5 hover:bg-white/20">+1s</button>
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
            {tab === "buttons" ? (
              <>
                <label className="grid min-w-0 gap-1 text-xs text-white/70">
                  Which part
                  <select value={skipKind} onChange={(e) => setSkipKind(e.target.value as SkipKind)} className={selectClass}>
                    {SKIP_KINDS.map((k) => (
                      <option key={k} value={k} className="bg-popover">{SKIP_KIND_LABELS[k]}</option>
                    ))}
                  </select>
                </label>
                <Button type="button" size="sm" disabled={!ready || saving || !skipMarks} onClick={() => void addSkip()}>
                  {saving ? "Saving…" : `Save this ${SKIP_KIND_LABELS[skipKind].toLowerCase()}`}
                </Button>
              </>
            ) : (
            <>
            <div className="grid grid-cols-2 gap-2">
              <label className="grid min-w-0 gap-1 text-xs text-white/70">
                What it is
                <select value={category} onChange={(e) => setCategory(e.target.value as MarkCategory)} className={selectClass}>
                  {MARK_CATEGORIES.map((c) => (
                    <option key={c} value={c} className="bg-popover">{CATEGORY_LABELS[c]}</option>
                  ))}
                </select>
              </label>
              <label className="grid min-w-0 gap-1 text-xs text-white/70">
                How strong
                <select value={severity} onChange={(e) => setSeverity(e.target.value as FilterSeverity)} className={selectClass}>
                  {[...FILTER_SEVERITIES].reverse().map((s) => (
                    <option key={s} value={s} className="bg-popover">{SEVERITY_LABELS[s]}</option>
                  ))}
                </select>
              </label>
            </div>
            <label className="flex items-center gap-2 text-xs text-white/80">
              <input type="checkbox" checked={soundOnly} onChange={(e) => setSoundOnly(e.target.checked)} className="size-4 rounded border-input" />
              Sound only (mute, keep the picture)
            </label>
            <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={160} placeholder="A short note (optional)" aria-label="A short note" className={cn(selectClass, "placeholder:text-white/40")} />
            <Button type="button" size="sm" disabled={!ready || saving} onClick={() => void add()}>
              {saving ? "Saving…" : "Save this scene"}
            </Button>
            </>
            )}
          </div>

          {tab === "buttons" ? (
            <div className="grid grid-cols-[minmax(0,1fr)] gap-1.5">
              <h3 className="text-xs font-medium text-white/70">Marked times ({skipMarks?.length ?? 0})</h3>
              {skipMarks?.length === 0 && <p className="text-xs text-white/50">None yet. Where SkipDB has times for a show, those are used.</p>}
              {skipMarks?.map((m) => (
                <div key={m.kind} className="flex min-w-0 items-center gap-2 rounded-md bg-white/[0.06] px-2 py-1.5">
                  <button type="button" onClick={() => seekTo(Math.max(0, m.startSeconds - 2))} className="min-w-0 flex-1 text-left" title="Jump to just before this part">
                    <span className="block truncate">{SKIP_KIND_LABELS[m.kind]}</span>
                    <span className="block text-xs tabular-nums text-white/60">{stamp(m.startSeconds)} – {stamp(m.endSeconds)}</span>
                  </button>
                  <Button type="button" variant="ghost" size="icon-sm" aria-label="Delete this time" disabled={saving} onClick={() => void saveSkips(skipMarks.filter((x) => x.kind !== m.kind))} className="text-white hover:bg-white/15">
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              ))}
            </div>
          ) : (
          <div className="grid grid-cols-[minmax(0,1fr)] gap-1.5">
            <h3 className="text-xs font-medium text-white/70">Marked scenes ({marks.editable.length})</h3>
            {marks.editable.length === 0 && <p className="text-xs text-white/50">None yet.</p>}
            {marks.editable.map((c, i) => (
              <div key={`${c.startSeconds}-${c.endSeconds}-${c.category}-${i}`} className="flex min-w-0 items-center gap-2 rounded-md bg-white/[0.06] px-2 py-1.5">
                <button type="button" onClick={() => seekTo(Math.max(0, c.startSeconds - 3))} className="min-w-0 flex-1 text-left" title="Jump to just before this scene">
                  <span className="block truncate">{CATEGORY_LABELS[c.category]} · {SEVERITY_LABELS[c.severity]}{c.channel === "sound" ? " · sound only" : ""}</span>
                  <span className="block text-xs tabular-nums text-white/60">{stamp(c.startSeconds)} – {stamp(c.endSeconds)}</span>
                </button>
                <Button type="button" variant="ghost" size="icon-sm" aria-label="Delete this scene" disabled={saving} onClick={() => void save(marks.editable.filter((_, j) => j !== i))} className="text-white hover:bg-white/15">
                  <Trash2 className="size-4" />
                </Button>
              </div>
            ))}
            {marks.readOnly.length > 0 && (
              <>
                <h3 className="mt-1 flex items-center gap-1.5 text-xs font-medium text-white/70"><Lock className="size-3" aria-hidden="true" /> From a scene file Roam can&apos;t change here ({marks.readOnly.length})</h3>
                {marks.readOnly.map((c, i) => (
                  <div key={`${c.startSeconds}-${i}`} className="rounded-md bg-white/[0.03] px-2 py-1.5 text-white/70">
                    <span className="block truncate">{CATEGORY_LABELS[c.category]} · {SEVERITY_LABELS[c.severity]}</span>
                    <span className="block text-xs tabular-nums text-white/50">{stamp(c.startSeconds)} – {stamp(c.endSeconds)}</span>
                  </div>
                ))}
              </>
            )}
          </div>
          )}
        </>
      )}
    </div>
  );
}
