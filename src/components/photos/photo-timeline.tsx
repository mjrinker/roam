"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { PhotoTile } from "@/components/photos/photo-tile";
import { groupByMonth } from "@/lib/photos/months";
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
}: {
  serverId: string;
  libraryId: string;
  initialItems: TimelineItem[];
  initialNext: string | null;
}) {
  const [items, setItems] = useState(initialItems);
  const [next, setNext] = useState(initialNext);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const inFlight = useRef(false);
  const storeKey = `roam:photos:${libraryId}`;

  // Coming back from the viewer: restore the pages already loaded and the scroll position, if the
  // timeline still starts with the same photo (else it changed, and starting afresh is right).
  // Done after hydration so the first render always matches the server's.
  /* eslint-disable react-hooks/set-state-in-effect -- reading browser storage can only happen after hydration; that is the point */
  useEffect(() => {
    try {
      const saved = JSON.parse(sessionStorage.getItem(storeKey) ?? "null") as { items: TimelineItem[]; next: string | null; y: number } | null;
      if (!saved || saved.items.length <= initialItems.length || saved.items[0]?.id !== initialItems[0]?.id) return;
      setItems(saved.items);
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
        if (items.length <= 5000) sessionStorage.setItem(storeKey, JSON.stringify({ items, next, y: window.scrollY }));
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
  }, [items, next, storeKey]);
  const sentinel = useRef<HTMLDivElement | null>(null);

  const loadMore = useCallback(async () => {
    if (!next || inFlight.current) return;
    inFlight.current = true;
    setLoading(true);
    setFailed(false);
    try {
      const res = await fetch(`/api/libraries/${libraryId}/photos?after=${encodeURIComponent(next)}`, { credentials: "same-origin" });
      if (!res.ok) throw new Error(String(res.status));
      const body = (await res.json()) as { items: TimelineItem[]; next: string | null };
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
  }, [libraryId, next]);

  useEffect(() => {
    const el = sentinel.current;
    if (!el || !next || failed) return;
    const observer = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && void loadMore(), { rootMargin: "600px 0px" });
    observer.observe(el);
    return () => observer.disconnect();
  }, [loadMore, next, failed]);

  if (items.length === 0) {
    return (
      <div className="mx-auto flex max-w-sm flex-col items-center gap-2 py-24 text-center">
        <p className="text-lg font-medium">No photos yet</p>
        <p className="text-sm text-muted-foreground">Photos and videos appear here once the first scan finishes.</p>
      </div>
    );
  }

  const groups = groupByMonth(items);
  return (
    <div className="flex flex-col gap-8">
      {groups.map((group, g) => (
        <section key={group.key} aria-label={group.label} style={{ contentVisibility: "auto", containIntrinsicSize: "auto 600px" }}>
          <h2 className="sticky top-16 z-10 -mx-1 mb-3 bg-background/85 px-1 py-2 text-sm font-semibold tracking-tight text-muted-foreground backdrop-blur">{group.label}</h2>
          <ul className="grid grid-cols-3 gap-1 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-8">
            {group.items.map((item, i) => (
              <li key={item.id} className="min-w-0">
                <PhotoTile serverId={serverId} item={item} from="from=timeline" priority={g === 0 && i < 12} />
              </li>
            ))}
          </ul>
        </section>
      ))}
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
