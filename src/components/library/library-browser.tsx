"use client";

import { useMemo, useState } from "react";
import { ArrowDown, ArrowUp, ArrowUpDown, Check, Search, SlidersHorizontal, X } from "lucide-react";
import { PosterCard, type PosterCardData } from "@/components/library/poster-card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Slider } from "@/components/ui/slider";
import {
  DEFAULT_DIRECTION,
  EMPTY_FILTERS,
  UNRATED,
  activeFilterCount,
  applyFilters,
  sortItems,
  type BrowseFilters,
  type BrowseItem,
  type SortDir,
  type SortKey,
} from "@/lib/library/browse";
import { formatRuntime } from "@/lib/format";
import { cn } from "@/lib/utils";

export interface LibraryBrowserItem extends PosterCardData, BrowseItem {}

const SORT_LABELS: Record<SortKey, string> = {
  title: "Title",
  author: "Author",
  year: "Year",
  added: "Date added",
  duration: "Duration",
  contentRating: "Content rating",
  imdb: "IMDb rating",
  rottenTomatoes: "Rotten Tomatoes",
};

function letterFor(name: string): string {
  const first = name.trim().charAt(0).toUpperCase();
  return /[A-Z]/.test(first) ? first : "#";
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "rounded-full px-3 py-1 text-xs font-medium ring-1 transition-colors",
        active
          ? "bg-primary/15 text-primary ring-primary/50"
          : "bg-white/[0.06] text-muted-foreground ring-white/[0.08] hover:bg-white/[0.1] hover:text-foreground"
      )}
    >
      {children}
    </button>
  );
}

function FilterGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <span className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{label}</span>
      {children}
    </div>
  );
}

function toggled(set: ReadonlySet<string>, value: string): Set<string> {
  const next = new Set(set);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

/** Client-side search + filters + sort + A–Z jump rail over one library's (already fully loaded) titles. */
export function LibraryBrowser({
  items,
  serverId,
  isAdmin = false,
}: {
  items: LibraryBrowserItem[];
  serverId: string;
  isAdmin?: boolean;
}) {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortKey>("title");
  const [dir, setDir] = useState<SortDir>("asc");
  const [filters, setFilters] = useState<BrowseFilters>(EMPTY_FILTERS);
  const [panelOpen, setPanelOpen] = useState(false);
  // Author sorting only makes sense for libraries whose items carry an author line.
  const hasAuthors = useMemo(() => items.some((i) => i.kind === "audiobook" && i.subtitle), [items]);

  const facets = useMemo(() => {
    const genreCounts = new Map<string, number>();
    const certAges = new Map<string, number>();
    let hasUnrated = false;
    let minSec = Infinity;
    let maxSec = 0;
    let withRuntime = 0;
    for (const i of items) {
      for (const g of i.genres) genreCounts.set(g, (genreCounts.get(g) ?? 0) + 1);
      if (i.certification) {
        certAges.set(i.certification, Math.min(certAges.get(i.certification) ?? Infinity, i.ratingAge ?? 99));
      } else hasUnrated = true;
      if (i.runtimeSeconds) {
        withRuntime++;
        minSec = Math.min(minSec, i.runtimeSeconds);
        maxSec = Math.max(maxSec, i.runtimeSeconds);
      }
    }
    const step = maxSec > 300 * 60 ? 15 : 5;
    const lo = withRuntime > 1 ? Math.floor(minSec / 60 / step) * step : 0;
    const hi = withRuntime > 1 ? Math.ceil(maxSec / 60 / step) * step : 0;
    const certs = [...certAges.entries()].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0])).map(([c]) => c);
    return {
      genres: [...genreCounts.keys()].sort((a, b) => a.localeCompare(b)),
      certifications: certs.length > 0 && hasUnrated ? [...certs, UNRATED] : certs,
      duration: hi > lo ? { lo, hi, step } : null,
      hasAudioFix: isAdmin && items.some((i) => i.needsAudioFix),
    };
  }, [items, isAdmin]);

  const filtersActive = activeFilterCount(filters);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const searched = q
      ? items.filter((i) => i.name.toLowerCase().includes(q) || i.subtitle?.toLowerCase().includes(q))
      : items;
    return sortItems(applyFilters(searched, filters), sort, dir);
  }, [items, query, filters, sort, dir]);

  function chooseSort(key: SortKey) {
    if (key === sort) setDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSort(key);
      setDir(DEFAULT_DIRECTION[key]);
    }
  }

  const durationRange: [number, number] | null = facets.duration
    ? [
        filters.minSeconds !== null ? filters.minSeconds / 60 : facets.duration.lo,
        filters.maxSeconds !== null ? filters.maxSeconds / 60 : facets.duration.hi,
      ]
    : null;

  function setDuration(lo: number, hi: number) {
    if (!facets.duration) return;
    setFilters((f) => ({
      ...f,
      minSeconds: lo > facets.duration!.lo ? lo * 60 : null,
      maxSeconds: hi < facets.duration!.hi ? hi * 60 : null,
    }));
  }

  const showRail = sort === "title" && !query.trim() && !filtersActive && visible.length > 40;
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

        <DropdownMenu>
          <DropdownMenuTrigger
            aria-label="Sort"
            className="flex h-10 cursor-pointer items-center gap-2 rounded-xl bg-white/[0.06] px-3 text-sm ring-1 ring-white/[0.08] transition outline-none hover:bg-white/[0.09] focus-visible:ring-2 focus-visible:ring-primary/60"
          >
            <ArrowUpDown className="size-4 text-muted-foreground" />
            {SORT_LABELS[sort]}
            {dir === "asc" ? <ArrowUp className="size-3.5 text-primary" /> : <ArrowDown className="size-3.5 text-primary" />}
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-52">
            {(Object.keys(SORT_LABELS) as SortKey[])
              .filter((k) => k !== "author" || hasAuthors)
              .map((k) => (
                <DropdownMenuItem
                  key={k}
                  closeOnClick={k !== sort}
                  onClick={() => chooseSort(k)}
                  className="justify-between gap-3"
                >
                  <span className="flex items-center gap-2">
                    <Check className={cn("size-4", k === sort ? "text-primary" : "invisible")} />
                    {SORT_LABELS[k]}
                  </span>
                  {k === sort &&
                    (dir === "asc" ? (
                      <ArrowUp className="size-3.5 text-muted-foreground" />
                    ) : (
                      <ArrowDown className="size-3.5 text-muted-foreground" />
                    ))}
                </DropdownMenuItem>
              ))}
          </DropdownMenuContent>
        </DropdownMenu>

        <button
          type="button"
          aria-expanded={panelOpen}
          onClick={() => setPanelOpen((o) => !o)}
          className={cn(
            "flex h-10 items-center gap-2 rounded-xl px-3 text-sm ring-1 transition",
            panelOpen || filtersActive
              ? "bg-primary/15 text-primary ring-primary/40"
              : "bg-white/[0.06] ring-white/[0.08] hover:bg-white/[0.09]"
          )}
        >
          <SlidersHorizontal className="size-4" />
          Filters
          {filtersActive > 0 && (
            <span className="flex size-5 items-center justify-center rounded-full bg-primary text-[11px] font-semibold text-primary-foreground">
              {filtersActive}
            </span>
          )}
        </button>

        <span className="ml-auto text-sm text-muted-foreground tabular-nums">
          {visible.length === items.length
            ? `${items.length.toLocaleString()} title${items.length === 1 ? "" : "s"}`
            : `${visible.length.toLocaleString()} of ${items.length.toLocaleString()}`}
        </span>
      </div>

      {panelOpen && (
        <div className="flex flex-col gap-5 rounded-2xl bg-white/[0.04] p-4 ring-1 ring-white/[0.06]">
          {facets.genres.length > 0 && (
            <FilterGroup label="Genre">
              <div className="flex flex-wrap gap-1.5">
                {facets.genres.map((g) => (
                  <Chip
                    key={g}
                    active={filters.genres.has(g)}
                    onClick={() => setFilters((f) => ({ ...f, genres: toggled(f.genres, g) }))}
                  >
                    {g}
                  </Chip>
                ))}
              </div>
            </FilterGroup>
          )}

          {facets.certifications.length > 0 && (
            <FilterGroup label="Content rating">
              <div className="flex flex-wrap gap-1.5">
                {facets.certifications.map((c) => (
                  <Chip
                    key={c}
                    active={filters.certifications.has(c)}
                    onClick={() => setFilters((f) => ({ ...f, certifications: toggled(f.certifications, c) }))}
                  >
                    {c}
                  </Chip>
                ))}
              </div>
            </FilterGroup>
          )}

          {facets.duration && durationRange && (
            <FilterGroup label="Duration">
              <div className="flex max-w-md flex-col gap-3">
                <Slider
                  aria-label="Duration range"
                  min={facets.duration.lo}
                  max={facets.duration.hi}
                  step={facets.duration.step}
                  value={durationRange}
                  onValueChange={(v) => {
                    if (Array.isArray(v) && v.length === 2) setDuration(v[0], v[1]);
                  }}
                />
                <div className="flex justify-between text-xs text-muted-foreground tabular-nums">
                  <span>{formatRuntime(durationRange[0] * 60) ?? "0m"}</span>
                  <span>{formatRuntime(durationRange[1] * 60)}</span>
                </div>
              </div>
            </FilterGroup>
          )}

          {facets.hasAudioFix && (
            <FilterGroup label="Admin">
              <div className="flex flex-wrap gap-1.5">
                <Chip
                  active={filters.audioNeedsFix}
                  onClick={() => setFilters((f) => ({ ...f, audioNeedsFix: !f.audioNeedsFix }))}
                >
                  Audio needs to be fixed
                </Chip>
              </div>
            </FilterGroup>
          )}

          {filtersActive > 0 && (
            <button
              type="button"
              onClick={() => setFilters(EMPTY_FILTERS)}
              className="self-start text-xs font-medium text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            >
              Clear all filters
            </button>
          )}
        </div>
      )}

      <div className="flex items-start gap-3">
        {visible.length === 0 ? (
          <div className="flex w-full flex-col items-center gap-3 py-20 text-center text-sm text-muted-foreground">
            <p>{query.trim() ? <>Nothing matches &ldquo;{query.trim()}&rdquo;.</> : "Nothing matches these filters."}</p>
            {filtersActive > 0 && (
              <button
                type="button"
                onClick={() => setFilters(EMPTY_FILTERS)}
                className="font-medium text-primary hover:underline"
              >
                Clear filters
              </button>
            )}
          </div>
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
