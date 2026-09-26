"use client";

import { useMemo, useState } from "react";
import { ArrowDownAZ, Search, X } from "lucide-react";
import { PosterCard, type PosterCardData } from "@/components/library/poster-card";
import { cn } from "@/lib/utils";

export interface LibraryBrowserItem extends PosterCardData {
  addedAtMs: number;
}

type SortKey = "title" | "year" | "added";

const SORT_LABELS: Record<SortKey, string> = {
  title: "Title (A–Z)",
  year: "Year (newest)",
  added: "Recently added",
};

function letterFor(name: string): string {
  const first = name.trim().charAt(0).toUpperCase();
  return /[A-Z]/.test(first) ? first : "#";
}

/** Client-side filter + sort + A–Z jump rail over one library's (already fully loaded) titles. */
export function LibraryBrowser({
  items,
  serverId,
}: {
  items: LibraryBrowserItem[];
  serverId: string;
}) {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortKey>("title");

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = q ? items.filter((i) => i.name.toLowerCase().includes(q)) : items;
    const sorted = [...filtered];
    if (sort === "title") sorted.sort((a, b) => a.name.localeCompare(b.name));
    else if (sort === "year") sorted.sort((a, b) => (b.year ?? 0) - (a.year ?? 0));
    else sorted.sort((a, b) => b.addedAtMs - a.addedAtMs);
    return sorted;
  }, [items, query, sort]);

  const showRail = sort === "title" && !query.trim() && visible.length > 40;
  const letters = useMemo(() => {
    const seen = new Set<string>();
    for (const i of visible) seen.add(letterFor(i.name));
    return [...seen];
  }, [visible]);
  const firstIndexForLetter = useMemo(() => {
    const map = new Map<string, string>();
    for (const i of visible) {
      const l = letterFor(i.name);
      if (!map.has(l)) map.set(l, i.id);
    }
    return map;
  }, [visible]);

  function jumpTo(letter: string) {
    const id = firstIndexForLetter.get(letter);
    if (!id) return;
    document
      .getElementById(`card-${id}`)
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative w-full sm:w-72">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter this library"
            aria-label="Filter this library"
            className="h-10 w-full rounded-xl bg-white/[0.06] pr-9 pl-9 text-sm ring-1 ring-white/[0.08] transition placeholder:text-muted-foreground focus:bg-white/[0.09] focus:ring-2 focus:ring-primary/60 focus:outline-none"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery("")}
              aria-label="Clear filter"
              className="absolute top-1/2 right-2.5 -translate-y-1/2 rounded-full p-1 text-muted-foreground hover:bg-white/10 hover:text-foreground"
            >
              <X className="size-3.5" />
            </button>
          )}
        </div>

        <label className="relative flex items-center">
          <ArrowDownAZ className="pointer-events-none absolute left-3 size-4 text-muted-foreground" />
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as SortKey)}
            aria-label="Sort"
            className="h-10 cursor-pointer appearance-none rounded-xl bg-white/[0.06] pr-8 pl-9 text-sm ring-1 ring-white/[0.08] transition hover:bg-white/[0.09] focus:ring-2 focus:ring-primary/60 focus:outline-none"
          >
            {(Object.keys(SORT_LABELS) as SortKey[]).map((k) => (
              <option key={k} value={k} className="bg-popover">
                {SORT_LABELS[k]}
              </option>
            ))}
          </select>
        </label>

        <span className="ml-auto text-sm text-muted-foreground tabular-nums">
          {visible.length === items.length
            ? `${items.length.toLocaleString()} title${items.length === 1 ? "" : "s"}`
            : `${visible.length.toLocaleString()} of ${items.length.toLocaleString()}`}
        </span>
      </div>

      <div className="flex items-start gap-3">
        {visible.length === 0 ? (
          <p className="w-full py-20 text-center text-sm text-muted-foreground">
            Nothing matches &ldquo;{query.trim()}&rdquo;.
          </p>
        ) : (
          <div className="grid min-w-0 flex-1 grid-cols-[repeat(auto-fill,minmax(9.25rem,1fr))] gap-x-4 gap-y-8 sm:grid-cols-[repeat(auto-fill,minmax(10.5rem,1fr))]">
            {visible.map((t) => (
              <div key={t.id} id={`card-${t.id}`} className="scroll-mt-24">
                <PosterCard title={t} serverId={serverId} />
              </div>
            ))}
          </div>
        )}

        {showRail && (
          <nav
            aria-label="Jump to letter"
            className="sticky top-24 hidden shrink-0 flex-col items-center gap-0.5 rounded-full bg-white/[0.04] px-1 py-2 ring-1 ring-white/[0.06] lg:flex"
          >
            {letters.map((l) => (
              <button
                key={l}
                type="button"
                onClick={() => jumpTo(l)}
                className={cn(
                  "size-5 rounded-full text-[10px] font-semibold text-muted-foreground transition-colors hover:bg-primary hover:text-primary-foreground"
                )}
              >
                {l}
              </button>
            ))}
          </nav>
        )}
      </div>
    </div>
  );
}
