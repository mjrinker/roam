"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { PhotoScrubber } from "@/components/photos/photo-scrubber";
import { PhotoTile } from "@/components/photos/photo-tile";
import { PhotoViewer } from "@/components/photos/photo-viewer";
import {
  BLOCK_GAP,
  blockHeight,
  groupKey,
  groupLabel,
  gridColumns,
  HEADING_GAP,
  HEADING_HEIGHT,
  ZOOM_LEVELS,
  type ZoomLevel,
} from "@/lib/photos/months";
import type { MonthBucket, TimelineItem } from "@/lib/photos/timeline";
import { viewerItem } from "@/lib/photos/viewer-item";

interface Loaded {
  items: TimelineItem[];
  complete: boolean;
}

const MAX_CONCURRENT = 3;
/** A block is read in pages of 500 until complete; this many pages is far more than any real day, month or year holds. */
const MAX_PAGES = 20;

/**
 * A photo library's timeline. The whole library is laid out up front: every day, month or year (by the zoom
 * level) is a block of exactly the height its photo count needs, and a block fills with its photos as it nears
 * the screen. So scrolling or scrubbing anywhere is just scrolling: nothing is ever inserted above you and
 * nothing is swapped under you as photos arrive. Opening a photo puts the viewer OVER the timeline, which
 * stays exactly where it was, so closing is instant; stepping between photos uses what is already loaded.
 */
export function PhotoTimeline({
  serverId,
  libraryId,
  initialItems,
  initialBuckets,
  q = "",
  view = "timeline",
  words,
  emptyTitle = "No photos yet",
  emptyHint = "Photos and videos appear here once the first scan finishes.",
}: {
  serverId: string;
  libraryId: string;
  /** The newest photos, so the page paints at once. */
  initialItems: TimelineItem[];
  /** The library's months and how many photos each holds (the blocks of the month level). */
  initialBuckets: MonthBucket[];
  /** The search in effect (the page already narrowed the first photos; blocks and the scrubber keep it). */
  q?: string;
  /** "favorites" lists only the profile's hearted items (same API, same visibility rules). */
  view?: "timeline" | "favorites";
  /** The favorite spelling for this profile ("Add to favorites" / "Add to favourites"). */
  words: { add: string; remove: string };
  emptyTitle?: string;
  emptyHint?: string;
}) {
  const extraQuery = `${view === "favorites" ? "&view=favorites" : ""}${q ? `&q=${encodeURIComponent(q)}` : ""}`;
  const storeKey = `roam:photos:scroll:${libraryId}:${view}:${q}`;

  const [zoom, setZoom] = useState<ZoomLevel>("month");
  const [buckets, setBuckets] = useState<MonthBucket[]>(initialBuckets);
  const [bucketsLevel, setBucketsLevel] = useState<ZoomLevel>("month");
  const [months] = useState(() => initialBuckets.map((b) => b.key));
  // The first photos arrive with the page; a block they only partly fill is completed when it comes into view.
  const [loaded, setLoaded] = useState<Record<string, Loaded>>(() => {
    const seeded: Record<string, Loaded> = {};
    for (const item of initialItems) {
      const key = groupKey(item.takenAt, "month");
      (seeded[key] ??= { items: [], complete: false }).items.push(item);
    }
    for (const [key, entry] of Object.entries(seeded)) entry.complete = entry.items.length >= (initialBuckets.find((b) => b.key === key)?.count ?? Infinity);
    return seeded;
  });
  const [layout, setLayout] = useState<{ width: number; viewport: number } | null>(null);
  const [currentMonth, setCurrentMonth] = useState<string | null>(null);
  const [openId, setOpenId] = useState<{ id: string; key: string } | null>(null);

  const listRef = useRef<HTMLDivElement | null>(null);
  const visible = useRef(new Set<string>());
  const inFlight = useRef(new Set<string>());
  const generation = useRef(0); // bumped when the blocks change (zoom): answers for the old blocks are dropped
  const pumpRef = useRef<() => void>(() => undefined);
  const loadedRef = useRef(loaded);
  useEffect(() => {
    loadedRef.current = loaded;
  }, [loaded]);

  // ── Measuring: exact block heights need the list's width and how many tiles fit across ──
  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const measure = () => setLayout({ width: el.clientWidth, viewport: window.innerWidth });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, []);

  // ── The zoom level (remembered per browser), read after hydration so the first render matches the server's ──
  /* eslint-disable react-hooks/set-state-in-effect -- reading browser storage can only happen after hydration; that is the point */
  useEffect(() => {
    try {
      const z = localStorage.getItem("roam:photos:zoom");
      if (z === "day" || z === "month" || z === "year") setZoom(z);
    } catch {
      /* storage unavailable */
    }
  }, []);
  /* eslint-enable react-hooks/set-state-in-effect */

  // Another level means other blocks: fetch their counts, and start with none of them loaded.
  useEffect(() => {
    if (zoom === bucketsLevel) return;
    const gen = ++generation.current;
    inFlight.current.clear();
    let cancelled = false;
    fetch(`/api/libraries/${libraryId}/photos/months?level=${zoom}${extraQuery}`, { credentials: "same-origin" })
      .then((r) => (r.ok ? r.json() : null))
      .then((body: { months: MonthBucket[] } | null) => {
        if (cancelled || !body || gen !== generation.current) return;
        setLoaded({});
        setBuckets(body.months);
        setBucketsLevel(zoom);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [zoom, bucketsLevel, libraryId, extraQuery]);

  // ── Filling blocks ──
  const fillBlock = useCallback(
    async (key: string) => {
      const gen = generation.current;
      inFlight.current.add(key);
      try {
        let items: TimelineItem[] = [];
        let after: string | null = null;
        for (let page = 0; page < MAX_PAGES; page++) {
          const res: Response = await fetch(
            `/api/libraries/${libraryId}/photos?level=${bucketsLevel}&bucket=${encodeURIComponent(key)}${after ? `&after=${encodeURIComponent(after)}` : ""}${extraQuery}`,
            { credentials: "same-origin" }
          );
          if (!res.ok) throw new Error(String(res.status));
          const body = (await res.json()) as { items: TimelineItem[]; next: string | null };
          if (gen !== generation.current) return;
          const have = new Set(items.map((i) => i.id));
          items = [...items, ...body.items.filter((i) => !have.has(i.id))];
          after = body.next;
          setLoaded((current) => ({ ...current, [key]: { items, complete: !after } }));
          if (!after) break;
        }
      } catch {
        /* left empty; it is tried again the next time it comes into view */
      } finally {
        inFlight.current.delete(key);
        pumpRef.current(); // a slot is free: start the next visible block
      }
    },
    [libraryId, bucketsLevel, extraQuery]
  );

  const pump = useCallback(() => {
    if (inFlight.current.size >= MAX_CONCURRENT) return;
    for (const key of visible.current) {
      if (inFlight.current.size >= MAX_CONCURRENT) break;
      if (inFlight.current.has(key) || loadedRef.current[key]?.complete) continue;
      void fillBlock(key);
    }
  }, [fillBlock]);
  useEffect(() => {
    pumpRef.current = pump;
  }, [pump]);

  // Watch the blocks: those near the screen (a page and a half either way) are the ones to fill.
  useEffect(() => {
    const root = listRef.current;
    if (!root || !layout) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const key = (e.target as HTMLElement).dataset.bucket;
          if (!key) continue;
          if (e.isIntersecting) visible.current.add(key);
          else visible.current.delete(key);
        }
        pump();
      },
      { rootMargin: "1500px 0px" }
    );
    root.querySelectorAll("[data-bucket]").forEach((el) => observer.observe(el));
    const seen = visible.current;
    return () => {
      observer.disconnect();
      seen.clear();
    };
  }, [layout, buckets, pump]);

  // ── Staying put: remember the scroll position for a return to this page, and restore it once the blocks have their heights ──
  const restored = useRef(false);
  useEffect(() => {
    if (!layout || restored.current) return;
    restored.current = true;
    try {
      const y = Number(sessionStorage.getItem(storeKey));
      if (y > 0) requestAnimationFrame(() => window.scrollTo(0, y));
    } catch {
      /* fine */
    }
  }, [layout, storeKey]);
  useEffect(() => {
    let timer: number | undefined;
    const save = () => {
      try {
        sessionStorage.setItem(storeKey, String(Math.round(window.scrollY)));
      } catch {
        /* fine */
      }
    };
    const onScroll = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(save, 200);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("pagehide", save);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("pagehide", save);
      save();
    };
  }, [storeKey]);

  // Which month is at the top of the screen, for the scrubber (one lookup per frame while scrolling).
  useEffect(() => {
    let frame = 0;
    const update = () => {
      frame = 0;
      const el = document.elementFromPoint(Math.min(window.innerWidth - 60, 80), 150)?.closest("[data-bucket]");
      const key = el?.getAttribute("data-bucket");
      if (key) setCurrentMonth(months.find((m) => m === key || m.startsWith(key)) ?? null);
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [months]);

  // Going to a month is just scrolling to its block (blocks above and below already have their heights), instantly:
  // a long animated scroll would load every block it passed.
  const jump = useCallback((monthKey: string) => {
    const root = listRef.current;
    if (!root) return;
    const target =
      root.querySelector(`[data-bucket="${monthKey}"]`) ??
      (monthKey === "undated" ? null : root.querySelector(`[data-bucket^="${monthKey}"]`)) ??
      root.querySelector(`[data-bucket="${monthKey.slice(0, 4)}"]`);
    target?.scrollIntoView({ block: "start" });
  }, []);

  const chooseZoom = (level: ZoomLevel) => {
    setZoom(level);
    try {
      localStorage.setItem("roam:photos:zoom", level);
    } catch {
      /* fine */
    }
  };

  // ── The viewer overlay ──
  // The photos the viewer can step through: the opened block and the loaded blocks joined to it. A block that
  // isn't loaded ends the run (and is requested), so "next" never skips over photos that haven't arrived.
  const run = useMemo(() => {
    if (!openId) return null;
    const at = buckets.findIndex((b) => b.key === openId.key);
    if (at < 0) return null;
    let from = at;
    let to = at;
    while (from > 0 && loaded[buckets[from - 1].key]?.complete) from--;
    while (to < buckets.length - 1 && loaded[buckets[to + 1].key]?.complete) to++;
    const items = buckets.slice(from, to + 1).flatMap((b) => loaded[b.key]?.items ?? []);
    return { items, before: from > 0 ? buckets[from - 1].key : null, after: to < buckets.length - 1 ? buckets[to + 1].key : null };
  }, [openId, buckets, loaded]);
  const openIndex = run && openId ? run.items.findIndex((i) => i.id === openId.id) : -1;

  // Near either end of the run, fetch the block beyond it.
  useEffect(() => {
    if (!run || openIndex < 0) return;
    if (openIndex >= run.items.length - 4 && run.after && !loadedRef.current[run.after]?.complete && !inFlight.current.has(run.after)) void fillBlock(run.after);
    if (openIndex <= 3 && run.before && !loadedRef.current[run.before]?.complete && !inFlight.current.has(run.before)) void fillBlock(run.before);
  }, [run, openIndex, fillBlock]);

  const open = useCallback(
    (id: string) => {
      const key = Object.entries(loadedRef.current).find(([, b]) => b.items.some((i) => i.id === id))?.[0];
      if (!key) return;
      // One history entry for the viewer, so the browser's Back (or a swipe from the edge) closes it.
      window.history.pushState({ roamViewer: true }, "", window.location.href);
      setOpenId({ id, key });
    },
    []
  );
  // Closing. Un-hearting while in the Favorites view removes the item now, not under your finger while viewing.
  const closed = useCallback(() => {
    setOpenId(null);
    if (view !== "favorites") return;
    setLoaded((current) => Object.fromEntries(Object.entries(current).map(([k, b]) => [k, { ...b, items: b.items.some((i) => !i.favorite) ? b.items.filter((i) => i.favorite) : b.items }])));
    setBuckets((current) => current.map((b) => ({ ...b, count: loadedRef.current[b.key]?.complete ? loadedRef.current[b.key].items.filter((i) => i.favorite).length : b.count })).filter((b) => b.count > 0));
  }, [view]);
  const close = useCallback(() => {
    if (window.history.state?.roamViewer) window.history.back(); // the popstate below closes it
    else closed();
  }, [closed]);
  useEffect(() => {
    if (!openId) return;
    const onPop = () => closed();
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [openId, closed]);

  const step = (offset: number) => {
    const next = run?.items[openIndex + offset];
    if (next && openId) setOpenId({ id: next.id, key: groupKey(next.takenAt, bucketsLevel) });
  };
  const setFavorite = useCallback(
    (id: string, favorite: boolean) => setLoaded((current) => Object.fromEntries(Object.entries(current).map(([k, b]) => [k, { ...b, items: b.items.map((i) => (i.id === id ? { ...i, favorite } : i)) }]))),
    []
  );

  const total = buckets.reduce((n, b) => n + b.count, 0);
  if (total === 0 && Object.keys(loaded).length === 0) {
    if (q) {
      return (
        <div className="mx-auto flex max-w-sm flex-col items-center gap-2 py-24 text-center">
          <p className="text-lg font-medium">Nothing matches &ldquo;{q}&rdquo;</p>
          <p className="text-sm text-muted-foreground">Try part of a file name, or a date like 2024 or March 2024.</p>
        </div>
      );
    }
    return (
      <div className="mx-auto flex max-w-sm flex-col items-center gap-2 py-24 text-center">
        <p className="text-lg font-medium">{emptyTitle}</p>
        <p className="text-sm text-muted-foreground">{emptyHint}</p>
      </div>
    );
  }

  const columnsClass = { day: "grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6", month: "grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-8", year: "grid-cols-5 sm:grid-cols-7 md:grid-cols-9 lg:grid-cols-11 xl:grid-cols-14" }[bucketsLevel];
  const from = view === "favorites" ? "from=favorites" : "from=timeline";
  const viewerItems = run && openIndex >= 0 ? [run.items[openIndex - 1], run.items[openIndex], run.items[openIndex + 1]].map((i) => (i ? viewerItem(i) : null)) : null;
  // Before the width is known (the server's render) only blocks that already have photos are drawn.
  const shown = layout ? buckets : buckets.filter((b) => loaded[b.key]);

  return (
    <div className="flex flex-col gap-6 pr-8">
      <div role="group" aria-label="Zoom" className="flex w-fit gap-1 rounded-xl bg-white/[0.05] p-1 ring-1 ring-white/[0.08]">
        {ZOOM_LEVELS.map((level) => (
          <button
            key={level}
            type="button"
            aria-pressed={zoom === level}
            onClick={() => chooseZoom(level)}
            className={`rounded-lg px-3 py-1 text-xs font-medium capitalize transition ${zoom === level ? "bg-white/[0.12] text-foreground" : "text-muted-foreground hover:text-foreground"}`}
          >
            {level === "day" ? "Days" : level === "month" ? "Months" : "Years"}
          </button>
        ))}
      </div>
      <div ref={listRef} className="flex flex-col" style={{ gap: BLOCK_GAP }}>
        {shown.map((bucket, g) => {
          const block = loaded[bucket.key];
          const count = Math.max(bucket.count, block?.items.length ?? 0);
          const label = bucket.key === "undated" ? "Undated" : groupLabel(`${bucket.key.length === 4 ? `${bucket.key}-01-01` : bucket.key.length === 7 ? `${bucket.key}-01` : bucket.key}T12:00:00Z`, bucketsLevel);
          return (
            <section key={bucket.key} data-bucket={bucket.key} aria-label={label} style={layout ? { height: blockHeight(count, gridColumns(bucketsLevel, layout.viewport), layout.width) } : undefined}>
              <h2 className="sticky top-16 z-10 -mx-1 flex items-center bg-background/85 px-1 text-sm font-semibold tracking-tight text-muted-foreground backdrop-blur" style={{ height: HEADING_HEIGHT, marginBottom: HEADING_GAP }}>
                {label}
              </h2>
              {block ? (
                <ul className={`grid gap-1 ${columnsClass}`}>
                  {block.items.map((item, i) => (
                    <li key={item.id} className="min-w-0">
                      <PhotoTile serverId={serverId} item={item} from={from} priority={g === 0 && i < 12} onOpen={open} />
                    </li>
                  ))}
                </ul>
              ) : (
                // Reserved, not yet filled: a quiet panel the size of the photos to come.
                <div aria-hidden className="h-[calc(100%-48px)] rounded-md bg-white/[0.04]" />
              )}
            </section>
          );
        })}
      </div>
      <PhotoScrubber keys={months} onJump={jump} current={currentMonth} />
      {viewerItems && viewerItems[1] && (
        <PhotoViewer
          current={viewerItems[1]}
          prev={viewerItems[0]}
          next={viewerItems[2]}
          onPrev={() => step(-1)}
          onNext={() => step(1)}
          onClose={close}
          libraryId={libraryId}
          words={words}
          onFavoriteChange={setFavorite}
        />
      )}
    </div>
  );
}
