"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Pause, Play, Maximize, Minimize, Volume2, VolumeX } from "lucide-react";
import { Slider } from "@/components/ui/slider";
import { Button } from "@/components/ui/button";
import type { PlayManifest } from "@/lib/player/types";

interface SeamlessPlayerProps {
  titleId: string;
  title: string;
}

const PRELOAD_THRESHOLD_SECONDS = 15;
const PROGRESS_SAVE_INTERVAL_MS = 10_000;

// The shadcn/Base UI Slider wrapper isn't generic over single vs. range
// values, so its callbacks are typed `number | readonly number[]`; both of
// our sliders are single-thumb, so normalize to a plain number.
function firstValue(v: number | readonly number[]): number {
  return Array.isArray(v) ? v[0] : (v as number);
}

function findSegment(manifest: PlayManifest, globalTime: number) {
  const clamped = Math.max(0, Math.min(globalTime, manifest.durationSeconds - 0.05));
  let seg = manifest.segments[manifest.segments.length - 1];
  for (const s of manifest.segments) {
    if (clamped < s.startSeconds + s.durationSeconds) {
      seg = s;
      break;
    }
  }
  return { segment: seg, localTime: clamped - seg.startSeconds };
}

function formatTime(totalSeconds: number) {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) totalSeconds = 0;
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = Math.floor(totalSeconds % 60);
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/**
 * Plays a title that may be split across multiple Box-hosted video files as
 * ONE continuous experience: a single global timeline, no visible stop or
 * reload at a segment boundary. See the "Streaming & the seamless segmented
 * player" section of the project plan for the design.
 *
 * Technique: two stacked <video> elements. The front one plays the current
 * segment while the back one silently preloads the next segment's URL. When
 * the front segment ends, we swap which element is visible/playing — the
 * back element is already buffered, so the swap is instant. This needs no
 * CORS on the Box URLs (plain `src` playback), unlike an MSE-based approach.
 */
export function SeamlessPlayer({ titleId, title }: SeamlessPlayerProps) {
  const router = useRouter();
  const containerRef = useRef<HTMLDivElement>(null);
  const videoRefs = useRef<[HTMLVideoElement | null, HTMLVideoElement | null]>([
    null,
    null,
  ]);

  const manifestRef = useRef<PlayManifest | null>(null);
  const [manifest, setManifest] = useState<PlayManifest | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Which physical <video> element (0 or 1) is currently the visible/active one.
  const [frontSlot, setFrontSlot] = useState<0 | 1>(0);
  const frontSlotRef = useRef<0 | 1>(0);
  // Index into manifest.segments that the front element is currently playing.
  const segIndexRef = useRef(0);
  const preloadedForRef = useRef<number | null>(null); // segIndex we've already preloaded the *next* segment for

  const [playing, setPlaying] = useState(false);
  const [globalTime, setGlobalTime] = useState(0);
  const [scrubTime, setScrubTime] = useState<number | null>(null); // non-null while dragging
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [finished, setFinished] = useState(false);

  const lastSavedAtRef = useRef(0);

  // ── Load the manifest ─────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await fetch(`/api/play/${titleId}`);
      if (cancelled) return;
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.error ?? "This title can't be played right now.");
        return;
      }
      const data: PlayManifest = await res.json();
      manifestRef.current = data;
      setManifest(data);
    })();
    return () => {
      cancelled = true;
    };
  }, [titleId]);

  // ── Initialize playback once the manifest is available ─────────────────
  useEffect(() => {
    if (!manifest) return;
    const { segment, localTime } = findSegment(manifest, manifest.resumeSeconds);
    segIndexRef.current = segment.index;
    frontSlotRef.current = 0; // frontSlot state already starts at 0
    // Seed the scrubber at the resume position before playback starts —
    // after this, `timeupdate` (an external-system subscription, not a
    // render-triggered write) is what keeps globalTime in sync.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setGlobalTime(manifest.resumeSeconds);

    const front = videoRefs.current[0];
    if (!front) return;
    front.src = segment.url;
    front.currentTime = 0;
    const onLoaded = () => {
      front.currentTime = localTime;
      front.removeEventListener("loadedmetadata", onLoaded);
    };
    front.addEventListener("loadedmetadata", onLoaded);
  }, [manifest]);

  const saveProgress = useCallback(
    (positionSeconds: number, isFinished: boolean) => {
      const m = manifestRef.current;
      if (!m) return;
      const payload = JSON.stringify({
        ownerKind: "title",
        ownerId: m.titleId,
        positionSeconds: Math.floor(positionSeconds),
        durationSeconds: Math.floor(m.durationSeconds),
        finished: isFinished,
      });
      // Best-effort; sendBeacon survives page unload, fetch doesn't.
      if (typeof navigator !== "undefined" && navigator.sendBeacon) {
        navigator.sendBeacon(
          "/api/watch-state",
          new Blob([payload], { type: "application/json" })
        );
      } else {
        fetch("/api/watch-state", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: payload,
          keepalive: true,
        }).catch(() => {});
      }
    },
    []
  );

  // ── Preload the next segment into the back element as we approach the end ──
  const maybePreloadNext = useCallback((front: HTMLVideoElement) => {
    const m = manifestRef.current;
    if (!m) return;
    const segIndex = segIndexRef.current;
    const next = m.segments[segIndex + 1];
    if (!next) return;
    if (preloadedForRef.current === segIndex) return;
    const remaining = front.duration - front.currentTime;
    if (!Number.isFinite(remaining) || remaining > PRELOAD_THRESHOLD_SECONDS) return;

    const backSlot = frontSlotRef.current === 0 ? 1 : 0;
    const back = videoRefs.current[backSlot];
    if (!back) return;
    back.src = next.url;
    back.preload = "auto";
    back.load();
    preloadedForRef.current = segIndex;
  }, []);

  // ── Swap to the next segment when the front one ends ────────────────────
  const advanceToNextSegment = useCallback(() => {
    const m = manifestRef.current;
    if (!m) return;
    const segIndex = segIndexRef.current;
    const next = m.segments[segIndex + 1];

    if (!next) {
      setPlaying(false);
      setFinished(true);
      saveProgress(m.durationSeconds, true);
      return;
    }

    const oldFrontSlot = frontSlotRef.current;
    const newFrontSlot = oldFrontSlot === 0 ? 1 : 0;
    const back = videoRefs.current[newFrontSlot];
    const old = videoRefs.current[oldFrontSlot];
    if (!back) return;

    // If the back element wasn't preloaded in time (slow network), fall
    // back to pointing it at the segment directly — a brief stall is far
    // better than getting stuck.
    if (preloadedForRef.current !== segIndex) {
      back.src = next.url;
      back.load();
    }
    back.currentTime = 0;
    void back.play();

    old?.pause();
    segIndexRef.current = next.index;
    frontSlotRef.current = newFrontSlot;
    preloadedForRef.current = null;
    setFrontSlot(newFrontSlot);
  }, [saveProgress]);

  // ── Wire up event listeners for both video elements ─────────────────────
  useEffect(() => {
    const cleanups: (() => void)[] = [];

    videoRefs.current.forEach((el, slot) => {
      if (!el) return;

      const onTimeUpdate = () => {
        if (frontSlotRef.current !== slot) return;
        const m = manifestRef.current;
        if (!m) return;
        const seg = m.segments[segIndexRef.current];
        const gt = seg.startSeconds + el.currentTime;
        setGlobalTime(gt);
        maybePreloadNext(el);

        const now = Date.now();
        if (now - lastSavedAtRef.current > PROGRESS_SAVE_INTERVAL_MS) {
          lastSavedAtRef.current = now;
          saveProgress(gt, false);
        }
      };
      const onEnded = () => {
        if (frontSlotRef.current !== slot) return;
        advanceToNextSegment();
      };
      const onPlay = () => {
        if (frontSlotRef.current === slot) setPlaying(true);
      };
      const onPause = () => {
        if (frontSlotRef.current === slot) setPlaying(false);
      };
      const onError = () => {
        if (frontSlotRef.current !== slot) return;
        // Segment URL likely expired mid-playback — re-fetch a fresh
        // manifest and resume from the current global position.
        setError("Reconnecting…");
        fetch(`/api/play/${titleId}`)
          .then((r) => r.json())
          .then((data: PlayManifest) => {
            manifestRef.current = data;
            setManifest(data);
            setError(null);
          })
          .catch(() => setError("Playback failed. Try reloading the page."));
      };

      el.addEventListener("timeupdate", onTimeUpdate);
      el.addEventListener("ended", onEnded);
      el.addEventListener("play", onPlay);
      el.addEventListener("pause", onPause);
      el.addEventListener("error", onError);
      cleanups.push(() => {
        el.removeEventListener("timeupdate", onTimeUpdate);
        el.removeEventListener("ended", onEnded);
        el.removeEventListener("play", onPlay);
        el.removeEventListener("pause", onPause);
        el.removeEventListener("error", onError);
      });
    });

    return () => cleanups.forEach((fn) => fn());
  }, [advanceToNextSegment, maybePreloadNext, saveProgress, titleId]);

  // Manifest URLs expire — proactively refresh a bit before they do, so a
  // long first segment doesn't run into an expired *next* segment URL.
  useEffect(() => {
    if (!manifest) return;
    const msUntilExpiry = new Date(manifest.expiresAt).getTime() - Date.now();
    const refreshInMs = Math.max(msUntilExpiry - 60_000, 30_000);
    const timer = setTimeout(async () => {
      const currentGlobal =
        manifestRef.current!.segments[segIndexRef.current].startSeconds +
        (videoRefs.current[frontSlotRef.current]?.currentTime ?? 0);
      const res = await fetch(`/api/play/${titleId}`).catch(() => null);
      if (!res?.ok) return;
      const fresh: PlayManifest = await res.json();
      fresh.resumeSeconds = currentGlobal;
      manifestRef.current = fresh;
      // Note: we don't reset the currently-playing element (it's still
      // valid); this just refreshes the URLs used for the *next* preload.
    }, refreshInMs);
    return () => clearTimeout(timer);
  }, [manifest, titleId]);

  // ── Controls ─────────────────────────────────────────────────────────
  const togglePlay = useCallback(() => {
    const front = videoRefs.current[frontSlotRef.current];
    if (!front) return;
    if (front.paused) void front.play();
    else front.pause();
  }, []);

  const seekTo = useCallback((targetGlobal: number) => {
    const m = manifestRef.current;
    if (!m) return;
    const { segment, localTime } = findSegment(m, targetGlobal);
    const wasPlaying = playing;

    if (segment.index === segIndexRef.current) {
      const front = videoRefs.current[frontSlotRef.current];
      if (front) front.currentTime = localTime;
      return;
    }

    // Seeking across a segment boundary: repoint the current front element
    // directly at the target segment (simpler than juggling the preload
    // slot during a manual seek).
    const front = videoRefs.current[frontSlotRef.current];
    if (!front) return;
    front.src = segment.url;
    const onLoaded = () => {
      front.currentTime = localTime;
      if (wasPlaying) void front.play();
      front.removeEventListener("loadedmetadata", onLoaded);
    };
    front.addEventListener("loadedmetadata", onLoaded);
    segIndexRef.current = segment.index;
    preloadedForRef.current = null;
    setGlobalTime(targetGlobal);
  }, [playing]);

  const toggleFullscreen = useCallback(() => {
    if (!containerRef.current) return;
    if (document.fullscreenElement) document.exitFullscreen();
    else containerRef.current.requestFullscreen();
  }, []);

  useEffect(() => {
    const onChange = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (["INPUT", "TEXTAREA"].includes((e.target as HTMLElement)?.tagName)) return;
      if (e.code === "Space") {
        e.preventDefault();
        togglePlay();
      } else if (e.code === "ArrowRight") {
        seekTo(globalTime + 10);
      } else if (e.code === "ArrowLeft") {
        seekTo(Math.max(0, globalTime - 10));
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [globalTime, seekTo, togglePlay]);

  useEffect(() => {
    videoRefs.current.forEach((el) => {
      if (!el) return;
      el.volume = volume;
      el.muted = muted;
    });
  }, [volume, muted]);

  if (error && !manifest) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
        <p className="text-sm text-destructive">{error}</p>
        <Button variant="secondary" onClick={() => router.back()}>
          Go back
        </Button>
      </div>
    );
  }

  const duration = manifest?.durationSeconds ?? 0;
  const displayTime = scrubTime ?? globalTime;

  return (
    <div ref={containerRef} className="group relative aspect-video w-full bg-black">
      {[0, 1].map((slot) => (
        <video
          key={slot}
          ref={(el) => {
            videoRefs.current[slot as 0 | 1] = el;
          }}
          playsInline
          className="absolute inset-0 h-full w-full"
          style={{ visibility: frontSlot === slot ? "visible" : "hidden" }}
        />
      ))}

      {finished && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/80">
          <p className="text-lg font-medium text-white">{title}</p>
          <Button onClick={() => router.back()}>Back to details</Button>
        </div>
      )}

      {!manifest && !error && (
        <div className="absolute inset-0 flex items-center justify-center text-sm text-white/70">
          Loading…
        </div>
      )}

      {manifest && !playing && !finished && (
        <button
          type="button"
          onClick={togglePlay}
          aria-label="Play"
          className="absolute inset-0 flex items-center justify-center"
        >
          <span className="flex size-16 items-center justify-center rounded-full bg-white/90 text-black transition-transform hover:scale-105">
            <Play className="ml-1 size-7" fill="currentColor" />
          </span>
        </button>
      )}

      {/* Controls */}
      <div
        className="absolute inset-x-0 bottom-0 flex flex-col gap-2 bg-gradient-to-t from-black/90 to-transparent px-4 pb-3 pt-8 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100"
        onClick={(e) => e.stopPropagation()}
      >
        <Slider
          value={[displayTime]}
          max={Math.max(duration, 1)}
          step={1}
          onValueChange={(v) => setScrubTime(firstValue(v))}
          onValueCommitted={(v) => {
            seekTo(firstValue(v));
            setScrubTime(null);
          }}
        />
        <div className="flex items-center gap-3 text-white">
          <Button variant="ghost" size="icon" onClick={togglePlay}>
            {playing ? <Pause /> : <Play />}
          </Button>
          <Button variant="ghost" size="icon" onClick={() => setMuted((m) => !m)}>
            {muted || volume === 0 ? <VolumeX /> : <Volume2 />}
          </Button>
          <div className="w-24">
            <Slider
              value={[muted ? 0 : volume]}
              max={1}
              step={0.05}
              onValueChange={(v) => {
                const next = firstValue(v);
                setVolume(next);
                setMuted(next === 0);
              }}
            />
          </div>
          <span className="text-xs tabular-nums text-white/80">
            {formatTime(displayTime)} / {formatTime(duration)}
          </span>
          <div className="flex-1" />
          <Button variant="ghost" size="icon" onClick={toggleFullscreen}>
            {isFullscreen ? <Minimize /> : <Maximize />}
          </Button>
        </div>
      </div>
    </div>
  );
}
