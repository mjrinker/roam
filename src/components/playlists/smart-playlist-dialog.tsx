"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronDown, Plus, Sparkles, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import type { SmartRules } from "@/lib/playlists/smart";
import { activeConditions, CLEARED, CONDITIONS, MEDIA_WORDS, SMART_MAX_LIMIT, SORT_WORDS, WATCHED_WORDS, type Condition } from "@/lib/playlists/smart-words";
import { starsText } from "@/lib/ratings/stars";

const DEFAULT: SmartRules = { media: "movies", genres: [], minStars: null, maxStars: null, rated: "any", watched: "any", yearFrom: null, yearTo: null, addedWithinDays: null, minMinutes: null, maxMinutes: null, libraryId: null, sort: "title", limit: 50 };
const SELECT = "h-9 w-full min-w-0 rounded-lg bg-white/[0.06] px-2 text-sm ring-1 ring-white/[0.1] focus:outline-none focus:ring-2 focus:ring-primary";
const STAR_CHOICES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const num = (v: string): number | null => (v.trim() === "" || Number.isNaN(Number(v)) ? null : Math.trunc(Number(v)));

function Row({ label, onRemove, children }: { label: string; onRemove: () => void; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2 rounded-xl bg-white/[0.04] p-3 ring-1 ring-white/[0.08]">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium">{label}</span>
        <button type="button" onClick={onRemove} aria-label={`Remove the ${label.toLowerCase()} condition`} className="flex size-7 cursor-pointer items-center justify-center rounded-full text-muted-foreground transition hover:bg-white/10 hover:text-foreground">
          <X className="size-4" />
        </button>
      </div>
      {children}
    </div>
  );
}

/** A small word beside a control ("at least", "to"), so the controls need no labels of their own that could wrap. */
const Word = ({ children }: { children: React.ReactNode }) => <span className="shrink-0 text-xs text-muted-foreground">{children}</span>;

/** A short labelled setting: the label sits above its control and stays on one line. */
function Setting({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="truncate text-sm font-medium">{label}</span>
      {children}
    </div>
  );
}

/** Genres as a menu of ticks, with what is ticked shown on the button. */
function GenrePicker({ choices, value, onChange }: { choices: string[]; value: string[]; onChange: (genres: string[]) => void }) {
  const all = [...new Set([...choices, ...value])].sort((a, b) => a.localeCompare(b));
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<button type="button" aria-label="Genres" className="flex h-9 w-full min-w-0 cursor-pointer items-center justify-between gap-2 rounded-lg bg-white/[0.06] px-3 text-left text-sm ring-1 ring-white/[0.1] focus:outline-none focus-visible:ring-2 focus-visible:ring-primary" />}>
        <span className="truncate">{value.length === 0 ? "Choose genres…" : value.join(", ")}</span>
        <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-72 min-w-56 overflow-y-auto">
        {all.length === 0 && <DropdownMenuItem disabled>No genres yet</DropdownMenuItem>}
        {all.map((g) => (
          <DropdownMenuCheckboxItem key={g} checked={value.includes(g)} closeOnClick={false} onCheckedChange={(on) => onChange(on ? [...value, g].slice(0, 10) : value.filter((x) => x !== g))}>
            <span className="truncate">{g}</span>
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Make a smart playlist (or change one's rules): say what it holds, then add the conditions you want with the + button. */
export function SmartPlaylistDialog({ serverId, playlistId, initialName = "", initialRules, genres, open, onOpenChange }: { serverId: string; playlistId?: string; initialName?: string; initialRules?: SmartRules | null; genres: string[]; open: boolean; onOpenChange: (open: boolean) => void }) {
  const router = useRouter();
  const start = initialRules ?? DEFAULT;
  const [name, setName] = useState(initialName);
  const [rules, setRules] = useState<SmartRules>(start);
  const [shown, setShown] = useState<Condition[]>(activeConditions(start));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (patch: Partial<SmartRules>) => setRules((r) => ({ ...r, ...patch }));
  const offered = CONDITIONS.filter((c) => !shown.includes(c.key) && !(c.key === "duration" && rules.media === "shows"));
  // A new condition starts with a sensible choice, so what the row shows is what it does.
  const add = (key: Condition) => {
    setShown((s) => [...s, key]);
    if (key === "watched") set({ watched: "unwatched" });
  };
  const remove = (key: Condition) => {
    setShown((s) => s.filter((k) => k !== key));
    set(CLEARED[key]);
  };

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!playlistId && !name.trim()) return setError("Give it a name.");
    setBusy(true);
    setError(null);
    // Conditions that were taken away are already cleared; a duration means nothing for a show.
    const body: SmartRules = rules.media === "shows" ? { ...rules, minMinutes: null, maxMinutes: null } : rules;
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
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Setting label="Holds">
              <select aria-label="What it holds" className={SELECT} value={rules.media} onChange={(e) => set({ media: e.target.value as SmartRules["media"], ...(e.target.value === "shows" ? { minMinutes: null, maxMinutes: null } : {}) })}>
                {Object.entries(MEDIA_WORDS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
              </select>
            </Setting>
            <Setting label="Order">
              <select aria-label="Order" className={SELECT} value={rules.sort} onChange={(e) => set({ sort: e.target.value as SmartRules["sort"] })}>
                {Object.entries(SORT_WORDS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </Setting>
            <Setting label="Up to">
              <Input inputMode="numeric" value={rules.limit} onChange={(e) => set({ limit: Math.min(SMART_MAX_LIMIT, Math.max(1, num(e.target.value) ?? 50)) })} aria-label="How many" />
            </Setting>
          </div>

          {shown.length === 0 ? (
            <p className="rounded-xl bg-white/[0.03] px-3 py-3 text-sm text-muted-foreground ring-1 ring-white/[0.06]">No conditions: it holds every one. Add a condition to narrow it down.</p>
          ) : (
            <div className="flex flex-col gap-2">
              {shown.includes("watched") && (
                <Row label="Watched" onRemove={() => remove("watched")}>
                  <select aria-label="Watched" className={SELECT} value={rules.watched} onChange={(e) => set({ watched: e.target.value as SmartRules["watched"] })}>
                    {Object.entries(WATCHED_WORDS).filter(([k]) => k !== "any").map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                  </select>
                </Row>
              )}
              {shown.includes("genres") && (
                <Row label="Genres" onRemove={() => remove("genres")}>
                  <GenrePicker choices={genres} value={rules.genres} onChange={(g) => set({ genres: g })} />
                  <Word>Any of the ones ticked.</Word>
                </Row>
              )}
              {shown.includes("rating") && (
                <Row label="My rating" onRemove={() => remove("rating")}>
                  <div className="flex items-center gap-2">
                    <Word>At least</Word>
                    <select aria-label="Rated at least" className={SELECT} value={rules.minStars ?? ""} onChange={(e) => set({ minStars: num(e.target.value) })}>
                      <option value="">Any</option>
                      {STAR_CHOICES.map((h) => <option key={h} value={h}>{starsText(h)} ★</option>)}
                    </select>
                    <Word>to</Word>
                    <select aria-label="Rated at most" className={SELECT} value={rules.maxStars ?? ""} onChange={(e) => set({ maxStars: num(e.target.value) })}>
                      <option value="">Any</option>
                      {STAR_CHOICES.map((h) => <option key={h} value={h}>{starsText(h)} ★</option>)}
                    </select>
                  </div>
                  <select aria-label="Rated by me" className={SELECT} value={rules.rated} onChange={(e) => set({ rated: e.target.value as SmartRules["rated"] })}>
                    <option value="any">Rated or not</option>
                    <option value="rated">Only ones I&apos;ve rated</option>
                    <option value="unrated">Only ones I haven&apos;t rated</option>
                  </select>
                </Row>
              )}
              {shown.includes("years") && (
                <Row label="Release year" onRemove={() => remove("years")}>
                  <div className="flex items-center gap-2">
                    <Word>From</Word>
                    <Input inputMode="numeric" value={rules.yearFrom ?? ""} onChange={(e) => set({ yearFrom: num(e.target.value) })} placeholder="1990" aria-label="Year from" />
                    <Word>to</Word>
                    <Input inputMode="numeric" value={rules.yearTo ?? ""} onChange={(e) => set({ yearTo: num(e.target.value) })} placeholder="1999" aria-label="Year to" />
                  </div>
                </Row>
              )}
              {shown.includes("added") && (
                <Row label="Added recently" onRemove={() => remove("added")}>
                  <div className="flex items-center gap-2">
                    <Word>In the last</Word>
                    <Input inputMode="numeric" value={rules.addedWithinDays ?? ""} onChange={(e) => set({ addedWithinDays: num(e.target.value) })} placeholder="30" aria-label="Added in the last days" />
                    <Word>days</Word>
                  </div>
                </Row>
              )}
              {shown.includes("duration") && (
                <Row label="Duration" onRemove={() => remove("duration")}>
                  <div className="flex items-center gap-2">
                    <Word>From</Word>
                    <Input inputMode="numeric" value={rules.minMinutes ?? ""} onChange={(e) => set({ minMinutes: num(e.target.value) })} placeholder="0" aria-label="Shortest, in minutes" />
                    <Word>to</Word>
                    <Input inputMode="numeric" value={rules.maxMinutes ?? ""} onChange={(e) => set({ maxMinutes: num(e.target.value) })} placeholder="120" aria-label="Longest, in minutes" />
                    <Word>min</Word>
                  </div>
                </Row>
              )}
            </div>
          )}

          <DropdownMenu>
            <DropdownMenuTrigger render={<Button type="button" variant="secondary" disabled={offered.length === 0} className="w-fit gap-2" />}>
              <Plus className="size-4" /> Add a condition
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="min-w-48">
              {offered.map((c) => (
                <DropdownMenuItem key={c.key} onClick={() => add(c.key)}>
                  {c.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

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
export function NewSmartPlaylistButton({ serverId, genres }: { serverId: string; genres: string[] }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="secondary" onClick={() => setOpen(true)} className="gap-2 rounded-xl">
        <Sparkles className="size-4" /> <span className="hidden sm:inline">New smart playlist</span><span className="sm:hidden">Smart</span>
      </Button>
      {open && <SmartPlaylistDialog serverId={serverId} genres={genres} open onOpenChange={setOpen} />}
    </>
  );
}

/** On a smart playlist's page: its rules in words, with Edit rules and Refresh now for whoever may change it. */
export function SmartPlaylistBar({ serverId, playlistId, name, rules, words, canEdit, genres }: { serverId: string; playlistId: string; name: string; rules: SmartRules | null; words: string; canEdit: boolean; genres: string[] }) {
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
      <p className="min-w-0 flex-1 basis-56 text-muted-foreground"><span className="font-medium text-foreground">Smart playlist.</span> {words}</p>
      {canEdit && (
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" size="sm" disabled={busy} onClick={() => void refresh()}>{busy ? "Refreshing…" : "Refresh now"}</Button>
          <Button variant="secondary" size="sm" onClick={() => setEditing(true)}>Edit rules</Button>
        </div>
      )}
      {editing && <SmartPlaylistDialog serverId={serverId} playlistId={playlistId} initialName={name} initialRules={rules} genres={genres} open onOpenChange={setEditing} />}
    </div>
  );
}
