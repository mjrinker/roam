"use client";

import { useState, useTransition } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import type { TmdbSearchResultDto } from "@/app/api/tmdb/search/route";
import type { TitleKind } from "@/lib/db/schema";

export interface UnmatchedTitleRow {
  id: string;
  name: string;
  year: number | null;
  kind: TitleKind;
  metadataStatus: "pending" | "not_found";
}

function MatchDialog({
  title,
  open,
  onOpenChange,
  onMatched,
}: {
  title: UnmatchedTitleRow;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onMatched: () => void;
}) {
  const [query, setQuery] = useState(title.name);
  const [results, setResults] = useState<TmdbSearchResultDto[]>([]);
  const [searching, setSearching] = useState(false);
  const [applyingId, setApplyingId] = useState<number | null>(null);

  async function search(e: React.FormEvent) {
    e.preventDefault();
    setSearching(true);
    const res = await fetch(
      `/api/tmdb/search?q=${encodeURIComponent(query)}&kind=${title.kind}`
    );
    setSearching(false);
    if (!res.ok) {
      toast.error("Search failed.");
      return;
    }
    const body = await res.json();
    setResults(body.results);
  }

  async function applyMatch(tmdbId: number) {
    setApplyingId(tmdbId);
    const res = await fetch(`/api/titles/${title.id}/match`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tmdbId }),
    });
    setApplyingId(null);
    if (!res.ok) {
      toast.error("Couldn't apply that match.");
      return;
    }
    toast.success(`Matched "${title.name}".`);
    onOpenChange(false);
    onMatched();
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Fix match for &quot;{title.name}&quot;</DialogTitle>
          <DialogDescription>
            Search TMDB and pick the correct {title.kind === "movie" ? "movie" : "show"}.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={search} className="flex gap-2">
          <Input value={query} onChange={(e) => setQuery(e.target.value)} />
          <Button type="submit" disabled={searching}>
            {searching ? "Searching…" : "Search"}
          </Button>
        </form>

        <div className="flex max-h-80 flex-col gap-2 overflow-y-auto">
          {results.map((r) => (
            <button
              key={r.tmdbId}
              type="button"
              disabled={applyingId !== null}
              onClick={() => applyMatch(r.tmdbId)}
              className="flex items-center gap-3 rounded-md p-2 text-left hover:bg-muted disabled:opacity-50"
            >
              <div className="relative h-16 w-11 shrink-0 overflow-hidden rounded bg-muted">
                {r.posterUrl && (
                  <Image src={r.posterUrl} alt="" fill className="object-cover" />
                )}
              </div>
              <div>
                <p className="text-sm font-medium">{r.name}</p>
                {r.year && <p className="text-xs text-muted-foreground">{r.year}</p>}
              </div>
              {applyingId === r.tmdbId && (
                <span className="ml-auto text-xs text-muted-foreground">Applying…</span>
              )}
            </button>
          ))}
          {results.length === 0 && !searching && (
            <p className="px-2 py-4 text-center text-xs text-muted-foreground">
              No results yet — try a search above.
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function UnmatchedTitles({ titles }: { titles: UnmatchedTitleRow[] }) {
  const router = useRouter();
  const [activeId, setActiveId] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  if (titles.length === 0) return null;
  const active = titles.find((t) => t.id === activeId) ?? null;

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-lg font-semibold">Unmatched titles</h2>
      <p className="text-sm text-muted-foreground">
        These didn&apos;t get automatic TMDB metadata — usually because the folder
        name doesn&apos;t match TMDB&apos;s title closely enough. Fix them manually below.
      </p>
      <div className="flex flex-col divide-y divide-border rounded-md border">
        {titles.map((t) => (
          <div key={t.id} className="flex items-center justify-between px-3 py-2">
            <div className="flex items-center gap-2">
              <span className="text-sm">{t.name}</span>
              {t.year && <span className="text-xs text-muted-foreground">({t.year})</span>}
              <Badge variant={t.metadataStatus === "not_found" ? "destructive" : "secondary"}>
                {t.metadataStatus === "not_found" ? "not found" : "pending"}
              </Badge>
            </div>
            <Button variant="outline" size="sm" onClick={() => setActiveId(t.id)}>
              Fix match
            </Button>
          </div>
        ))}
      </div>

      {active && (
        <MatchDialog
          title={active}
          open={activeId !== null}
          onOpenChange={(open) => !open && setActiveId(null)}
          onMatched={() => startTransition(() => router.refresh())}
        />
      )}
    </section>
  );
}
