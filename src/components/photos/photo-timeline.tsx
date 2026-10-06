"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { PhotoScrubber } from "@/components/photos/photo-scrubber";
import { PhotoTile } from "@/components/photos/photo-tile";
import { PhotoViewer } from "@/components/photos/photo-viewer";
import { canScrollInPlace, groupItems, groupKey, ZOOM_LEVELS, type ZoomLevel } from "@/lib/photos/months";
import type { TimelineItem } from "@/lib/photos/timeline";
import { viewerItem, type ViewerItem } from "@/lib/photos/viewer-item";

interface Page {
  items: TimelineItem[];
  next: string | null;
  prev?: string | null;
}

/**
 * A photo library's timeline: newest first, grouped by day, month or year, loading older photos as you
 * near the bottom and (after jumping into the middle) newer ones as you near the top. Opening a photo
 * puts the viewer OVER the timeline, which stays exactly where it was, so closing is instant and nothing
 * reloads; stepping between photos uses what is already loaded. The first page arrives with the page; the
 * rest comes from the timeline API, which applies the same visibility rules.
 */
export function PhotoTimeline({
  serverId,
  libraryId,
  initialItems,
  initialNext,
  q = "",
  view = "timeline",
  words,
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
  /** The favorite spelling for this profile ("Add to favorites" / "Add to favourites"). */
  words: { add: string; remove: string };
  emptyTitle?: string;
  emptyHint?: string;
}) {
  const [items, setItems] = useState(initialItems);
  const [next, setNext] = useState(initialNext); // cursor for the next OLDER page
  const [prev, setPrev] = useState<string | null>(null); // cursor for the next NEWER page (set after a jump)
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [zoom, setZoom] = useState<ZoomLevel>("month");
  const [months, setMonths] = useState<string[]>([]);
  const [currentMonth, setCurrentMonth] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [jumping, setJumping] = useState(false);
  const olderInFlight = useRef(false);
  const newerInFlight = useRef(false);
  const generation = useRef(0); // bumped by a jump: answers for the place the user left are dropped
  const anchor = useRef<{ height: number; y: number } | null>(null); // set while prepending, to keep the view still
  const scrollToMonth = useRef<string | null>(null);
  const bottom = useRef<HTMLDivElement | null>(null);
  const top = useRef<HTMLDivElement | null>(null);
  const storeKey = `roam:photos:${libraryId}:${view}:${q}`;
  const extraQuery = `${view === "favorites" ? "&view=favorites" : ""}${q ? `&q=${encodeURIComponent(q)}` : ""}`;

  // ── Coming back from another page: restore what was loaded and where the view was ──
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
      const saved = JSON.parse(sessionStorage.getItem(storeKey) ?? "null") as { items: TimelineItem[]; next: string | null; prev: string | null; y: number; at: number } | null;
      // A list that starts at the top must still start with today's first photo (the library may have changed);
      // one that started part-way (after a jump) is kept for half an hour.
      const fresh = saved && Date.now() - saved.at < 30 * 60_000 && saved.items.length > 0 && (saved.prev !== null || (saved.items[0]?.id === initialItems[0]?.id && saved.items.length > initialItems.length));
      if (!saved || !fresh) return;
      // Hearts changed in the viewer since this list was saved (the viewer records them) win over the saved flags.
      const changed = JSON.parse(sessionStorage.getItem(`roam:photos:fav:${libraryId}`) ?? "{}") as Record<string, boolean>;
      setItems(
        saved.items
          .map((i) => (i.id in changed ? { ...i, favorite: changed[i.id] } : i))
          .filter((i) => !(view === "favorites" && changed[i.id] === false))
      );
      setNext(saved.next);
      setPrev(saved.prev);
      requestAnimationFrame(() => window.scrollTo(0, saved.y));
    } catch {
      /* corrupt or unavailable: just start from the top */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, on arrival
  }, []);
  /* eslint-enable react-hooks/set-state-in-effect */

  useEffect(() => {
    let timer: number | undefined;
    const save = () => {
      try {
        // Bounded: a huge library keeps only what fits comfortably.
        if (items.length <= 5000) sessionStorage.setItem(storeKey, JSON.stringify({ items, next, prev, y: window.scrollY, at: Date.now() }));
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
  }, [items, next, prev, storeKey]);

  // ── Loading pages ──
  const loadOlder = useCallback(async () => {
    if (!next || olderInFlight.current) return;
    olderInFlight.current = true;
    const gen = generation.current;
    setLoading(true);
    setFailed(false);
    try {
      const res = await fetch(`/api/libraries/${libraryId}/photos?after=${encodeURIComponent(next)}${extraQuery}`, { credentials: "same-origin" });
      if (!res.ok) throw new Error(String(res.status));
      const body = (await res.json()) as Page;
      if (gen !== generation.current) return;
      setItems((current) => {
        const have = new Set(current.map((i) => i.id));
        return [...current, ...body.items.filter((i) => !have.has(i.id))];
      });
      setNext(body.next);
    } catch {
      setFailed(true);
    } finally {
      olderInFlight.current = false;
      setLoading(false);
    }
  }, [libraryId, next, extraQuery]);

  const loadNewer = useCallback(async () => {
    if (!prev || newerInFlight.current) return;
    newerInFlight.current = true;
    const gen = generation.current;
    try {
      const res = await fetch(`/api/libraries/${libraryId}/photos?before=${encodeURIComponent(prev)}${extraQuery}`, { credentials: "same-origin" });
      if (!res.ok) throw new Error(String(res.status));
      const body = (await res.json()) as Page;
      if (gen !== generation.current) return;
      // Items are added ABOVE what is on screen: remember where the view is, and put it back once they are drawn.
      anchor.current = { height: document.documentElement.scrollHeight, y: window.scrollY };
      setItems((current) => {
        const have = new Set(current.map((i) => i.id));
        return [...body.items.filter((i) => !have.has(i.id)), ...current];
      });
      setPrev(body.prev ?? null);
    } catch {
      /* try again the next time the top comes into view */
    } finally {
      newerInFlight.current = false;
    }
  }, [libraryId, prev, extraQuery]);

  // After items were added above (or a jump replaced them), settle the scroll position before the browser paints.
  useLayoutEffect(() => {
    if (anchor.current) {
      const { height, y } = anchor.current;
      anchor.current = null;
      window.scrollTo(0, y + (document.documentElement.scrollHeight - height));
    }
    if (scrollToMonth.current) {
      const key = scrollToMonth.current;
      scrollToMonth.current = null;
      document.querySelector(`[data-month="${key}"]`)?.scrollIntoView({ block: "start" });
    }
  }, [items]);

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

  // Go to a month: if it is already on the page, scroll to it; otherwise load from there. Everything stays in
  // one list: older photos below, newer ones above as you scroll up (never a filtered view).
  const jump = useCallback(
    async (key: string) => {
      // Scroll in place only if the month is loaded from its newest photo: that holds when something newer sits
      // above its first loaded photo, or the top of the library is already loaded. A month that begins the loaded
      // list while newer photos are still to load would show partly, so it is loaded afresh instead.
      if (canScrollInPlace(items, prev !== null, key)) {
        document.querySelector(`[data-month="${key}"]`)?.scrollIntoView({ block: "start", behavior: "smooth" });
        return;
      }
      const gen = ++generation.current; // a later jump wins; an earlier answer arriving late is dropped
      olderInFlight.current = false;
      newerInFlight.current = false;
      setJumping(true);
      try {
        const res = await fetch(`/api/libraries/${libraryId}/photos?month=${encodeURIComponent(key)}${extraQuery}`, { credentials: "same-origin" });
        if (!res.ok || gen !== generation.current) return;
        const body = (await res.json()) as Page;
        if (gen !== generation.current) return;
        // The new list replaces the old at once, scrolled to its place, so no half-way position is ever drawn.
        scrollToMonth.current = body.items.some((i) => groupKey(i.takenAt, "month") === key) ? key : body.items[0] ? groupKey(body.items[0].takenAt, "month") : null;
        setItems(body.items);
        setNext(body.next);
        setPrev(body.prev ?? null);
        setLoading(false);
        setFailed(false);
      } catch {
        /* the scrubber just doesn't move; the timeline is unchanged */
      } finally {
        if (gen === generation.current) setJumping(false);
      }
    },
    [items, prev, libraryId, extraQuery]
  );

  const chooseZoom = (level: ZoomLevel) => {
    setZoom(level);
    try {
      localStorage.setItem("roam:photos:zoom", level);
    } catch {
      /* fine */
    }
  };

  // Near the bottom: older photos. Near the top (after a jump): newer ones.
  useEffect(() => {
    const el = bottom.current;
    if (!el || !next || failed) return;
    const observer = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && void loadOlder(), { rootMargin: "600px 0px" });
    observer.observe(el);
    return () => observer.disconnect();
  }, [loadOlder, next, failed]);

  useEffect(() => {
    const el = top.current;
    if (!el || !prev) return;
    const observer = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && void loadNewer(), { rootMargin: "600px 0px" });
    observer.observe(el);
    return () => observer.disconnect();
  }, [loadNewer, prev]);

  // Which month is at the top of the screen, for the scrubber (one lookup per frame while scrolling).
  useEffect(() => {
    let frame = 0;
    const update = () => {
      frame = 0;
      const el = document.elementFromPoint(Math.min(window.innerWidth - 60, 80), 150)?.closest("[data-month]");
      const month = el?.getAttribute("data-month");
      if (month) setCurrentMonth(month);
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);

  // ── The viewer overlay ──
  const openIndex = openId ? items.findIndex((i) => i.id === openId) : -1;
  const viewerItems = useMemo(() => (openIndex >= 0 ? [items[openIndex - 1], items[openIndex], items[openIndex + 1]].map((i) => (i ? viewerItem(i) : null)) : null), [items, openIndex]);

  const open = useCallback((id: string) => {
    // One history entry for the viewer, so the browser's Back (or a swipe from the edge) closes it.
    window.history.pushState({ roamViewer: true }, "", window.location.href);
    setOpenId(id);
  }, []);
  // Closing. Un-hearting while in the Favorites view removes the item now, not under your finger while viewing.
  const closed = useCallback(() => {
    setOpenId(null);
    if (view === "favorites") setItems((current) => (current.some((i) => !i.favorite) ? current.filter((i) => i.favorite) : current));
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

  // Stepping toward the end of what is loaded fetches more, so the viewer never runs out early.
  /* eslint-disable react-hooks/set-state-in-effect -- starting a fetch for data the viewer is about to need */
  useEffect(() => {
    if (openIndex < 0) return;
    if (openIndex >= items.length - 6) void loadOlder();
    if (openIndex <= 5) void loadNewer();
  }, [openIndex, items.length, loadOlder, loadNewer]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const setFavorite = useCallback((id: string, favorite: boolean) => setItems((current) => current.map((i) => (i.id === id ? { ...i, favorite } : i))), []);

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
  const dense = { day: "grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6", month: "grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-8", year: "grid-cols-5 sm:grid-cols-7 md:grid-cols-9 lg:grid-cols-11 xl:grid-cols-14" }[zoom];
  const from = view === "favorites" ? "from=favorites" : "from=timeline";

  return (
    <div className={`flex flex-col gap-6 pr-8 transition-opacity duration-200 ${jumping ? "opacity-50" : "opacity-100"}`} style={{ overflowAnchor: "none" }}>
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
      <div ref={top} aria-hidden className="h-px" />
      {groups.map((group, g) => (
        <section key={group.key} aria-label={group.label}>
          <h2 className="sticky top-16 z-10 -mx-1 mb-3 bg-background/85 px-1 py-2 text-sm font-semibold tracking-tight text-muted-foreground backdrop-blur">{group.label}</h2>
          <ul className={`grid gap-1 ${dense}`}>
            {group.items.map((item, i) => (
              <li key={item.id} className="min-w-0 scroll-mt-32" data-month={groupKey(item.takenAt, "month")}>
                <PhotoTile serverId={serverId} item={item} from={from} priority={g === 0 && i < 12} onOpen={open} />
              </li>
            ))}
          </ul>
        </section>
      ))}
      <PhotoScrubber keys={months} onJump={(key) => void jump(key)} current={currentMonth} />
      <div ref={bottom} aria-hidden className="h-px" />
      <div role="status" aria-live="polite" className="flex min-h-10 items-center justify-center text-sm text-muted-foreground">
        {loading && "Loading more…"}
        {failed && (
          <button type="button" onClick={() => void loadOlder()} className="rounded-lg bg-white/[0.06] px-4 py-2 ring-1 ring-white/[0.08] hover:bg-white/[0.09]">
            Couldn&apos;t load more. Try again
          </button>
        )}
        {!next && !loading && !failed && "That's everything."}
      </div>
      {viewerItems && viewerItems[1] && (
        <PhotoViewer
          current={viewerItems[1]}
          prev={viewerItems[0]}
          next={viewerItems[2]}
          onPrev={() => openIndex > 0 && setOpenId(items[openIndex - 1].id)}
          onNext={() => openIndex < items.length - 1 && setOpenId(items[openIndex + 1].id)}
          onClose={close}
          libraryId={libraryId}
          words={words}
          onFavoriteChange={setFavorite}
        />
      )}
    </div>
  );
}

// Re-exported so callers that only need the shape don't import the viewer.
export type { ViewerItem };
