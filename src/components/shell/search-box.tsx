"use client";

import { useEffect, useRef, useState } from "react";
import { Artwork as Image } from "@/components/ui/artwork";
import { useRouter } from "next/navigation";
import { Film, Headphones, Loader2, Search, Tv } from "lucide-react";
import { cn } from "@/lib/utils";
import type { SearchResultDto } from "@/app/api/search/route";

const DEBOUNCE_MS = 200;

/** Top-bar title search across the whole server — press "/" anywhere to focus it. */
export function SearchBox({ serverId }: { serverId: string }) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  // Results are tagged with the query they answer, so "loading" is simply
  // "the box has text whose answer hasn't arrived yet" — derived, not stored.
  const [settled, setSettled] = useState<{ q: string; items: SearchResultDto[] }>({
    q: "",
    items: [],
  });
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const trimmed = query.trim();
  const results = settled.items;
  const loading = trimmed !== "" && trimmed !== settled.q;

  // Debounced fetch. The `cancelled` guard stops a slow earlier query from
  // overwriting the results of a newer one.
  useEffect(() => {
    if (!trimmed) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      let items: SearchResultDto[] = [];
      try {
        const res = await fetch(
          `/api/search?serverId=${serverId}&q=${encodeURIComponent(trimmed)}`
        );
        if (res.ok) items = (await res.json()).results ?? [];
      } catch {
        // fall through with no results
      }
      if (cancelled) return;
      setSettled({ q: trimmed, items });
      setActive(0);
    }, DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [trimmed, serverId]);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (e.key === "/" && tag !== "INPUT" && tag !== "TEXTAREA") {
        e.preventDefault();
        inputRef.current?.focus();
      }
    }
    function onPointerDown(e: PointerEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    }
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("pointerdown", onPointerDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("pointerdown", onPointerDown);
    };
  }, []);

  function go(result: SearchResultDto) {
    setOpen(false);
    setQuery("");
    inputRef.current?.blur();
    router.push(
      result.kind === "show"
        ? `/s/${serverId}/show/${result.id}`
        : result.kind === "audiobook"
          ? `/s/${serverId}/book/${result.id}`
          : `/s/${serverId}/title/${result.id}`
    );
  }

  function onInputKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      setOpen(false);
      inputRef.current?.blur();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter" && results[active]) {
      e.preventDefault();
      go(results[active]);
    }
  }

  const showPanel = open && trimmed.length > 0;

  return (
    <div ref={rootRef} className="relative w-full max-w-md">
      <Search className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-muted-foreground" />
      <input
        ref={inputRef}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onInputKeyDown}
        placeholder="Search titles"
        aria-label="Search"
        className="h-10 w-full rounded-full bg-white/[0.06] pr-12 pl-10 text-sm text-foreground ring-1 ring-white/[0.08] transition placeholder:text-muted-foreground focus:bg-white/[0.09] focus:ring-2 focus:ring-primary/60 focus:outline-none"
      />
      <span className="absolute top-1/2 right-3.5 -translate-y-1/2">
        {loading ? (
          <Loader2 className="size-4 animate-spin text-muted-foreground" />
        ) : (
          <kbd className="hidden rounded border border-white/15 px-1.5 py-0.5 text-[10px] text-muted-foreground sm:inline">
            /
          </kbd>
        )}
      </span>

      {showPanel && (
        <div className="absolute top-full right-0 left-0 z-50 mt-2 overflow-hidden rounded-xl bg-popover shadow-2xl ring-1 ring-white/10">
          {results.length === 0 && !loading ? (
            <p className="px-4 py-6 text-center text-sm text-muted-foreground">
              No results for &ldquo;{trimmed}&rdquo;
            </p>
          ) : (
            <ul role="listbox" className="max-h-[70vh] overflow-y-auto p-1.5">
              {results.map((r, i) => (
                <li key={r.id} role="option" aria-selected={i === active}>
                  <button
                    type="button"
                    onClick={() => go(r)}
                    onMouseEnter={() => setActive(i)}
                    className={cn(
                      "flex w-full items-center gap-3 rounded-lg p-2 text-left transition-colors",
                      i === active ? "bg-white/[0.08]" : "hover:bg-white/[0.05]"
                    )}
                  >
                    <span className="relative h-14 w-10 shrink-0 overflow-hidden rounded-md bg-muted">
                      {r.posterUrl ? (
                        <Image src={r.posterUrl} alt="" fill sizes="40px" className="object-cover" />
                      ) : (
                        <span className="flex h-full items-center justify-center text-muted-foreground">
                          {r.kind === "show" ? (
                            <Tv className="size-4" />
                          ) : r.kind === "audiobook" ? (
                            <Headphones className="size-4" />
                          ) : (
                            <Film className="size-4" />
                          )}
                        </span>
                      )}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{r.name}</span>
                      <span className="block text-xs text-muted-foreground">
                        {r.kind === "show" ? "TV Show" : r.kind === "audiobook" ? "Audiobook" : "Movie"}
                        {r.subtitle ? ` · ${r.subtitle}` : r.year ? ` · ${r.year}` : ""}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
