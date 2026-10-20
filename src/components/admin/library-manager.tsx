"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import type { LibraryStatusDto } from "@/app/api/libraries/[id]/status/route";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { FolderBrowser } from "@/components/admin/folder-browser";
import type { ConnectionSummary } from "@/lib/storage/connections";
import { providerName } from "@/lib/storage/provider-info";
import type { LibraryAccess, LibraryKind } from "@/lib/db/schema";
import { LibraryAccessDialog } from "@/components/admin/library-access-dialog";
import { AUDIBLE_REGIONS } from "@/lib/audible/client";
import { isFileTreeLibraryKind } from "@/lib/libraries/profile";
import { agesToRating, VIDEO_RATING_OPTIONS, type VideoRating } from "@/lib/libraries/video-rating-options";

export interface LastScanInfo {
  trigger: "manual" | "cron" | "webhook" | "resume";
  finishedAt: string | null;
  filesSeen: number;
  titlesAdded: number;
  errors: string[];
}

export interface LibraryRow {
  id: string;
  name: string;
  kind: LibraryKind;
  access: LibraryAccess;
  /** Video libraries: the library-level age rating as {ANY: minimumAge}; null = unrated. */
  ratingAges: Record<string, number> | null;
  /** Video libraries: remove a video once it has left Box. */
  pruneMissing: boolean;
  musicLookup: boolean;
  boxFolderId: string;
  /** Which connection the library's first folder is on, and the folders added to it since. */
  firstFolderConnection: string;
  sources: { id: string; label: string; connection: string }[];
  audibleRegion: string;
  lastScannedAt: string | null;
  lastScan: LastScanInfo | null;
}

const KIND_LABELS: Partial<Record<LibraryKind, string>> = { movies: "Movies", shows: "TV shows", audiobooks: "Audiobooks", video: "Videos", music: "Music", ebooks: "eBooks", audio: "Audio", photos: "Photos" };

const REGION_LABELS: Record<string, string> = {
  us: "United States",
  uk: "United Kingdom",
  ca: "Canada",
  au: "Australia",
  de: "Germany",
  fr: "France",
  it: "Italy",
  es: "Spain",
  in: "India",
  jp: "Japan",
};

/** Which Audible storefront an audiobook library is matched against. */
function AudibleRegionSelect({ libraryId, initial }: { libraryId: string; initial: string }) {
  const [region, setRegion] = useState(initial);

  async function change(next: string) {
    const previous = region;
    setRegion(next);
    const res = await fetch(`/api/libraries/${libraryId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ audibleRegion: next }),
    });
    if (!res.ok) {
      setRegion(previous);
      toast.error("Couldn't change the Audible region.");
      return;
    }
    toast.success("Audible region updated. New matches will use it.");
  }

  return (
    <label className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
      Audible region
      <select
        value={region}
        onChange={(e) => change(e.target.value)}
        className="h-8 rounded-md border border-input bg-transparent px-2 text-xs text-foreground"
      >
        {Object.keys(AUDIBLE_REGIONS).map((code) => (
          <option key={code} value={code} className="bg-popover">
            {REGION_LABELS[code] ?? code}
          </option>
        ))}
      </select>
    </label>
  );
}

const ratingToValue = (r: VideoRating) => (r === null ? "unrated" : String(r));
const valueToRating = (v: string): VideoRating => (v === "unrated" ? null : Number(v));

function RatingOptions() {
  return (
    <>
      {VIDEO_RATING_OPTIONS.map((o) => (
        <option key={ratingToValue(o.value)} value={ratingToValue(o.value)} className="bg-popover">
          {o.label}
        </option>
      ))}
    </>
  );
}

/** A video library's age rating: it applies to every video in it, so changing it re-rates them all. */
function VideoRatingSelect({ libraryId, initial }: { libraryId: string; initial: VideoRating }) {
  const [rating, setRating] = useState(initial);

  async function change(next: VideoRating) {
    const previous = rating;
    setRating(next);
    const res = await fetch(`/api/libraries/${libraryId}/rating`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rating: next }),
    });
    if (!res.ok) {
      setRating(previous);
      toast.error("Couldn't change the rating.");
      return;
    }
    toast.success("Rating updated for everything in this library.");
  }

  return (
    <label className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
      Rating
      <select
        value={ratingToValue(rating)}
        onChange={(e) => change(valueToRating(e.target.value))}
        className="h-8 rounded-md border border-input bg-transparent px-2 text-xs text-foreground"
      >
        <RatingOptions />
      </select>
    </label>
  );
}

/** Whether a video library forgets videos that were deleted from Box (along with their watch history and playlist spots). */
function PruneToggle({ libraryId, initial }: { libraryId: string; initial: boolean }) {
  const [enabled, setEnabled] = useState(initial);

  async function change(next: boolean) {
    const previous = enabled;
    setEnabled(next);
    const res = await fetch(`/api/libraries/${libraryId}/prune`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: next }),
    });
    if (!res.ok) {
      setEnabled(previous);
      toast.error("Couldn't change the setting.");
      return;
    }
    toast.success(next ? "Items deleted from Box will be removed after a scan." : "Items deleted from Box will stay listed.");
  }

  return (
    <label className="mt-2 flex items-start gap-2 text-xs text-muted-foreground">
      <input type="checkbox" className="mt-0.5 size-3.5 shrink-0 accent-[var(--primary)]" checked={enabled} onChange={(e) => change(e.target.checked)} />
      Remove items that were deleted from Box (and their watch history and playlist spots)
    </label>
  );
}

/** Whether a music library looks its albums up on MusicBrainz (sending the artist and album folder names there). */
function MusicLookupToggle({ libraryId, initial }: { libraryId: string; initial: boolean }) {
  const [enabled, setEnabled] = useState(initial);

  async function change(next: boolean) {
    const previous = enabled;
    setEnabled(next);
    const res = await fetch(`/api/libraries/${libraryId}/music-lookup`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: next }),
    });
    if (!res.ok) {
      setEnabled(previous);
      toast.error("Couldn't change the setting.");
      return;
    }
    toast.success(next ? "Albums will be looked up on MusicBrainz on the next scan." : "Nothing about this library will be sent to MusicBrainz.");
  }

  return (
    <label className="mt-2 flex items-start gap-2 text-xs text-muted-foreground">
      <input type="checkbox" className="mt-0.5 size-3.5 shrink-0 accent-[var(--primary)]" checked={enabled} onChange={(e) => change(e.target.checked)} />
      Look up albums on MusicBrainz for titles, years and cover art (sends artist and album folder names)
    </label>
  );
}

const ERRORS_SHOWN = 10;
const STATUS_POLL_MS = 3000;

function ScanProgress({ status }: { status: LibraryStatusDto }) {
  const { pending, ok, failed } = status.probeCounts;
  const total = pending + ok + failed;
  if (total === 0 && !status.scanning) return null;
  const folders = status.folderProgress;
  // While the folder loop runs, show it (starts at 0 on a rescan); the probe
  // counts are already ~100% from earlier scans and would look stuck.
  const done = folders ? folders.done : ok + failed;
  const shownTotal = folders ? folders.total : total;
  const pct = shownTotal > 0 ? Math.round((done / shownTotal) * 100) : 0;

  return (
    <div className="mt-3 flex flex-col gap-1.5">
      <div className="flex items-start justify-between gap-3 text-xs text-muted-foreground">
        <span className="min-w-0">
          {status.scanning ? "Scanning… " : ""}
          {status.titleCount.toLocaleString()} title{status.titleCount === 1 ? "" : "s"}
          {" · "}
          {done.toLocaleString()} / {shownTotal.toLocaleString()}{" "}
          {folders ? "folders scanned" : "files processed"}
          {!folders && failed > 0 ? ` (${failed} failed)` : ""}
        </span>
        <span className="shrink-0">{pct}%</span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div
          className={`h-full rounded-full bg-primary transition-all duration-500 ${
            status.scanning ? "animate-pulse" : ""
          }`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

function ScanErrors({ errors }: { errors: string[] }) {
  const [expanded, setExpanded] = useState(false);
  if (errors.length === 0) return null;

  const shown = expanded ? errors : errors.slice(0, ERRORS_SHOWN);
  return (
    <div className="mt-3 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2">
      <p className="text-xs font-medium text-destructive">
        Last scan had {errors.length} error{errors.length === 1 ? "" : "s"}:
      </p>
      <ul className="mt-1 flex flex-col gap-0.5">
        {shown.map((err, i) => (
          <li key={i} className="text-xs break-words text-destructive/90">
            {err}
          </li>
        ))}
      </ul>
      {errors.length > ERRORS_SHOWN && (
        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          className="mt-1 text-xs underline text-destructive/90"
        >
          {expanded ? "Show fewer" : `Show ${errors.length - ERRORS_SHOWN} more`}
        </button>
      )}
    </div>
  );
}

/** The connections a folder can be picked from: the ones that are signed in. */
function ConnectionSelect({ connections, value, onChange, id }: { connections: ConnectionSummary[]; value: string; onChange: (id: string) => void; id?: string }) {
  if (connections.length < 2) return null;
  return (
    <select id={id} value={value} onChange={(e) => onChange(e.target.value)} className="h-9 rounded-md border border-input bg-transparent px-3 text-sm" aria-label="Storage">
      {connections.map((c) => (
        <option key={c.id} value={c.id} className="bg-popover">
          {c.label} ({providerName(c.provider)})
        </option>
      ))}
    </select>
  );
}

/** A library's folders: the first one, any added, and a way to add more from any connection. */
function LibraryFolders({ serverId, lib, connections }: { serverId: string; lib: LibraryRow; connections: ConnectionSummary[] }) {
  const router = useRouter();
  const [adding, setAdding] = useState(false);
  const [connectionId, setConnectionId] = useState(connections[0]?.id ?? "");
  const connection = connections.find((c) => c.id === connectionId);

  async function add(folder: { id: string; name: string }) {
    const res = await fetch(`/api/libraries/${lib.id}/sources`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ folderId: folder.id, label: folder.name }) });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return toast.error(typeof body.error === "string" ? body.error : "Couldn't add that folder.");
    }
    toast.success(`Added "${folder.name}". Rescan to bring in what's in it.`);
    setAdding(false);
    router.refresh();
  }
  async function remove(sourceId: string, label: string) {
    if (!window.confirm(`Take "${label}" out of ${lib.name}? What was found in it is removed from the library the next time it is scanned; the files themselves are not touched.`)) return;
    const res = await fetch(`/api/libraries/${lib.id}/sources/${sourceId}`, { method: "DELETE" });
    if (!res.ok) return toast.error("Couldn't remove that folder.");
    router.refresh();
  }

  return (
    <div className="mt-3 flex flex-col gap-1.5 text-xs text-muted-foreground">
      <p className="font-medium text-foreground/80">Folders</p>
      <ul className="flex flex-col gap-1">
        <li className="flex flex-wrap items-center gap-x-2">
          <span>Original folder</span>
          <span>· {lib.firstFolderConnection}</span>
        </li>
        {lib.sources.map((s) => (
          <li key={s.id} className="flex flex-wrap items-center gap-x-2">
            <span className="min-w-0 break-words text-foreground/90">{s.label}</span>
            <span>· {s.connection}</span>
            <button type="button" className="underline hover:text-foreground" onClick={() => void remove(s.id, s.label)}>
              Remove
            </button>
          </li>
        ))}
      </ul>
      {connections.length > 0 &&
        (adding ? (
          <div className="mt-1 flex max-w-xl flex-col gap-2">
            <ConnectionSelect connections={connections} value={connectionId} onChange={setConnectionId} />
            <FolderBrowser key={connectionId} serverId={serverId} connectionId={connectionId} rootName={connection?.label} confirmLabel={`Add "{name}" to ${lib.name}`} onSelect={(f) => void add(f)} />
            <button type="button" className="w-fit underline" onClick={() => setAdding(false)}>
              Cancel
            </button>
          </div>
        ) : (
          <button type="button" className="w-fit underline hover:text-foreground" onClick={() => setAdding(true)}>
            Add a folder
          </button>
        ))}
    </div>
  );
}

/** Asks for the library's name before removing it from Roam (the files in storage are never touched). */
function DeleteLibraryDialog({ lib, onClose, onDeleted }: { lib: LibraryRow; onClose: () => void; onDeleted: () => void }) {
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);

  async function remove(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    const res = await fetch(`/api/libraries/${lib.id}`, { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: typed }) });
    setBusy(false);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return toast.error(typeof body.error === "string" ? body.error : "Couldn't delete the library.");
    }
    toast.success(`"${lib.name}" was removed from Roam.`);
    onDeleted();
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={remove} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>Delete &quot;{lib.name}&quot;?</DialogTitle>
            <DialogDescription>
              This removes the library from Roam: everything listed in it, and for that, everyone&apos;s watch history and playlist spots. Your files in storage are not touched, and you can add the folder as a new library again later.
            </DialogDescription>
          </DialogHeader>
          <label className="grid gap-1.5 text-sm">
            Type the library&apos;s name to confirm
            <Input autoFocus value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={lib.name} autoComplete="off" />
          </label>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" variant="destructive" disabled={busy || typed !== lib.name}>
              {busy ? "Deleting…" : "Delete library"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function LibraryManager({
  serverId,
  libraries,
  connections,
}: {
  serverId: string;
  libraries: LibraryRow[];
  /** The server's storage connections that are signed in. */
  connections: ConnectionSummary[];
}) {
  const boxConnected = connections.length > 0; // (the name is from when Box was the only storage)
  const router = useRouter();
  const [scanningId, setScanningId] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  // The library whose settings are open in the dialog.
  const [settingsFor, setSettingsFor] = useState<string | null>(null);
  const [accessFor, setAccessFor] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<LibraryRow | null>(null);
  // Access changes made in this session, so the badge updates without a refresh.
  const [access, setAccess] = useState<Record<string, LibraryAccess>>({});
  const [name, setName] = useState("");
  const [kind, setKind] = useState<LibraryKind>("movies");
  // Video libraries are rated as a whole; unrated until the admin says otherwise (the cautious default).
  const [rating, setRating] = useState<VideoRating>(null);
  const [selectedFolder, setSelectedFolder] = useState<{ id: string; name: string } | null>(
    null
  );
  const [newConnectionId, setNewConnectionId] = useState(connections[0]?.id ?? "");
  const newConnection = connections.find((c) => c.id === newConnectionId);
  const [isPending, startTransition] = useTransition();
  const [creating, setCreating] = useState(false);
  const [statusById, setStatusById] = useState<Record<string, LibraryStatusDto>>({});

  // Poll each library's live status. The Rescan button's own request only
  // resolves once the whole scan finishes, but the DB is updated as the
  // scan goes — so polling separately shows real progress during that
  // wait, and also picks up scans the admin didn't click (auto-resume,
  // cron) that happen to be running when the page is open.
  const libraryIds = libraries.map((l) => l.id).join(",");
  useEffect(() => {
    const ids = libraryIds ? libraryIds.split(",") : [];
    let cancelled = false;

    async function poll() {
      const results = await Promise.all(
        ids.map(async (id) => {
          try {
            const res = await fetch(`/api/libraries/${id}/status`);
            if (!res.ok) return null;
            return [id, (await res.json()) as LibraryStatusDto] as const;
          } catch {
            return null;
          }
        })
      );
      if (cancelled) return;
      setStatusById((prev) => {
        const next = { ...prev };
        for (const r of results) if (r) next[r[0]] = r[1];
        return next;
      });
    }

    poll();
    const interval = setInterval(poll, STATUS_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [libraryIds]);

  async function createLibrary(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedFolder) return;
    setCreating(true);
    const res = await fetch("/api/libraries", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ serverId, name, kind, boxFolderId: selectedFolder.id, ...(isFileTreeLibraryKind(kind) ? { rating } : {}) }),
    });
    setCreating(false);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      toast.error(typeof body.error === "string" ? body.error : "Couldn't create library.");
      return;
    }
    toast.success(`Library "${name}" created.`);
    setName("");
    setSelectedFolder(null);
    setShowForm(false);
    startTransition(() => router.refresh());
  }

  async function rescan(libraryId: string) {
    setScanningId(libraryId);
    const res = await fetch("/api/scan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ serverId, libraryId }),
    });
    setScanningId(null);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      toast.error(body.error ?? "Scan failed to start.");
      return;
    }
    const body = await res.json();
    const result = body.results?.[0];
    if (result?.errors?.length) {
      toast.warning(`Scan finished with ${result.errors.length} error(s) — see details below.`);
    } else if (result?.incomplete) {
      toast.info("Scan is continuing in the background — progress is shown below.");
    } else {
      toast.success(`Scan complete — ${result?.titlesAdded ?? 0} new title(s).`);
    }
    startTransition(() => router.refresh());
  }

  return (
    <section className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Libraries</h2>
        {boxConnected && (
          <Button variant="outline" size="sm" onClick={() => setShowForm(true)}>
            Add library
          </Button>
        )}
      </div>

      {!boxConnected && (
        <p className="text-sm text-muted-foreground">
          Connect some storage first, then add a library.
        </p>
      )}
      {boxConnected && libraries.length === 0 && <p className="text-sm text-muted-foreground">No libraries yet. Add one to share a folder of movies, shows, music or photos.</p>}

      <Dialog open={showForm && boxConnected} onOpenChange={(open) => !open && !creating && setShowForm(open)}>
        <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-lg">
          <form onSubmit={createLibrary} className="grid grid-cols-[minmax(0,1fr)] gap-4">
            <DialogHeader>
              <DialogTitle>New library</DialogTitle>
              <DialogDescription>
                Pick the folder to share. You can add more folders, from any storage, afterwards. Files are found by how they are named:{" "}
                <a href="/help/naming" target="_blank" rel="noreferrer" className="text-primary underline underline-offset-2">
                  see how to name them
                </a>
                .
              </DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-3">
              <div className="grid gap-1.5">
                <Label htmlFor="lib-name">Name</Label>
                <Input
                  id="lib-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Movies"
                  required
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="lib-kind">Kind</Label>
                <select
                  id="lib-kind"
                  className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
                  value={kind}
                  onChange={(e) => setKind(e.target.value as LibraryKind)}
                >
                  <option value="movies">Movies</option>
                  <option value="shows">TV Shows</option>
                  <option value="audiobooks">Audiobooks</option>
                  <option value="video">Other videos</option>
                  <option value="music">Music</option>
                  <option value="ebooks">eBooks</option>
                  <option value="audio">Other audio</option>
                  <option value="photos">Photos and videos</option>
                </select>
                {isFileTreeLibraryKind(kind) && (
                  <p className="text-xs text-muted-foreground">
                    {kind === "ebooks"
                      ? "EPUB and PDF books in folders, named and described from the books themselves (title, author, series, cover), with no online lookups."
                      : kind === "music"
                      ? "Songs in Artist / Album folders (Artist/Album/01 - Song.mp3), grouped from the folders and tagged from the files' own tags. Albums are looked up on MusicBrainz (artist and album names only) for titles, years and cover art. Plays .mp3, .m4a and .m4b."
                      : kind === "audio"
                      ? "Any audio files in folders (podcasts, recordings, lectures), named from the files themselves with no online lookups. Plays .mp3, .m4a and .m4b."
                      : kind === "photos"
                        ? "Photos and videos in folders, shown as a timeline by the date each was taken (read from the photo itself) with your Box folders as albums. No online lookups. Shows .jpg, .png, .webp, .gif and .heic, and plays .mp4, .m4v and .mov."
                        : "Any videos in folders, named from the files themselves (no online lookups). Plays .mp4, .m4v and .mov."}
                  </p>
                )}
              </div>
              {isFileTreeLibraryKind(kind) && (
                <div className="grid gap-1.5">
                  <Label htmlFor="lib-rating">Rating</Label>
                  <select
                    id="lib-rating"
                    className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
                    value={ratingToValue(rating)}
                    onChange={(e) => setRating(valueToRating(e.target.value))}
                  >
                    <RatingOptions />
                  </select>
                  <p className="text-xs text-muted-foreground">
                    Applies to everything in the library. Profiles with an age limit only see it if the rating fits.
                  </p>
                </div>
              )}
              <div className="grid gap-1.5">
                <Label>Folder</Label>
                <ConnectionSelect connections={connections} value={newConnectionId} onChange={(id) => (setNewConnectionId(id), setSelectedFolder(null))} />
                {selectedFolder ? (
                  <div className="flex items-center gap-2 text-sm">
                    <Badge variant="secondary">{selectedFolder.name}</Badge>
                    <button
                      type="button"
                      className="text-xs text-muted-foreground underline"
                      onClick={() => setSelectedFolder(null)}
                    >
                      Change
                    </button>
                  </div>
                ) : (
                  <FolderBrowser key={newConnectionId} serverId={serverId} connectionId={newConnectionId} rootName={newConnection?.label} onSelect={setSelectedFolder} />
                )}
              </div>
            </div>
            <DialogFooter>
              <Button type="submit" disabled={creating || isPending || !selectedFolder}>
                Create library
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <div className="flex flex-col gap-3">
        {libraries.map((lib) => (
          <Card key={lib.id}>
            <CardContent className="py-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                {/* The name takes at least this much room: when the buttons would squeeze it, they wrap onto their own line instead. */}
                <div className="flex min-w-[min(100%,15rem)] flex-1 flex-col gap-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="min-w-0 font-medium break-words">{lib.name}</p>
                    <Badge variant="secondary">{KIND_LABELS[lib.kind] ?? lib.kind}</Badge>
                    <Badge variant={(access[lib.id] ?? lib.access) === "restricted" ? "outline" : "secondary"}>
                      {(access[lib.id] ?? lib.access) === "restricted" ? "Restricted" : "Everyone"}
                    </Badge>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Scanned {lib.lastScannedAt ? new Date(lib.lastScannedAt).toLocaleString() : "never"}
                    {lib.lastScan && <> &middot; {lib.lastScan.titlesAdded} new</>}
                    {" "}&middot; {1 + lib.sources.length} folder{lib.sources.length === 0 ? "" : "s"}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={scanningId === lib.id || statusById[lib.id]?.scanning || !boxConnected}
                    onClick={() => rescan(lib.id)}
                  >
                    {scanningId === lib.id || statusById[lib.id]?.scanning ? "Scanning…" : "Rescan"}
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => setSettingsFor(lib.id)}>
                    Settings
                  </Button>
                </div>
              </div>
              {statusById[lib.id] && <ScanProgress status={statusById[lib.id]} />}
              {lib.lastScan && <ScanErrors errors={lib.lastScan.errors} />}
              {accessFor === lib.id && (
                <LibraryAccessDialog
                  libraryId={lib.id}
                  libraryName={lib.name}
                  open
                  onOpenChange={(o) => !o && setAccessFor(null)}
                  onSaved={(next) => setAccess((cur) => ({ ...cur, [lib.id]: next }))}
                />
              )}
              {settingsFor === lib.id && (
                <Dialog open onOpenChange={(open) => !open && setSettingsFor(null)}>
                  <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-lg">
                    <DialogHeader>
                      <DialogTitle>{lib.name}</DialogTitle>
                      <DialogDescription>Settings for this library.</DialogDescription>
                    </DialogHeader>
                    <div className="flex flex-col gap-1">
                      <div className="flex items-center justify-between gap-3 rounded-lg bg-white/[0.04] px-3 py-2 text-sm">
                        <span>
                          Who can see it
                          <span className="block text-xs text-muted-foreground">{(access[lib.id] ?? lib.access) === "restricted" ? "Only the members you choose" : "Every member of the server"}</span>
                        </span>
                        <Button variant="secondary" size="sm" onClick={() => (setSettingsFor(null), setAccessFor(lib.id))}>
                          Change
                        </Button>
                      </div>
                      <LibraryFolders serverId={serverId} lib={lib} connections={connections} />
                      {lib.kind === "audiobooks" && <AudibleRegionSelect libraryId={lib.id} initial={lib.audibleRegion} />}
                      {isFileTreeLibraryKind(lib.kind) && <VideoRatingSelect libraryId={lib.id} initial={agesToRating(lib.ratingAges)} />}
                      {isFileTreeLibraryKind(lib.kind) && <PruneToggle libraryId={lib.id} initial={lib.pruneMissing} />}
                      {lib.kind === "music" && <MusicLookupToggle libraryId={lib.id} initial={lib.musicLookup} />}
                    </div>
                    <DialogFooter className="sm:justify-start">
                      <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive" onClick={() => (setSettingsFor(null), setDeleting(lib))}>
                        Delete library…
                      </Button>
                    </DialogFooter>
                  </DialogContent>
                </Dialog>
              )}
            </CardContent>
          </Card>
        ))}
      </div>
      {deleting && <DeleteLibraryDialog lib={deleting} onClose={() => setDeleting(null)} onDeleted={() => (setDeleting(null), startTransition(() => router.refresh()))} />}
    </section>
  );
}
