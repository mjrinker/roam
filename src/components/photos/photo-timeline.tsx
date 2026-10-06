"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { PhotoTile } from "@/components/photos/photo-tile";
import { PhotoScrubber } from "@/components/photos/photo-scrubber";
import { groupItems, ZOOM_LEVELS, groupKey, type ZoomLevel } from "@/lib/photos/months";
import type { TimelineItem } from "@/lib/photos/timeline";

/**
 * A photo library's timeline: newest first, grouped by month, loading the next page as you near the
 * end. The first page arrives with the page (so it paints at once); the rest comes from the timeline
 * API, which applies the same visibility rules.
 */
export function PhotoTimeline({
  serverId,
  libraryId,
  initialItems,
  initialNext,
  q = "",
  view = "timeline",
  emptyTitle = "No photos yet",
  emptyHint = "Photos and videos appear here once the first scan finishes.",
}: {
  serverId: string;
  libraryId: string;
  initialItems: TimelineItem[];
  initialNext: string | null;
  /** The search in effect (the page already narrowed the first page; more pages and the scrubber keep it). */
  q?: string;
  /** "favorites" lists only the profile's hearted items (same API, same visibility rules). */
  view?: "timeline" | "favorites";
  emptyTitle?: string;
  emptyHint?: string;
}) {
  const [items, setItems] = useState(initialItems);
  const [next, setNext] = useState(initialNext);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const inFlight = useRef(false);
  const storeKey = `roam:photos:${libraryId}:${view}:${q}`;
  const extraQuery = `${view === "favorites" ? "&view=favorites" : ""}${q ? `&q=${encodeURIComponent(q)}` : ""}`;
  const [zoom, setZoom] = useState<ZoomLevel>("month");
  const [months, setMonths] = useState<string[]>([]);
  // Set after a jump with the scrubber: the items are then a slice from that month on, not the start.
  const [jumped, setJumped] = useState<string | null>(null);
  const jumpToken = useRef(0);

  // Coming back from the viewer: restore the pages already loaded and the scroll position, if the
  // timeline still starts with the same photo (else it changed, and starting afresh is right).
  // Done after hydration so the first render always matches the server's.
  /* eslint-disable react-hooks/set-state-in-effect -- reading browser storage can only happen after hydration; that is the point */
  useEffect(() => {
    try {
      const z = localStorage.getItem("roam:photos:zoom");
      if (z === "day" || z === "month" || z === "year") setZoom(z);
    } catch {
      /* storage unavailable */
    }
    try {
      const saved = JSON.parse(sessionStorage.getItem(storeKey) ?? "null") as { items: TimelineItem[]; next: string | null; y: number } | null;
      if (!saved || saved.items.length <= initialItems.length || saved.items[0]?.id !== initialItems[0]?.id) return;
      // Hearts changed in the viewer since this list was saved (the viewer records them) win over the saved flags.
      const changed = JSON.parse(sessionStorage.getItem(`roam:photos:fav:${libraryId}`) ?? "{}") as Record<string, boolean>;
      const fresh = saved.items
        .map((i) => (i.id in changed ? { ...i, favorite: changed[i.id] } : i))
        .filter((i) => !(view === "favorites" && changed[i.id] === false));
      setItems(fresh);
      setNext(saved.next);
      requestAnimationFrame(() => window.scrollTo(0, saved.y));
    } catch {
      /* storage unavailable or corrupt: just start from the top */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, on arrival
  }, []);
  /* eslint-enable react-hooks/set-state-in-effect */

  useEffect(() => {
    let timer: number | undefined;
    const save = () => {
      try {
        // Bounded: a huge library keeps only what fits comfortably.
        if (!jumped && items.length <= 5000) sessionStorage.setItem(storeKey, JSON.stringify({ items, next, y: window.scrollY }));
      } catch {
        /* quota or private mode: losing the place is fine */
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
  }, [items, next, storeKey, jumped]);
  const sentinel = useRef<HTMLDivElement | null>(null);

  const loadMore = useCallback(async () => {
    if (!next || inFlight.current) return;
    inFlight.current = true;
    const token = jumpToken.current; // if the user jumps meanwhile, this answer is for a place they have left
    setLoading(true);
    setFailed(false);
    try {
      const res = await fetch(`/api/libraries/${libraryId}/photos?after=${encodeURIComponent(next)}${extraQuery}`, { credentials: "same-origin" });
      if (!res.ok) throw new Error(String(res.status));
      const body = (await res.json()) as { items: TimelineItem[]; next: string | null };
      if (token !== jumpToken.current) return;
      setItems((current) => {
        const have = new Set(current.map((i) => i.id));
        return [...current, ...body.items.filter((i) => !have.has(i.id))];
      });
      setNext(body.next);
    } catch {
      setFailed(true);
    } finally {
      inFlight.current = false;
      setLoading(false);
    }
  }, [libraryId, next, extraQuery]);

  // The scrubber's months: fetched once per library, view and search.
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/libraries/${libraryId}/photos/months?${extraQuery.replace(/^&/, "")}`, { credentials: "same-origin" })
      .then((r) => (r.ok ? r.json() : null))
      .then((body: { months: { key: string }[] } | null) => {
        if (!cancelled && body) setMonths(body.months.map((m) => m.key));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [libraryId, extraQuery]);

  const jump = useCallback(
    async (key: string) => {
      const token = ++jumpToken.current; // a later jump wins; an earlier answer arriving late is dropped
      try {
        const res = await fetch(`/api/libraries/${libraryId}/photos?month=${encodeURIComponent(key)}${extraQuery}`, { credentials: "same-origin" });
        if (!res.ok || token !== jumpToken.current) return;
        const body = (await res.json()) as { items: TimelineItem[]; next: string | null };
        if (token !== jumpToken.current) return;
        inFlight.current = false;
        setLoading(false);
        setItems(body.items);
        setNext(body.next);
        setJumped(key);
        setFailed(false);
        window.scrollTo({ top: 0 });
      } catch {
        /* the scrubber just doesn't move; the timeline is unchanged */
      }
    },
    [libraryId, extraQuery]
  );

  const backToLatest = () => {
    jumpToken.current++;
    inFlight.current = false;
    setLoading(false);
    setItems(initialItems);
    setNext(initialNext);
    setJumped(null);
    window.scrollTo({ top: 0 });
  };

  const chooseZoom = (level: ZoomLevel) => {
    setZoom(level);
    try {
      localStorage.setItem("roam:photos:zoom", level);
    } catch {
      /* fine */
    }
  };

  useEffect(() => {
    const el = sentinel.current;
    if (!el || !next || failed) return;
    const observer = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && void loadMore(), { rootMargin: "600px 0px" });
    observer.observe(el);
    return () => observer.disconnect();
  }, [loadMore, next, failed]);

  if (items.length === 0) {
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

  const groups = groupItems(items, zoom);
  const currentMonth = items[0] ? groupKey(items[0].takenAt, "month") : null;
  const dense = { day: "grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6", month: "grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-8", year: "grid-cols-5 sm:grid-cols-7 md:grid-cols-9 lg:grid-cols-11 xl:grid-cols-14" }[zoom];
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
      {groups.map((group, g) => (
        <section key={group.key} aria-label={group.label} style={{ contentVisibility: "auto", containIntrinsicSize: `auto ${{ day: 260, month: 600, year: 800 }[zoom]}px` }}>
          <h2 className="sticky top-16 z-10 -mx-1 mb-3 bg-background/85 px-1 py-2 text-sm font-semibold tracking-tight text-muted-foreground backdrop-blur">{group.label}</h2>
          <ul className={`grid gap-1 ${dense}`}>
            {group.items.map((item, i) => (
              <li key={item.id} className="min-w-0">
                <PhotoTile serverId={serverId} item={item} from={view === "favorites" ? "from=favorites" : "from=timeline"} priority={g === 0 && i < 12} />
              </li>
            ))}
          </ul>
        </section>
      ))}
      <PhotoScrubber keys={months} onJump={(key) => void jump(key)} current={currentMonth} />
      {jumped && (
        <button type="button" onClick={backToLatest} className="fixed bottom-6 left-1/2 z-20 -translate-x-1/2 rounded-full bg-primary px-5 py-2 text-sm font-medium text-primary-foreground shadow-lg">
          Back to latest
        </button>
      )}
      <div ref={sentinel} aria-hidden className="h-px" />
      <div role="status" aria-live="polite" className="flex min-h-10 items-center justify-center text-sm text-muted-foreground">
        {loading && "Loading more…"}
        {failed && (
          <button type="button" onClick={() => void loadMore()} className="rounded-lg bg-white/[0.06] px-4 py-2 ring-1 ring-white/[0.08] hover:bg-white/[0.09]">
            Couldn&apos;t load more. Try again
          </button>
        )}
        {!next && !loading && !failed && "That's everything."}
      </div>
    </div>
  );
}
