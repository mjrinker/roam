"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ChevronLeft, ChevronRight, Download } from "lucide-react";
import { Artwork } from "@/components/ui/artwork";
import { decideSwipe } from "@/lib/photos/swipe";

/** A key press that is about typing, or a shortcut for the browser, is never ours. */
function isForUs(event: KeyboardEvent): boolean {
  if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return false;
  const t = event.target as HTMLElement | null;
  if (!t) return true;
  const tag = t.tagName;
  return !(tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || t.isContentEditable);
}

/**
 * One photo, large. The image comes from the preview route (which picks the right size and checks
 * access); arrow keys move between photos and Escape goes back. The next photo's preview is fetched
 * ahead of time so stepping forward is quick.
 */
export function PhotoViewer({
  previewUrl,
  originalUrl,
  name,
  takenLabel,
  dimensions,
  prevHref,
  nextHref,
  backHref,
  nextPreviewUrl,
}: {
  previewUrl: string;
  originalUrl: string;
  name: string;
  takenLabel: string | null;
  dimensions: string | null;
  prevHref: string | null;
  nextHref: string | null;
  backHref: string;
  nextPreviewUrl: string | null;
}) {
  const router = useRouter();
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  // Finger swipes: the picture follows the finger sideways, then the next or previous photo opens.
  const touch = useRef<{ x: number; y: number; t: number; fingers: number } | null>(null);
  const [drag, setDrag] = useState(0);
  const onTouchStart = (e: React.TouchEvent) => {
    touch.current = { x: e.touches[0].clientX, y: e.touches[0].clientY, t: Date.now(), fingers: e.touches.length };
  };
  const onTouchMove = (e: React.TouchEvent) => {
    const start = touch.current;
    if (!start) return;
    if (e.touches.length > 1) start.fingers = e.touches.length; // a pinch cancels the swipe
    const dx = e.touches[0].clientX - start.x;
    const dy = e.touches[0].clientY - start.y;
    const wanted = dx < 0 ? nextHref : prevHref;
    setDrag(start.fingers === 1 && wanted && Math.abs(dx) > Math.abs(dy) * 1.5 ? dx : 0);
  };
  const onTouchEnd = (e: React.TouchEvent) => {
    const start = touch.current;
    touch.current = null;
    setDrag(0);
    if (!start) return;
    const end = e.changedTouches[0];
    const decision = decideSwipe({ dx: end.clientX - start.x, dy: end.clientY - start.y, ms: Date.now() - start.t, fingers: start.fingers });
    if (decision === "next" && nextHref) router.push(nextHref);
    else if (decision === "prev" && prevHref) router.push(prevHref);
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!isForUs(event) || event.repeat) return; // holding a key down must not fire a navigation per repeat
      if (event.key === "ArrowLeft" && prevHref) router.push(prevHref);
      else if (event.key === "ArrowRight" && nextHref) router.push(nextHref);
      else if (event.key === "Escape") router.push(backHref);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [router, prevHref, nextHref, backHref]);

  // Warm the next photo once this one has had its turn.
  useEffect(() => {
    if (!nextPreviewUrl) return;
    const timer = window.setTimeout(() => {
      const img = new Image();
      img.src = nextPreviewUrl;
    }, 1200);
    return () => window.clearTimeout(timer);
  }, [nextPreviewUrl]);

  const src = attempt === 0 ? previewUrl : `${previewUrl}?retry=${attempt}`;
  return (
    <div className="flex min-h-svh flex-col bg-black text-white">
      <header className="flex items-center gap-3 px-4 py-3">
        <Link href={backHref} aria-label="Back to the library" className="flex size-9 items-center justify-center rounded-full bg-white/10 hover:bg-white/20">
          <ArrowLeft className="size-4" />
        </Link>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-sm font-medium">{name}</h1>
          <p className="truncate text-xs text-white/60">{[takenLabel, dimensions].filter(Boolean).join(" · ")}</p>
        </div>
        <a href={originalUrl} download className="flex items-center gap-2 rounded-full bg-white/10 px-4 py-2 text-sm hover:bg-white/20">
          <Download className="size-4" aria-hidden /> Download original
        </a>
      </header>

      <div className="relative flex-1 touch-pan-y touch-pinch-zoom overflow-hidden" onTouchStart={onTouchStart} onTouchMove={onTouchMove} onTouchEnd={onTouchEnd} onTouchCancel={onTouchEnd}>
        {failed ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-center">
            <p className="text-lg font-medium">This photo can&apos;t be shown right now</p>
            <p className="max-w-sm text-sm text-white/60">It may still be getting ready. You can try again or download the original.</p>
            <button
              type="button"
              onClick={() => {
                setFailed(false);
                setAttempt((a) => a + 1);
              }}
              className="rounded-full bg-white/10 px-4 py-2 text-sm hover:bg-white/20"
            >
              Try again
            </button>
          </div>
        ) : (
          <div className="absolute inset-0" style={{ transform: drag ? `translateX(${drag}px)` : undefined, transition: drag ? "none" : "transform 150ms ease-out" }}>
            <Artwork key={src} src={src} alt={name} fill priority sizes="100vw" onError={() => setFailed(true)} className="object-contain" />
          </div>
        )}

        {prevHref && (
          <Link href={prevHref} aria-label="Previous photo" className="absolute left-3 top-1/2 flex size-11 -translate-y-1/2 items-center justify-center rounded-full bg-black/50 hover:bg-black/75">
            <ChevronLeft className="size-6" />
          </Link>
        )}
        {nextHref && (
          <Link href={nextHref} aria-label="Next photo" className="absolute right-3 top-1/2 flex size-11 -translate-y-1/2 items-center justify-center rounded-full bg-black/50 hover:bg-black/75">
            <ChevronRight className="size-6" />
          </Link>
        )}
      </div>
    </div>
  );
}
