"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Sparkles } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import type { SmartRules } from "@/lib/playlists/smart";
import { MEDIA_WORDS, SMART_MAX_LIMIT, SORT_WORDS, WATCHED_WORDS } from "@/lib/playlists/smart-words";
import { starsText } from "@/lib/ratings/stars";

const DEFAULT: SmartRules = { media: "movies", genres: [], minStars: null, maxStars: null, rated: "any", watched: "any", yearFrom: null, yearTo: null, addedWithinDays: null, libraryId: null, sort: "title", limit: 50 };
const SELECT = "h-9 rounded-lg bg-white/[0.06] px-2 text-sm ring-1 ring-white/[0.1] focus:outline-none focus:ring-2 focus:ring-primary";
const STAR_CHOICES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const num = (v: string): number | null => (v.trim() === "" || Number.isNaN(Number(v)) ? null : Math.trunc(Number(v)));

function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <label className="flex min-w-0 flex-col gap-1 text-sm">
      <span className="font-medium">{label}</span>
      {children}
      {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
    </label>
  );
}

/** Make a smart playlist (or change one's rules): choose what it holds, and it fills itself and keeps up. */
export function SmartPlaylistDialog({ serverId, playlistId, initialName = "", initialRules, open, onOpenChange }: { serverId: string; playlistId?: string; initialName?: string; initialRules?: SmartRules | null; open: boolean; onOpenChange: (open: boolean) => void }) {
  const router = useRouter();
  const start = initialRules ?? DEFAULT;
  const [name, setName] = useState(initialName);
  const [rules, setRules] = useState<SmartRules>(start);
  const [genres, setGenres] = useState(start.genres.join(", "));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof SmartRules>(key: K, value: SmartRules[K]) => setRules((r) => ({ ...r, [key]: value }));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!playlistId && !name.trim()) return setError("Give it a name.");
    setBusy(true);
    setError(null);
    const body: SmartRules = { ...rules, genres: genres.split(",").map((g) => g.trim()).filter(Boolean).slice(0, 10) };
    const res = await fetch(playlistId ? `/api/playlists/${playlistId}` : `/api/servers/${serverId}/playlists`, {
      method: playlistId ? "PATCH" : "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(playlistId ? { smartRules: body } : { name: name.trim(), smartRules: body }),
    });
    const data = (await res.json().catch(() => ({}))) as { id?: string; error?: string };
    setBusy(false);
    if (!res.ok) return setError(typeof data.error === "string" ? data.error : "That didn't work.");
    onOpenChange(false);
    if (playlistId) {
      toast.success("Rules saved.");
      router.refresh();
    } else router.push(`/s/${serverId}/playlists/${data.id}`);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{playlistId ? "Smart playlist rules" : "New smart playlist"}</DialogTitle>
          <DialogDescription>It fills itself from these rules, using your own ratings and what you&apos;ve watched, and keeps up as your library changes.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="flex flex-col gap-4">
          {!playlistId && <Input autoFocus value={name} maxLength={100} onChange={(e) => setName(e.target.value)} placeholder="Name" aria-label="Playlist name" />}
          <div className="grid grid-cols-2 gap-3">
            <Field label="What it holds">
              <select className={SELECT} value={rules.media} onChange={(e) => set("media", e.target.value as SmartRules["media"])}>
                {Object.entries(MEDIA_WORDS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
              </select>
            </Field>
            <Field label="Watched">
              <select className={SELECT} value={rules.watched} onChange={(e) => set("watched", e.target.value as SmartRules["watched"])}>
                {Object.entries(WATCHED_WORDS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </Field>
          </div>
          <Field label="Genres" hint="Any of these, separated by commas (leave empty for all).">
            <Input value={genres} onChange={(e) => setGenres(e.target.value)} placeholder="Comedy, Drama" aria-label="Genres" />
          </Field>
          <div className="grid grid-cols-3 gap-3">
            <Field label="My rating at least">
              <select className={SELECT} value={rules.minStars ?? ""} onChange={(e) => set("minStars", num(e.target.value))}>
                <option value="">Any</option>
                {STAR_CHOICES.map((h) => <option key={h} value={h}>{starsText(h)} ★</option>)}
              </select>
            </Field>
            <Field label="At most">
              <select className={SELECT} value={rules.maxStars ?? ""} onChange={(e) => set("maxStars", num(e.target.value))}>
                <option value="">Any</option>
                {STAR_CHOICES.map((h) => <option key={h} value={h}>{starsText(h)} ★</option>)}
              </select>
            </Field>
            <Field label="Rated by me">
              <select className={SELECT} value={rules.rated} onChange={(e) => set("rated", e.target.value as SmartRules["rated"])}>
                <option value="any">Either</option>
                <option value="rated">Rated</option>
                <option value="unrated">Not rated</option>
              </select>
            </Field>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <Field label="Year from">
              <Input inputMode="numeric" value={rules.yearFrom ?? ""} onChange={(e) => set("yearFrom", num(e.target.value))} placeholder="1990" aria-label="Year from" />
            </Field>
            <Field label="Year to">
              <Input inputMode="numeric" value={rules.yearTo ?? ""} onChange={(e) => set("yearTo", num(e.target.value))} placeholder="1999" aria-label="Year to" />
            </Field>
            <Field label="Added in last (days)">
              <Input inputMode="numeric" value={rules.addedWithinDays ?? ""} onChange={(e) => set("addedWithinDays", num(e.target.value))} placeholder="Any" aria-label="Added in the last days" />
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Order">
              <select className={SELECT} value={rules.sort} onChange={(e) => set("sort", e.target.value as SmartRules["sort"])}>
                {Object.entries(SORT_WORDS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </Field>
            <Field label="Up to">
              <Input inputMode="numeric" value={rules.limit} onChange={(e) => set("limit", Math.min(SMART_MAX_LIMIT, Math.max(1, num(e.target.value) ?? 50)))} aria-label="How many" />
            </Field>
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={busy} className="gap-2">
              <Sparkles className="size-4" /> {busy ? "Saving…" : playlistId ? "Save rules" : "Create"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** "New smart playlist" on the playlists page. */
export function NewSmartPlaylistButton({ serverId }: { serverId: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="secondary" onClick={() => setOpen(true)} className="gap-2 rounded-xl">
        <Sparkles className="size-4" /> New smart playlist
      </Button>
      {open && <SmartPlaylistDialog serverId={serverId} open onOpenChange={setOpen} />}
    </>
  );
}

/** On a smart playlist's page: its rules in words, with Edit rules and Refresh now for whoever may change it. */
export function SmartPlaylistBar({ serverId, playlistId, name, rules, words, canEdit }: { serverId: string; playlistId: string; name: string; rules: SmartRules | null; words: string; canEdit: boolean }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  async function refresh() {
    setBusy(true);
    const res = await fetch(`/api/playlists/${playlistId}/refresh`, { method: "POST" });
    setBusy(false);
    if (!res.ok) return void toast.error("Couldn't refresh it.");
    router.refresh();
  }
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-2xl bg-white/[0.04] px-4 py-3 text-sm ring-1 ring-white/[0.08]">
      <Sparkles className="size-4 shrink-0 text-primary" aria-hidden />
      <p className="min-w-0 flex-1 text-muted-foreground"><span className="font-medium text-foreground">Smart playlist.</span> {words}</p>
      {canEdit && (
        <div className="flex gap-2">
          <Button variant="secondary" size="sm" disabled={busy} onClick={() => void refresh()}>{busy ? "Refreshing…" : "Refresh now"}</Button>
          <Button variant="secondary" size="sm" onClick={() => setEditing(true)}>Edit rules</Button>
        </div>
      )}
      {editing && <SmartPlaylistDialog serverId={serverId} playlistId={playlistId} initialName={name} initialRules={rules} open onOpenChange={setEditing} />}
    </div>
  );
}
