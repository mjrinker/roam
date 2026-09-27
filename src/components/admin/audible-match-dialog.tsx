"use client";

import { useEffect, useState, useTransition } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Headphones } from "lucide-react";
import { formatRuntime } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { AudibleSearchResultDto } from "@/app/api/audiobooks/search/route";

type SearchOutcome = { ok: true; results: AudibleSearchResultDto[] } | { ok: false; error: string };

async function searchAudibleFor(titleId: string, q: string, author: string | null): Promise<SearchOutcome> {
  const params = new URLSearchParams({ titleId, q });
  if (author) params.set("author", author);
  const res = await fetch(`/api/audiobooks/search?${params}`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    return { ok: false, error: typeof body.error === "string" ? body.error : "Search failed." };
  }
  return { ok: true, results: (await res.json()).results };
}

/** Admin picker for pinning an audiobook to the right Audible book. Searches Audible, applies the chosen ASIN. */
export function AudibleMatchDialog({
  titleId,
  titleName,
  author,
  open,
  onOpenChange,
  onMatched,
}: {
  titleId: string;
  titleName: string;
  author: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onMatched: () => void;
}) {
  const [query, setQuery] = useState(titleName);
  const [results, setResults] = useState<AudibleSearchResultDto[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [applying, setApplying] = useState<string | null>(null);

  // Start with a search for the book's own name and author. State is only
  // set after the fetch resolves, so an unmount mid-request can't update it.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    searchAudibleFor(titleId, titleName, author).then((outcome) => {
      if (cancelled) return;
      if (outcome.ok) setResults(outcome.results);
      else {
        setResults([]);
        toast.error(outcome.error);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [open, titleId, titleName, author]);

  async function search(q: string) {
    setSearching(true);
    const outcome = await searchAudibleFor(titleId, q, author);
    setSearching(false);
    if (outcome.ok) setResults(outcome.results);
    else toast.error(outcome.error);
  }

  async function apply(asin: string) {
    setApplying(asin);
    const res = await fetch(`/api/titles/${titleId}/match-audible`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ asin }),
    });
    setApplying(null);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      toast.error(typeof body.error === "string" ? body.error : "Couldn't apply that match.");
      return;
    }
    toast.success(`Matched "${titleName}".`);
    onOpenChange(false);
    onMatched();
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Match &quot;{titleName}&quot; on Audible</DialogTitle>
          <DialogDescription>
            Search Audible and pick the right book. Its cover, narrators, description and series are used
            {author ? `; the folder says the author is ${author}` : ""}.
          </DialogDescription>
        </DialogHeader>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            void search(query);
          }}
          className="flex gap-2"
        >
          <Input value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search Audible" />
          <Button type="submit" disabled={searching || !query.trim()}>
            {searching ? "Searching…" : "Search"}
          </Button>
        </form>

        <div className="flex max-h-96 flex-col gap-1 overflow-y-auto">
          {results?.map((r) => (
            <button
              key={r.asin}
              type="button"
              disabled={applying !== null}
              onClick={() => apply(r.asin)}
              className="flex items-center gap-3 rounded-lg p-2 text-left transition-colors hover:bg-muted disabled:opacity-50"
            >
              <span className="relative size-14 shrink-0 overflow-hidden rounded bg-muted">
                {r.imageUrl ? (
                  <Image src={r.imageUrl} alt="" fill sizes="56px" className="object-cover" />
                ) : (
                  <span className="flex h-full items-center justify-center text-muted-foreground">
                    <Headphones className="size-5" />
                  </span>
                )}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium">{r.title}</span>
                <span className="block truncate text-xs text-muted-foreground">
                  {r.authors.join(", ")}
                  {r.narrators.length > 0 && ` · read by ${r.narrators.join(", ")}`}
                </span>
                <span className="block text-xs text-muted-foreground">
                  {[
                    r.releaseYear,
                    r.runtimeMinutes ? formatRuntime(r.runtimeMinutes * 60) : null,
                    r.seriesName && (r.seriesPosition ? `${r.seriesName} #${r.seriesPosition}` : r.seriesName),
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </span>
              {applying === r.asin && <span className="text-xs text-muted-foreground">Applying…</span>}
            </button>
          ))}
          {results?.length === 0 && !searching && (
            <p className="px-2 py-6 text-center text-xs text-muted-foreground">
              No results. Try a shorter title or a different spelling.
            </p>
          )}
          {results === null && (
            <p className="px-2 py-6 text-center text-xs text-muted-foreground">Searching Audible…</p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Admin button that opens the Audible match picker for one book (used on the book page). */
export function AudibleMatchButton({
  titleId,
  titleName,
  author,
}: {
  titleId: string;
  titleName: string;
  author: string | null;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [, startTransition] = useTransition();

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        Match on Audible
      </Button>
      {open && (
        <AudibleMatchDialog
          titleId={titleId}
          titleName={titleName}
          author={author}
          open={open}
          onOpenChange={setOpen}
          // A soft refresh, so audio that is playing isn't interrupted.
          onMatched={() => startTransition(() => router.refresh())}
        />
      )}
    </>
  );
}
