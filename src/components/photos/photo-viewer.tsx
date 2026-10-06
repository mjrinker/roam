"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, ChevronLeft, ChevronRight, Download, Info, Loader2, Play, X } from "lucide-react";
import { Artwork } from "@/components/ui/artwork";
import {
  clampPan,
  DOUBLE_TAP_MS,
  DOUBLE_TAP_SCALE,
  dragAxis,
  isDoubleTap,
  isTap,
  ORIGINAL_ZOOM_THRESHOLD,
  panForZoom,
  pinchScale,
  settleScale,
  shouldClose,
  type DragAxis,
  type Tap,
} from "@/lib/photos/gestures";
import { decideSwipe } from "@/lib/photos/swipe";

/** A key press that is about typing, or a shortcut for the browser, is never ours. */
function isForUs(event: KeyboardEvent): boolean {
  if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return false;
  const t = event.target as HTMLElement | null;
  if (!t) return true;
  const tag = t.tagName;
  // A focused video uses the arrow keys to seek.
  return !(tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || tag === "VIDEO" || t.isContentEditable);
}

export interface PhotoViewerProps {
  kind: "photo" | "movie";
  id: string;
  name: string;
  /** Pictures: the large preview. */
  previewUrl: string;
  /** Pictures: the full-size file, swapped in when zoomed far in (only offered for formats browsers show). */
  originalUrl: string;
  zoomOriginal: boolean;
  /** Videos: the poster shown before play. */
  posterUrl: string | null;
  /** Rows for the info panel: label, value. */
  details: [string, string][];
  prevHref: string | null;
  nextHref: string | null;
  backHref: string;
  /** Warmed in the background so stepping forward is quick. */
  nextWarmUrl: string | null;
  /** Extra controls in the top bar (favorite). */
  actions?: ReactNode;
}

/**
 * One photo or video, large. Pictures: pinch or double-tap to zoom, drag to pan when zoomed, swipe
 * sideways for the next or previous item, swipe down to close, tap to hide the controls. Videos play right here
 * (tap to start; iOS won't start one by itself) and swipe the same way. The arrow keys step and Escape closes.
 */
export function PhotoViewer(props: PhotoViewerProps) {
  const { kind, id, name, details, prevHref, nextHref, backHref, nextWarmUrl, actions } = props;
  const router = useRouter();
  const [chrome, setChrome] = useState(true);
  const [panel, setPanel] = useState(false);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!isForUs(event) || event.repeat) return; // holding a key down must not fire a navigation per repeat
      if (event.key === "ArrowLeft" && prevHref) router.push(prevHref);
      else if (event.key === "ArrowRight" && nextHref) router.push(nextHref);
      else if (event.key === "Escape") {
        if (panel) setPanel(false);
        else router.push(backHref);
      } else if (event.key === "i") setPanel((p) => !p);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [router, prevHref, nextHref, backHref, panel]);

  // The viewer owns every gesture: no pull-to-refresh, no edge bounce behind it.
  useEffect(() => {
    const root = document.documentElement;
    const before = root.style.overscrollBehavior;
    root.style.overscrollBehavior = "none";
    return () => {
      root.style.overscrollBehavior = before;
    };
  }, []);

  // Warm the next item once this one has had its turn.
  useEffect(() => {
    if (!nextWarmUrl) return;
    const timer = window.setTimeout(() => {
      const img = new Image();
      img.src = nextWarmUrl;
    }, 1200);
    return () => window.clearTimeout(timer);
  }, [nextWarmUrl]);

  const go = useCallback((href: string) => router.push(href), [router]);
  const shown = chrome || panel;

  return (
    <div className="relative flex h-svh flex-col overflow-hidden overscroll-none bg-black text-white">
      <header className={`absolute inset-x-0 top-0 z-20 flex items-center gap-3 bg-gradient-to-b from-black/70 to-transparent px-4 py-3 transition-opacity duration-200 ${shown ? "opacity-100" : "pointer-events-none opacity-0"}`}>
        <Link href={backHref} aria-label="Back to the library" className="flex size-9 shrink-0 items-center justify-center rounded-full bg-white/10 hover:bg-white/20">
          <ArrowLeft className="size-4" />
        </Link>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-sm font-medium">{name}</h1>
          <p className="truncate text-xs text-white/60">{details.find(([label]) => label === "Taken")?.[1] ?? ""}</p>
        </div>
        {actions}
        <button type="button" onClick={() => setPanel((p) => !p)} aria-label="Info" aria-pressed={panel} className="flex size-9 shrink-0 items-center justify-center rounded-full bg-white/10 hover:bg-white/20">
          <Info className="size-4" />
        </button>
        <a href={props.originalUrl} download aria-label="Download original" className="flex size-9 shrink-0 items-center justify-center rounded-full bg-white/10 hover:bg-white/20 sm:w-auto sm:gap-2 sm:px-4 sm:text-sm">
          <Download className="size-4" aria-hidden />
          <span className="hidden sm:inline">Download original</span>
        </a>
      </header>

      <Stage key={id} kind={kind} backHref={backHref} prevHref={prevHref} nextHref={nextHref} go={go} onToggleChrome={() => setChrome((c) => !c)} props={props} />

      {shown && prevHref && (
        <Link href={prevHref} aria-label="Previous" className="absolute left-3 top-1/2 z-10 hidden size-11 -translate-y-1/2 items-center justify-center rounded-full bg-black/50 hover:bg-black/75 sm:flex">
          <ChevronLeft className="size-6" />
        </Link>
      )}
      {shown && nextHref && (
        <Link href={nextHref} aria-label="Next" className="absolute right-3 top-1/2 z-10 hidden size-11 -translate-y-1/2 items-center justify-center rounded-full bg-black/50 hover:bg-black/75 sm:flex">
          <ChevronRight className="size-6" />
        </Link>
      )}

      {panel && (
        <aside aria-label="Details" className="absolute inset-x-0 bottom-0 z-30 max-h-[60svh] overflow-y-auto rounded-t-2xl bg-neutral-900/95 p-5 pb-8 shadow-2xl ring-1 ring-white/10 backdrop-blur sm:inset-x-auto sm:right-4 sm:bottom-4 sm:w-80 sm:rounded-2xl">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold">Details</h2>
            <button type="button" onClick={() => setPanel(false)} aria-label="Close details" className="flex size-8 items-center justify-center rounded-full hover:bg-white/10">
              <X className="size-4" />
            </button>
          </div>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
            {details.map(([label, value]) => (
              <div key={label} className="contents">
                <dt className="text-white/50">{label}</dt>
                <dd className="min-w-0 break-words">{value}</dd>
              </div>
            ))}
          </dl>
        </aside>
      )}
    </div>
  );
}

/** The gesture surface. Remounts for each item (keyed by id), so zoom and drag never carry over. */
function Stage({
  kind,
  backHref,
  prevHref,
  nextHref,
  go,
  onToggleChrome,
  props,
}: {
  kind: "photo" | "movie";
  backHref: string;
  prevHref: string | null;
  nextHref: string | null;
  go: (href: string) => void;
  onToggleChrome: () => void;
  props: PhotoViewerProps;
}) {
  const router = useRouter();
  const frameRef = useRef<HTMLDivElement>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const g = useRef({
    startX: 0, startY: 0, startT: 0, axis: null as DragAxis, pinching: false,
    startPan: { x: 0, y: 0 }, startScale: 1, startDist: 0, fingers: 1, moved: false,
  });
  const lastTap = useRef<Tap | null>(null);
  const tapTimer = useRef<number | undefined>(undefined);
  const [scale, setScale] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [drag, setDrag] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const [pinching, setPinching] = useState(false);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [originalReady, setOriginalReady] = useState(false);
  const zoomable = kind === "photo";

  useEffect(() => () => window.clearTimeout(tapTimer.current), []);

  const frame = () => {
    const r = frameRef.current?.getBoundingClientRect();
    return { w: r?.width ?? 1, h: r?.height ?? 1, left: r?.left ?? 0, top: r?.top ?? 0 };
  };
  const dist = () => {
    const [a, b] = [...pointers.current.values()];
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.pointerType === "mouse" && e.button !== 0) return; // a right click isn't a gesture
    // A press on a button or link (Try again, Play) is that control's, and one on a video's own controls (its
    // bottom strip: play, seek bar, volume) must not become a swipe or a drag. Never capture those.
    const target = e.target as HTMLElement;
    if (target.closest("button, a")) return;
    if (target.tagName === "VIDEO") {
      const f = frame();
      if (e.clientY > f.top + f.h * 0.72) return;
    }
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const s = g.current;
    if (pointers.current.size === 1) {
      Object.assign(s, { startX: e.clientX, startY: e.clientY, startT: Date.now(), axis: null, pinching: false, startPan: pan, startScale: scale, fingers: 1, moved: false });
    } else if (pointers.current.size === 2 && zoomable) {
      Object.assign(s, { pinching: true, startDist: dist(), startScale: scale, startPan: pan, fingers: 2, moved: true });
      setPinching(true);
    } else {
      s.fingers = pointers.current.size;
    }
    if (zoomable) (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const s = g.current;
    const f = frame();

    if (s.pinching && pointers.current.size >= 2) {
      const next = pinchScale(s.startDist, dist(), s.startScale);
      const [a, b] = [...pointers.current.values()];
      const focus = { x: (a.x + b.x) / 2 - f.left - f.w / 2, y: (a.y + b.y) / 2 - f.top - f.h / 2 };
      setScale(next);
      setPan(clampPan(panForZoom(s.startPan, s.startScale, next, focus), next, f));
      return;
    }
    if (pointers.current.size !== 1) return;

    const dx = e.clientX - s.startX;
    const dy = e.clientY - s.startY;
    if (Math.hypot(dx, dy) > 10) s.moved = true;

    if (scale > 1) {
      // Zoomed in: one finger (or the mouse) moves the picture.
      setPan(clampPan({ x: s.startPan.x + dx, y: s.startPan.y + dy }, scale, f));
      setDragging(true);
      return;
    }
    if (e.pointerType === "mouse") return; // swipes are a touch thing
    s.axis ??= dragAxis(dx, dy);
    if (s.axis === "x" && (dx < 0 ? nextHref : prevHref)) {
      setDrag({ x: dx, y: 0 });
      setDragging(true);
    } else if (s.axis === "y" && zoomable && dy > 0) {
      setDrag({ x: 0, y: dy });
      setDragging(true);
    }
  };

  const finish = (e: React.PointerEvent) => {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.delete(e.pointerId);
    const s = g.current;
    const wasPinching = s.pinching;
    setPinching(false);

    if (pointers.current.size > 0) {
      // One finger left after a pinch: carry on as a pan from here.
      if (wasPinching && pointers.current.size === 1) {
        const rest = [...pointers.current.values()][0];
        Object.assign(s, { pinching: false, startX: rest.x, startY: rest.y, startPan: pan, startScale: scale, axis: null });
        setPinching(false);
      }
      return;
    }

    const settled = settleScale(scale);
    if (wasPinching || settled !== scale) {
      setScale(settled);
      if (settled === 1) setPan({ x: 0, y: 0 });
      else setPan((p) => clampPan(p, settled, frame()));
    }
    setDragging(false);
    const up: Tap = { x: e.clientX, y: e.clientY, t: Date.now() };
    const down: Tap = { x: s.startX, y: s.startY, t: s.startT };
    const dx = up.x - down.x;
    const dy = up.y - down.y;
    const ms = up.t - down.t;
    setDrag({ x: 0, y: 0 });

    if (wasPinching || s.fingers > 1) return;
    if (scale === 1 && e.pointerType !== "mouse" && s.axis) {
      if (s.axis === "x") {
        const decision = decideSwipe({ dx, dy, ms, fingers: 1 });
        if (decision === "next" && nextHref) go(nextHref);
        else if (decision === "prev" && prevHref) go(prevHref);
      } else if (zoomable && shouldClose(dy, ms)) {
        router.push(backHref);
      }
      return;
    }
    if (zoomable && isTap(down, up)) {
      const f = frame();
      if (isDoubleTap(lastTap.current, up)) {
        window.clearTimeout(tapTimer.current);
        lastTap.current = null;
        const target = scale > 1 ? 1 : DOUBLE_TAP_SCALE;
        const focus = { x: up.x - f.left - f.w / 2, y: up.y - f.top - f.h / 2 };
        setScale(target);
        setPan(target === 1 ? { x: 0, y: 0 } : clampPan(panForZoom(pan, scale, target, focus), target, f));
      } else {
        lastTap.current = up;
        // A single tap toggles the controls, unless a second tap follows (a double tap zooms).
        window.clearTimeout(tapTimer.current);
        tapTimer.current = window.setTimeout(onToggleChrome, DOUBLE_TAP_MS);
      }
    }
  };

  const closeFade = drag.y > 0 ? Math.max(0.4, 1 - drag.y / 500) : 1;
  const transform = `translate(${pan.x + drag.x}px, ${pan.y + drag.y}px) scale(${scale})`;
  const src = attempt === 0 ? props.previewUrl : `${props.previewUrl}?retry=${attempt}`;
  const wantOriginal = zoomable && props.zoomOriginal && scale > ORIGINAL_ZOOM_THRESHOLD;

  return (
    <div
      ref={frameRef}
      className="relative flex-1 touch-none select-none overflow-hidden"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={finish}
      onPointerCancel={finish}
      style={{ opacity: closeFade, cursor: scale > 1 ? (dragging ? "grabbing" : "grab") : undefined }}
    >
      <div
        className="absolute inset-0"
        style={{ transform, transformOrigin: "center", transition: dragging || pinching ? "none" : "transform 180ms ease-out", willChange: "transform" }}
      >
        {kind === "movie" ? (
          <VideoStage id={props.id} name={props.name} posterUrl={props.posterUrl} />
        ) : failed ? (
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
          <>
            <Artwork key={src} src={src} alt={props.name} fill priority sizes="100vw" draggable={false} onError={() => setFailed(true)} className="object-contain" />
            {wantOriginal && (
              <Artwork
                src={props.originalUrl}
                alt=""
                fill
                sizes="400vw"
                draggable={false}
                onLoad={() => setOriginalReady(true)}
                className="object-contain transition-opacity duration-200"
                style={{ opacity: originalReady ? 1 : 0 }}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}

/**
 * A video that sits among the photos, playing in place. It never starts by itself (iOS refuses unmuted
 * autoplay), the link to the file expires, so an error or a play after the expiry fetches a fresh one and
 * carries on from the same moment, and leaving releases the decoder and the connection.
 */
function VideoStage({ id, name, posterUrl }: { id: string; name: string; posterUrl: string | null }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [state, setState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [url, setUrl] = useState<string | null>(null);
  const expiresAt = useRef(0);
  const refreshes = useRef<number[]>([]);

  const load = useCallback(async (): Promise<string | null> => {
    try {
      const res = await fetch(`/api/play/title/${id}`, { credentials: "same-origin" });
      if (!res.ok) return null;
      const manifest = (await res.json()) as { segments: { url: string }[]; expiresAt: string };
      expiresAt.current = new Date(manifest.expiresAt).getTime();
      return manifest.segments[0]?.url ?? null;
    } catch {
      return null;
    }
  }, [id]);

  const start = async () => {
    setState("loading");
    const next = await load();
    if (!next) return setState("error");
    setUrl(next);
    setState("ready");
  };

  // Autoplay is attempted once the file is attached; if the browser refuses, the native controls are there.
  useEffect(() => {
    if (state === "ready") void videoRef.current?.play().catch(() => undefined);
  }, [state, url]);

  const refresh = async () => {
    const video = videoRef.current;
    if (!video) return;
    // At most 3 fresh links per minute: a file that keeps failing must end in the error state, not loop
    // (each fresh link can mean live calls to Box and a wait of up to 40 seconds).
    const now = Date.now();
    refreshes.current = refreshes.current.filter((t) => now - t < 60_000);
    if (refreshes.current.length >= 3) {
      setUrl(null);
      return setState("error");
    }
    refreshes.current.push(now);
    const at = video.currentTime;
    const wasPlaying = !video.paused;
    const next = await load();
    if (!next) return setState("error");
    setUrl(next);
    video.addEventListener(
      "loadedmetadata",
      () => {
        video.currentTime = at;
        if (wasPlaying) void video.play().catch(() => undefined);
      },
      { once: true }
    );
  };

  // Release the decoder and the stream when this item is left.
  useEffect(() => {
    return () => {
      // Read the element when leaving, not when mounting: it only exists once the video is ready.
      // eslint-disable-next-line react-hooks/exhaustive-deps -- the ref is wanted as it is at unmount
      const video = videoRef.current;
      if (video) {
        video.pause();
        video.removeAttribute("src");
        video.load();
      }
    };
  }, []);

  if (state === "ready" && url) {
    return (
      <video
        ref={videoRef}
        src={url}
        poster={posterUrl ?? undefined}
        controls
        playsInline
        preload="metadata"
        aria-label={name}
        className="absolute inset-0 size-full bg-black object-contain"
        onError={() => void refresh()}
        onPlay={() => {
          if (expiresAt.current && Date.now() > expiresAt.current - 60_000) void refresh();
        }}
      />
    );
  }
  return (
    <button type="button" onClick={() => void start()} disabled={state === "loading"} aria-label={`Play video ${name}`} className="absolute inset-0 flex items-center justify-center">
      {posterUrl && <Artwork src={posterUrl} alt="" fill sizes="100vw" draggable={false} className="object-contain opacity-80" />}
      <span className="relative flex size-16 items-center justify-center rounded-full bg-black/60 ring-1 ring-white/30">
        {state === "loading" ? <Loader2 className="size-7 animate-spin" /> : <Play className="size-7 translate-x-0.5 fill-current" />}
      </span>
      {state === "error" && <span className="absolute bottom-24 rounded-full bg-black/70 px-4 py-2 text-sm">This video can&apos;t be played right now. Tap to try again.</span>}
    </button>
  );
}
