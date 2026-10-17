"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Artwork as Image } from "@/components/ui/artwork";
import { Check, Gift, Heart, Loader2, Plus, ShoppingCart, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { countsByKind, filterWishes, isDone } from "@/lib/wishlist/filter";
import { MAX_CREATOR, MAX_NOTE, MAX_TITLE, TMDB_KINDS, WISH_KINDS, WISH_KIND_LABEL, type WishKind } from "@/lib/wishlist/rules";
import type { WishView } from "@/lib/wishlist/service";
import type { WishSearchHit } from "@/app/api/servers/[serverId]/wishlist/search/route";

async function call(method: string, url: string, body?: unknown): Promise<{ ok: boolean; status: number; data: Record<string, any> }> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const res = await fetch(url, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { ok: res.ok, status: res.status, data: await res.json().catch(() => ({})) };
}

/** Adding a wish: a movie or show is found on TMDB (with its picture); anything else is typed in. */
function AddDialog({ serverId, onClose, onAdded }: { serverId: string; onClose: () => void; onAdded: () => void }) {
  const [kind, setKind] = useState<WishKind>("movie");
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<WishSearchHit[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [manual, setManual] = useState(false);
  const [title, setTitle] = useState("");
  const [creator, setCreator] = useState("");
  const [year, setYear] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lookup = (TMDB_KINDS as readonly string[]).includes(kind) && !manual;
  const searchable = lookup && query.trim().length >= 2;
  const latest = useRef(0);

  useEffect(() => {
    if (!lookup || query.trim().length < 2) return;
    const ticket = ++latest.current;
    const timer = setTimeout(async () => {
      setSearching(true);
      const res = await call("GET", `/api/servers/${serverId}/wishlist/search?kind=${kind}&q=${encodeURIComponent(query.trim())}`);
      if (ticket !== latest.current) return;
      setSearching(false);
      if (!res.ok) {
        setError(typeof res.data.error === "string" ? res.data.error : "The search didn't work.");
        return;
      }
      setError(null);
      setHits(res.data.results as WishSearchHit[]);
    }, 300);
    return () => clearTimeout(timer);
  }, [query, kind, lookup, serverId]);

  async function submit(payload: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    const res = await call("POST", `/api/servers/${serverId}/wishlist`, payload);
    setBusy(false);
    if (!res.ok) return setError(typeof res.data.error === "string" ? res.data.error : "Couldn't add that.");
    toast.success(res.data.joined ? "That was already on the list: you want it too now." : "Added to the wishlist.");
    onAdded();
    onClose();
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add to the wishlist</DialogTitle>
          <DialogDescription>Something you&apos;d like the household that buys media to get next. Everyone on this server sees it.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="What kind">
          {WISH_KINDS.map((k) => (
            <button key={k} type="button" role="radio" aria-checked={kind === k} onClick={() => (setKind(k), setHits(null), setManual(false), setError(null))} className={cn("rounded-full px-3 py-1.5 text-xs font-medium ring-1 transition-colors", kind === k ? "bg-primary text-primary-foreground ring-primary" : "bg-white/[0.06] text-muted-foreground ring-white/10 hover:bg-white/10")}>
              {WISH_KIND_LABEL[k]}
            </button>
          ))}
        </div>

        {lookup ? (
          <div className="flex flex-col gap-3">
            <Input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder={kind === "movie" ? "Search for a movie" : "Search for a TV show"} aria-label="Search" />
            {searching && <p className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="size-3 animate-spin" /> Searching…</p>}
            {searchable && hits && hits.length === 0 && !searching && <p className="text-sm text-muted-foreground">Nothing found. Try another spelling, or add it by name.</p>}
            <ul className="flex flex-col gap-2">
              {(searchable ? hits : null)?.map((h) => (
                <li key={h.tmdbId} className="flex items-center gap-3 rounded-xl bg-white/[0.04] p-2 ring-1 ring-white/[0.08]">
                  <div className="relative aspect-[2/3] w-10 shrink-0 overflow-hidden rounded-md bg-muted">{h.posterUrl && <Image src={h.posterUrl} alt="" fill sizes="40px" className="object-cover" />}</div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{h.title}{h.year ? ` (${h.year})` : ""}</p>
                    {h.overview && <p className="line-clamp-2 text-xs text-muted-foreground">{h.overview}</p>}
                  </div>
                  {h.titleId ? (
                    <span className="shrink-0 text-xs text-muted-foreground">Already here</span>
                  ) : (
                    <Button size="sm" variant="secondary" disabled={busy} onClick={() => void submit({ kind: h.kind, title: h.title, year: h.year, tmdbId: h.tmdbId, posterUrl: h.posterUrl, overview: h.overview })}>
                      {h.wishId ? "I want it too" : "Add"}
                    </Button>
                  )}
                </li>
              ))}
            </ul>
            <button type="button" onClick={() => (setManual(true), setTitle(query))} className="self-start text-xs font-medium text-primary hover:underline">
              Can&apos;t find it? Add it by name
            </button>
          </div>
        ) : (
          <form
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              const y = Number(year);
              void submit({ kind, title, creator: creator || null, year: Number.isInteger(y) && y > 0 ? y : null, note: note || null });
            }}
          >
            <Input autoFocus value={title} maxLength={MAX_TITLE} onChange={(e) => setTitle(e.target.value)} placeholder="Title" aria-label="Title" />
            <div className="grid grid-cols-[1fr_6rem] gap-2">
              <Input value={creator} maxLength={MAX_CREATOR} onChange={(e) => setCreator(e.target.value)} placeholder={kind === "album" ? "Artist" : kind === "movie" || kind === "show" ? "Director or creator (optional)" : "Author (optional)"} aria-label="Creator" />
              <Input value={year} inputMode="numeric" maxLength={4} onChange={(e) => setYear(e.target.value.replace(/\D/g, ""))} placeholder="Year" aria-label="Year" />
            </div>
            <Input value={note} maxLength={MAX_NOTE} onChange={(e) => setNote(e.target.value)} placeholder="A note, like which edition or narrator (optional)" aria-label="Note" />
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
              <Button type="submit" disabled={busy || !title.trim()}>Add</Button>
            </div>
          </form>
        )}
        {error && <p className="text-sm text-destructive">{error}</p>}
      </DialogContent>
    </Dialog>
  );
}

/** The shared wishlist: filter by kind, say you want something too, say you'll buy it, mark it got, take it off. */
export function WishlistView({ serverId, initial, canEdit }: { serverId: string; initial: WishView[]; canEdit: boolean }) {
  const [items, setItems] = useState(initial);
  const [kind, setKind] = useState<WishKind | "all">("all");
  const [showDone, setShowDone] = useState(false);
  const [adding, setAdding] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const res = await call("GET", `/api/servers/${serverId}/wishlist`);
    if (res.ok) setItems(res.data.items as WishView[]);
  }, [serverId]);

  async function act(id: string, run: () => ReturnType<typeof call>, failure = "That didn't work.") {
    setBusyId(id);
    const res = await run();
    setBusyId(null);
    if (!res.ok) toast.error(typeof res.data.error === "string" ? res.data.error : failure);
    await reload();
  }

  const shown = filterWishes(items, { kind, showDone });
  const counts = countsByKind(items);
  const doneCount = items.filter(isDone).length;
  const chips: (WishKind | "all")[] = ["all", ...WISH_KINDS.filter((k) => counts[k] > 0 || k === kind)];

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-3">
        <span className="flex size-10 items-center justify-center rounded-xl bg-white/[0.06] ring-1 ring-white/10">
          <Gift className="size-5 text-primary" />
        </span>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Wishlist</h1>
          <p className="text-sm text-muted-foreground">What this server would like to get next. Everyone here can see it.</p>
        </div>
        {canEdit && (
          <Button className="ml-auto gap-2" onClick={() => setAdding(true)}>
            <Plus className="size-4" /> Add
          </Button>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        {chips.map((k) => (
          <button key={k} type="button" aria-pressed={kind === k} onClick={() => setKind(k)} className={cn("rounded-full px-3 py-1.5 text-xs font-medium ring-1 transition-colors", kind === k ? "bg-primary text-primary-foreground ring-primary" : "bg-white/[0.06] text-muted-foreground ring-white/10 hover:bg-white/10")}>
            {k === "all" ? "Everything" : WISH_KIND_LABEL[k]} · {counts[k]}
          </button>
        ))}
        {doneCount > 0 && (
          <label className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
            <input type="checkbox" checked={showDone} onChange={(e) => setShowDone(e.target.checked)} className="size-4 rounded border-input" />
            Show what&apos;s got ({doneCount})
          </label>
        )}
      </div>

      {shown.length === 0 ? (
        <p className="px-1 py-10 text-sm text-muted-foreground">{items.length === 0 ? "Nothing on the wishlist yet." : "Nothing here with these filters."}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {shown.map((w) => {
            const done = isDone(w);
            return (
              <li key={w.id} className={cn("flex gap-3 rounded-2xl bg-white/[0.04] p-3 ring-1 ring-white/[0.08]", done && "opacity-70")}>
                <div className="relative aspect-[2/3] w-16 shrink-0 overflow-hidden rounded-lg bg-muted ring-1 ring-white/[0.08]">
                  {w.posterUrl ? <Image src={w.posterUrl} alt="" fill sizes="64px" className="object-cover" /> : <div className="flex h-full items-center justify-center text-muted-foreground/50"><Gift className="size-5" /></div>}
                </div>
                <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                  <div className="flex flex-wrap items-baseline gap-x-2">
                    <h2 className="text-base font-semibold">{w.title}{w.year ? <span className="font-normal text-muted-foreground"> ({w.year})</span> : null}</h2>
                    <span className="rounded-full bg-white/[0.07] px-2 py-0.5 text-[11px] font-medium text-muted-foreground">{WISH_KIND_LABEL[w.kind]}</span>
                    {w.status === "claimed" && <span className="rounded-full bg-primary/15 px-2 py-0.5 text-[11px] font-medium text-primary">{w.claimedByMe ? "You're getting this" : `${w.claimedByName} is getting this`}</span>}
                    {w.status === "got" && <span className="rounded-full bg-white/[0.07] px-2 py-0.5 text-[11px] font-medium text-muted-foreground">Got it</span>}
                    {w.onServer && (
                      <Link href={`/s/${serverId}/title/${w.onServer.titleId}`} className="rounded-full bg-primary/15 px-2 py-0.5 text-[11px] font-medium text-primary hover:underline">
                        Now on the server
                      </Link>
                    )}
                  </div>
                  {w.creator && <p className="text-xs text-muted-foreground">{w.creator}</p>}
                  {w.overview && <p className="line-clamp-2 text-xs text-muted-foreground">{w.overview}</p>}
                  {w.note && <p className="text-xs italic text-foreground/80">“{w.note}”</p>}
                  <p className="text-xs text-muted-foreground">
                    {w.wants === 1 ? "1 household wants this" : `${w.wants} households want this`}
                    {w.wantedBy.length > 0 ? ` · ${w.wantedBy.join(", ")}` : ""}
                  </p>
                  {canEdit && (
                    <div className="mt-1 flex flex-wrap gap-2">
                      {!done && (
                        <Button size="sm" variant={w.iWant ? "default" : "secondary"} disabled={busyId === w.id} aria-pressed={w.iWant} onClick={() => void act(w.id, () => call("PUT", `/api/wishlist/${w.id}/want`, { on: !w.iWant }))} className="gap-1.5">
                          <Heart className={cn("size-3.5", w.iWant && "fill-current")} /> {w.iWant ? "You want this" : "I want this too"}
                        </Button>
                      )}
                      {w.status === "wanted" && !w.onServer && (
                        <Button size="sm" variant="secondary" disabled={busyId === w.id} onClick={() => void act(w.id, () => call("PATCH", `/api/wishlist/${w.id}`, { action: "claim" }))} className="gap-1.5">
                          <ShoppingCart className="size-3.5" /> I&apos;ll get this
                        </Button>
                      )}
                      {w.status === "claimed" && (
                        <>
                          <Button size="sm" variant="secondary" disabled={busyId === w.id} onClick={() => void act(w.id, () => call("PATCH", `/api/wishlist/${w.id}`, { action: "got" }))} className="gap-1.5">
                            <Check className="size-3.5" /> We got it
                          </Button>
                          {w.claimedByMe && (
                            <Button size="sm" variant="ghost" disabled={busyId === w.id} onClick={() => void act(w.id, () => call("PATCH", `/api/wishlist/${w.id}`, { action: "unclaim" }))} className="gap-1.5">
                              <X className="size-3.5" /> Not me after all
                            </Button>
                          )}
                        </>
                      )}
                      {w.canRemove && (
                        <Button size="sm" variant="ghost" disabled={busyId === w.id} aria-label={`Take ${w.title} off the wishlist`} onClick={() => void act(w.id, () => call("DELETE", `/api/wishlist/${w.id}`))} className="gap-1.5 text-muted-foreground">
                          <Trash2 className="size-3.5" /> Remove
                        </Button>
                      )}
                    </div>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {adding && <AddDialog serverId={serverId} onClose={() => setAdding(false)} onAdded={() => void reload()} />}
    </div>
  );
}
