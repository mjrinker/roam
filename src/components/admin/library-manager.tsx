"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import type { LibraryStatusDto } from "@/app/api/libraries/[id]/status/route";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { FolderBrowser } from "@/components/admin/folder-browser";
import type { LibraryAccess, LibraryKind } from "@/lib/db/schema";
import { LibraryAccessDialog } from "@/components/admin/library-access-dialog";
import { AUDIBLE_REGIONS } from "@/lib/audible/client";
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
  boxFolderId: string;
  audibleRegion: string;
  lastScannedAt: string | null;
  lastScan: LastScanInfo | null;
}

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
    <label className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
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
    toast.success("Rating updated for every video in this library.");
  }

  return (
    <label className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
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
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>
          {status.scanning ? "Scanning… " : ""}
          {status.titleCount.toLocaleString()} title{status.titleCount === 1 ? "" : "s"}
          {" · "}
          {done.toLocaleString()} / {shownTotal.toLocaleString()}{" "}
          {folders ? "folders scanned" : "files processed"}
          {!folders && failed > 0 ? ` (${failed} failed)` : ""}
        </span>
        <span>{pct}%</span>
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
          <li key={i} className="text-xs text-destructive/90">
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

export function LibraryManager({
  serverId,
  libraries,
  boxConnected,
}: {
  serverId: string;
  libraries: LibraryRow[];
  boxConnected: boolean;
}) {
  const router = useRouter();
  const [scanningId, setScanningId] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(libraries.length === 0);
  const [accessFor, setAccessFor] = useState<string | null>(null);
  // Access changes made in this session, so the badge updates without a refresh.
  const [access, setAccess] = useState<Record<string, LibraryAccess>>({});
  const [name, setName] = useState("");
  const [kind, setKind] = useState<LibraryKind>("movies");
  // Video libraries are rated as a whole; unrated until the admin says otherwise (the cautious default).
  const [rating, setRating] = useState<VideoRating>(null);
  const [selectedFolder, setSelectedFolder] = useState<{ id: string; name: string } | null>(
    null
  );
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
      body: JSON.stringify({ serverId, name, kind, boxFolderId: selectedFolder.id, ...(kind === "video" ? { rating } : {}) }),
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
          <Button variant="outline" size="sm" onClick={() => setShowForm((s) => !s)}>
            {showForm ? "Cancel" : "Add library"}
          </Button>
        )}
      </div>

      {!boxConnected && (
        <p className="text-sm text-muted-foreground">
          Connect Box above before adding a library.
        </p>
      )}

      {showForm && boxConnected && (
        <Card>
          <form onSubmit={createLibrary}>
            <CardHeader>
              <CardTitle className="text-base">New library</CardTitle>
              <CardDescription>
                Browse your connected Box account and pick the folder to share.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
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
                </select>
                {kind === "video" && (
                  <p className="text-xs text-muted-foreground">
                    Any videos in folders, named from the files themselves (no online lookups). Plays .mp4, .m4v and .mov.
                  </p>
                )}
              </div>
              {kind === "video" && (
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
                    Applies to every video in the library. Profiles with an age limit only see it if the rating fits.
                  </p>
                </div>
              )}
              <div className="grid gap-1.5">
                <Label>Box folder</Label>
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
                  <FolderBrowser serverId={serverId} onSelect={setSelectedFolder} />
                )}
              </div>
            </CardContent>
            <CardFooter>
              <Button type="submit" disabled={creating || isPending || !selectedFolder}>
                Create library
              </Button>
            </CardFooter>
          </form>
        </Card>
      )}

      <div className="flex flex-col gap-3">
        {libraries.map((lib) => (
          <Card key={lib.id}>
            <CardContent className="py-4">
              <div className="flex items-center justify-between">
                <div>
                  <div className="flex items-center gap-2">
                    <p className="font-medium">{lib.name}</p>
                    <Badge variant="secondary">{lib.kind}</Badge>
                    <Badge variant={(access[lib.id] ?? lib.access) === "restricted" ? "outline" : "secondary"}>
                      {(access[lib.id] ?? lib.access) === "restricted" ? "Restricted" : "Everyone"}
                    </Badge>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    last scanned{" "}
                    {lib.lastScannedAt
                      ? new Date(lib.lastScannedAt).toLocaleString()
                      : "never"}
                    {lib.lastScan && (
                      <>
                        {" "}
                        ({lib.lastScan.trigger}) &middot; {lib.lastScan.filesSeen} folder(s)
                        seen, {lib.lastScan.titlesAdded} new
                      </>
                    )}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                <Button variant="secondary" size="sm" onClick={() => setAccessFor(lib.id)}>
                  Access
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={scanningId === lib.id || statusById[lib.id]?.scanning || !boxConnected}
                  onClick={() => rescan(lib.id)}
                >
                  {scanningId === lib.id || statusById[lib.id]?.scanning ? "Scanning…" : "Rescan"}
                </Button>
                </div>
              </div>
              {accessFor === lib.id && (
                <LibraryAccessDialog
                  libraryId={lib.id}
                  libraryName={lib.name}
                  open
                  onOpenChange={(o) => !o && setAccessFor(null)}
                  onSaved={(next) => setAccess((cur) => ({ ...cur, [lib.id]: next }))}
                />
              )}
              {lib.kind === "audiobooks" && <AudibleRegionSelect libraryId={lib.id} initial={lib.audibleRegion} />}
              {lib.kind === "video" && <VideoRatingSelect libraryId={lib.id} initial={agesToRating(lib.ratingAges)} />}
              {statusById[lib.id] && <ScanProgress status={statusById[lib.id]} />}
              {lib.lastScan && <ScanErrors errors={lib.lastScan.errors} />}
            </CardContent>
          </Card>
        ))}
      </div>
    </section>
  );
}
