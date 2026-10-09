"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  Loader2,
  Maximize,
  Minimize,
  Pause,
  Play,
  RotateCcw,
  RotateCw,
  SkipForward,
  Volume2,
  VolumeX,
} from "lucide-react";
import { Slider } from "@/components/ui/slider";
import { Button } from "@/components/ui/button";
import Link from "next/link";
import { cn } from "@/lib/utils";
import { useAudioActions } from "@/components/audio/audio-player-provider";
import { clampSpeed } from "@/lib/player/speed";
import { SubtitleOverlay, type LoadedTrack } from "@/components/player/subtitles";
import { SettingsMenu } from "@/components/player/settings-menu";
import { readPreferredHeight, writePreferredHeight } from "@/lib/player/quality-preference";
import type { PlayManifest, PlayOwnerKind } from "@/lib/player/types";
import { UNSUPPORTED_AUDIO_CODECS } from "@/lib/scan/codec-support";
import {
  crossedVirtualEnd,
  remainingInSegment,
  toElementTime,
  toLocalTime,
  windowClampTarget,
} from "@/lib/player/timeline";

/** What a floating bar needs to know about the player, reported as it changes. */
export interface PlayerStatus {
  ready: boolean;
  playing: boolean;
  buffering: boolean;
  finished: boolean;
  error: string | null;
  /** Seconds into the whole title, and its length. */
  time: number;
  duration: number;
}

/** What a floating bar can ask the player to do. */
export interface PlayerControls {
  toggle(): void;
  /** Move by this many seconds (negative goes back), staying inside the title. */
  skip(seconds: number): void;
  pause(): void;
}

interface SeamlessPlayerProps {
  /**
   * "full" fills the screen. "mini" keeps the video playing out of sight (the sound carries on) while a floating bar,
   * drawn elsewhere, shows and controls it.
   */
  mode?: "full" | "mini";
  onStatus?: (status: PlayerStatus) => void;
  controlsRef?: { current: PlayerControls | null };
  ownerKind: PlayOwnerKind;
  ownerId: string;
  title: string;
  /** Secondary line under the title, e.g. "S1 · E3 · Pilot". */
  subtitle?: string | null;
  /** Where the back arrow (and the finished screen's back button) goes. */
  backHref: string;
  /** Shown as a button on the finished screen, e.g. linking to the next episode. */
  nextHref?: string;
  nextLabel?: string;
}

const PRELOAD_THRESHOLD_SECONDS = 15;
const PROGRESS_SAVE_INTERVAL_MS = 10_000;
const CONTROLS_HIDE_MS = 3000;
const SKIP_SECONDS = 10;

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
// Which of the known-problem audio codecs THIS browser can't decode. Tested
// per codec (Safari plays AC-3 but not DTS), and computed once — the server
// uses it to hand back a remuxed copy of any file whose audio is one of them.
let unsupportedCodecsQuery: string | null = null;
function playManifestUrl(ownerKind: PlayOwnerKind, ownerId: string, version?: string): string {
  if (unsupportedCodecsQuery === null) {
    const probe = document.createElement("video");
    const unsupported = UNSUPPORTED_AUDIO_CODECS.filter((codec) => !probe.canPlayType(`video/mp4; codecs="${codec}"`));
    unsupportedCodecsQuery = unsupported.length > 0 ? `?unsupportedCodecs=${unsupported.join(",")}` : "";
  }
  // Which resolution: the one asked for, else the one closest to what this device last picked, else the best the title has.
  const extra = new URLSearchParams();
  if (version !== undefined) extra.set("version", version);
  else {
    const height = readPreferredHeight();
    if (height !== null) extra.set("height", String(height));
  }
  const more = extra.toString();
  return `/api/play/${ownerKind}/${ownerId}${unsupportedCodecsQuery}${more ? `${unsupportedCodecsQuery ? "&" : "?"}${more}` : ""}`;
}

export function SeamlessPlayer({
  mode = "full",
  onStatus,
  controlsRef,
  ownerKind,
  ownerId,
  title,
  subtitle,
  backHref,
  nextHref,
  nextLabel,
}: SeamlessPlayerProps) {
  // A movie takes over: pause any audiobook that's playing in the background.
  const audioActions = useAudioActions();
  useEffect(() => {
    audioActions?.pause();
  }, [audioActions]);

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
  // Latches once per trimmed segment so its virtual end (see
  // crossedVirtualEnd in lib/player/timeline.ts) can only trigger ONE
  // advance/finish, even though onTimeUpdate keeps firing (and re-crossing
  // the threshold) every tick after that until something actually moves
  // playback elsewhere. Reset wherever segIndexRef/frontSlotRef change to
  // point at a genuinely new segment.
  const virtualEndFiredRef = useRef(false);

  const [playing, setPlaying] = useState(false);
  const [globalTime, setGlobalTime] = useState(0);
  const [scrubTime, setScrubTime] = useState<number | null>(null); // non-null while dragging
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [finished, setFinished] = useState(false);
  const finishedRef = useRef(false);
  // Whether this title has actually played in this player: only then is its position worth saving on the way out
  // (a player closed before the picture loaded would otherwise write 0 over a resume point or a watched mark).
  const hasPlayedRef = useRef(false);
  const flushRef = useRef<() => void>(() => undefined);
  useEffect(() => {
    finishedRef.current = finished;
  }, [finished]);
  const [buffering, setBuffering] = useState(false);
  // Playback speed: starts at the library's default and lasts until the player is closed (this component goes away); a speed the
  // viewer picked is kept when the next episode loads into the same player.
  const [rate, setRate] = useState(1);
  const rateTouchedRef = useRef(false);
  // Subtitles are for this viewing only: whatever the viewer loads (a file, or one from OpenSubtitles), the one switched on, and a delay.
  // Nothing is stored, and each new video starts with none.
  const [tracks, setTracks] = useState<LoadedTrack[]>([]);
  const [activeTrack, setActiveTrack] = useState<string | null>(null);
  const [subOffset, setSubOffset] = useState(0);
  // Playing again after a switch of resolution (the new files load, then it carries on from where it was).
  const resumePlayingRef = useRef(false);
  const switchTokenRef = useRef(0);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [hoverRatio, setHoverRatio] = useState<number | null>(null);

  const lastSavedAtRef = useRef(0);
  const scrubBarRef = useRef<HTMLDivElement>(null);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Show the controls, then hide them again after a beat of inactivity —
  // but only while actually playing (paused = controls stay put).
  const showControls = useCallback(() => {
    setControlsVisible(true);
    clearTimeout(hideTimerRef.current);
    hideTimerRef.current = setTimeout(() => {
      const front = videoRefs.current[frontSlotRef.current];
      if (front && !front.paused) setControlsVisible(false);
    }, CONTROLS_HIDE_MS);
  }, []);

  useEffect(() => () => clearTimeout(hideTimerRef.current), []);

  // ── Load the manifest ─────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    const videos = videoRefs.current; // the same two-slot list for the player's whole life
    (async () => {
      const res = await fetch(playManifestUrl(ownerKind, ownerId));
      if (cancelled) return;
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.error ?? "This can't be played right now.");
        return;
      }
      const data: PlayManifest = await res.json();
      manifestRef.current = data;
      setManifest(data);
      if (!rateTouchedRef.current) setRate(clampSpeed(data.defaultRate ?? 1));
    })();
    return () => {
      cancelled = true;
      // This video is being left (another one is opening in this player, or the player is closing): save where it got to, stop it,
      // let go of its files and start the next from a clean slate (not "playing", not "finished").
      flushRef.current();
      hasPlayedRef.current = false;
      manifestRef.current = null;
      virtualEndFiredRef.current = false;
      videos.forEach((el) => {
        if (!el) return;
        el.pause();
        el.removeAttribute("src");
        el.load();
      });
      setManifest(null);
      setPlaying(false);
      setBuffering(false);
      setFinished(false);
      setError(null);
      setGlobalTime(0);
      setTracks([]);
      setActiveTrack(null);
    };
  }, [ownerKind, ownerId]);

  // ── Initialize playback once the manifest is available ─────────────────
  // NOTE: this effect re-runs not just on first mount, but also whenever
  // `ownerId` changes on an ALREADY-MOUNTED player — e.g. clicking "Play
  // next episode" navigates to a new /watch/episode/[id] URL, but since
  // it's the same <SeamlessPlayer> component at the same position in the
  // tree, React reuses the instance and just updates props; it does not
  // remount. So every reset below is load-bearing, not just first-mount
  // setup — skipping any of them leaves state from the previous title
  // bleeding into the next one.
  useEffect(() => {
    if (!manifest) return;
    const { segment, localTime } = findSegment(manifest, manifest.resumeSeconds);
    segIndexRef.current = segment.index;
    frontSlotRef.current = 0;
    preloadedForRef.current = null;
    virtualEndFiredRef.current = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setFrontSlot(0);
    setFinished(false);
    setScrubTime(null);
    // Seed the scrubber at the resume position before playback starts —
    // after this, `timeupdate` (an external-system subscription, not a
    // render-triggered write) is what keeps globalTime in sync.
    setGlobalTime(manifest.resumeSeconds);

    // The *other* slot may still hold the previous title's video (mid-watch
    // or a stale preload) — stop and release it so nothing lingers.
    const other = videoRefs.current[1];
    if (other) {
      other.pause();
      other.removeAttribute("src");
      other.load();
    }

    const front = videoRefs.current[0];
    if (!front) return;
    front.src = segment.url;
    front.currentTime = 0;
    const onLoaded = () => {
      front.currentTime = toElementTime(segment, localTime);
      front.removeEventListener("loadedmetadata", onLoaded);
      if (resumePlayingRef.current) {
        resumePlayingRef.current = false;
        void front.play();
      }
    };
    front.addEventListener("loadedmetadata", onLoaded);
  }, [manifest]);

  const saveProgress = useCallback(
    (positionSeconds: number, isFinished: boolean) => {
      const m = manifestRef.current;
      if (!m) return;
      const payload = JSON.stringify({
        ownerKind: m.ownerKind,
        ownerId: m.ownerId,
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
    const seg = m.segments[segIndex];
    const next = m.segments[segIndex + 1];
    if (!next) return;
    if (preloadedForRef.current === segIndex) return;
    const remaining = remainingInSegment(seg, front.currentTime, front.duration);
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
    back.currentTime = toElementTime(next, 0);
    void back.play();

    old?.pause();
    segIndexRef.current = next.index;
    frontSlotRef.current = newFrontSlot;
    preloadedForRef.current = null;
    virtualEndFiredRef.current = false;
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

        // A trimmed segment (an episode's estimated slice of a shared
        // multi-episode file) has no natural end of its own — the
        // underlying element just keeps playing into the NEXT episode's
        // content unless we stop it ourselves. Pause first, every tick,
        // so resuming playback after the finish (Space, togglePlay) can't
        // sneak past the wall again; the latch below is only about not
        // firing advanceToNextSegment/saveProgress more than once.
        if (crossedVirtualEnd(seg, el.currentTime)) {
          el.pause();
          if (!virtualEndFiredRef.current) {
            virtualEndFiredRef.current = true;
            setGlobalTime(seg.startSeconds + seg.durationSeconds);
            advanceToNextSegment();
          }
          return;
        }

        const gt = seg.startSeconds + toLocalTime(seg, el.currentTime);
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
        const m = manifestRef.current;
        const seg = m?.segments[segIndexRef.current];
        // A trimmed segment's own virtual-end handling above already
        // covers the "no next segment" (finish) case — the element's
        // OWN `ended` firing at the physical file's true end is either
        // redundant with that (the latch is already set) or, for the
        // very last sibling of a combined file, the two races and
        // whichever fires first should win, not both.
        if (seg && virtualEndFiredRef.current) return;
        advanceToNextSegment();
      };
      const onPlay = () => {
        if (frontSlotRef.current !== slot) return;
        hasPlayedRef.current = true;
        setPlaying(true);
        showControls();
      };
      const onPause = () => {
        if (frontSlotRef.current === slot) setPlaying(false);
      };
      const onWaiting = () => {
        if (frontSlotRef.current === slot) setBuffering(true);
      };
      const onReady = () => {
        if (frontSlotRef.current === slot) setBuffering(false);
      };
      // Native player surfaces (iOS fullscreen scrubber, PiP, AirPlay,
      // OS media keys' seek) work on the PHYSICAL file, not our virtual
      // window — an in-app seek is already clamped by findSegment/seekTo,
      // but a native one can land anywhere in the shared file. Snap it
      // back inside the window, and re-arm the virtual-end latch when it
      // lands back before the end (mirrors how a native seek backward on
      // ordinary content lets `ended` fire again naturally).
      const onSeekedClamp = () => {
        if (frontSlotRef.current !== slot) return;
        const m = manifestRef.current;
        const seg = m?.segments[segIndexRef.current];
        if (!seg) return;
        const target = windowClampTarget(seg, el.currentTime);
        if (target !== null) {
          el.currentTime = target;
          return;
        }
        if (!crossedVirtualEnd(seg, el.currentTime)) virtualEndFiredRef.current = false;
      };
      const onError = () => {
        if (frontSlotRef.current !== slot) return;
        // Segment URL likely expired mid-playback — re-fetch a fresh
        // manifest and resume from the current global position.
        setError("Reconnecting…");
        fetch(playManifestUrl(ownerKind, ownerId, manifestRef.current?.version))
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
      el.addEventListener("waiting", onWaiting);
      el.addEventListener("playing", onReady);
      el.addEventListener("canplay", onReady);
      el.addEventListener("seeked", onReady);
      el.addEventListener("seeked", onSeekedClamp);
      cleanups.push(() => {
        el.removeEventListener("waiting", onWaiting);
        el.removeEventListener("playing", onReady);
        el.removeEventListener("canplay", onReady);
        el.removeEventListener("seeked", onReady);
        el.removeEventListener("seeked", onSeekedClamp);
        el.removeEventListener("timeupdate", onTimeUpdate);
        el.removeEventListener("ended", onEnded);
        el.removeEventListener("play", onPlay);
        el.removeEventListener("pause", onPause);
        el.removeEventListener("error", onError);
      });
    });

    return () => cleanups.forEach((fn) => fn());
  }, [advanceToNextSegment, maybePreloadNext, saveProgress, showControls, ownerKind, ownerId]);

  // Manifest URLs expire — proactively refresh a bit before they do, so a
  // long first segment doesn't run into an expired *next* segment URL.
  useEffect(() => {
    if (!manifest) return;
    const msUntilExpiry = new Date(manifest.expiresAt).getTime() - Date.now();
    const refreshInMs = Math.max(msUntilExpiry - 60_000, 30_000);
    const timer = setTimeout(async () => {
      const seg = manifestRef.current!.segments[segIndexRef.current];
      const currentGlobal = seg.startSeconds + toLocalTime(seg, videoRefs.current[frontSlotRef.current]?.currentTime ?? 0);
      const res = await fetch(playManifestUrl(ownerKind, ownerId, manifestRef.current?.version)).catch(() => null);
      if (!res?.ok) return;
      const fresh: PlayManifest = await res.json();
      fresh.resumeSeconds = currentGlobal;
      manifestRef.current = fresh;
      // Note: we don't reset the currently-playing element (it's still
      // valid); this just refreshes the URLs used for the *next* preload.
    }, refreshInMs);
    return () => clearTimeout(timer);
  }, [manifest, ownerKind, ownerId]);

  const cues = tracks.find((t) => t.id === activeTrack)?.cues ?? null;
  const addTrack = useCallback((track: LoadedTrack) => {
    setTracks((all) => [...all, track]);
    setActiveTrack(track.id);
    setSubOffset(0);
  }, []);

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
      const elementTime = toElementTime(segment, localTime);
      if (front) front.currentTime = elementTime;
      // Seeking within the same (possibly trimmed) segment can move
      // playback back before its virtual end — re-arm so it can fire again.
      if (!crossedVirtualEnd(segment, elementTime)) virtualEndFiredRef.current = false;
      return;
    }

    // Seeking across a segment boundary: repoint the current front element
    // directly at the target segment (simpler than juggling the preload
    // slot during a manual seek).
    const front = videoRefs.current[frontSlotRef.current];
    if (!front) return;
    front.src = segment.url;
    const onLoaded = () => {
      front.currentTime = toElementTime(segment, localTime);
      if (wasPlaying) void front.play();
      front.removeEventListener("loadedmetadata", onLoaded);
    };
    front.addEventListener("loadedmetadata", onLoaded);
    segIndexRef.current = segment.index;
    preloadedForRef.current = null;
    virtualEndFiredRef.current = false;
    setGlobalTime(targetGlobal);
  }, [playing]);

  /** Seconds into the whole title right now, read from the element itself. */
  const currentGlobalTime = useCallback(() => {
    const m = manifestRef.current;
    const front = videoRefs.current[frontSlotRef.current];
    const seg = m?.segments[segIndexRef.current];
    return m && seg && front ? seg.startSeconds + toLocalTime(seg, front.currentTime) : 0;
  }, []);

  // A floating bar drives the player through these.
  useEffect(() => {
    if (!controlsRef) return;
    controlsRef.current = {
      toggle: togglePlay,
      skip(seconds) {
        const m = manifestRef.current;
        if (!m) return;
        seekTo(Math.max(0, Math.min(m.durationSeconds - 0.5, currentGlobalTime() + seconds)));
      },
      pause() {
        videoRefs.current[frontSlotRef.current]?.pause();
      },
    };
    return () => {
      controlsRef.current = null;
    };
  }, [controlsRef, togglePlay, seekTo, currentGlobalTime]);

  // ...and watches it through this.
  useEffect(() => {
    onStatus?.({ ready: !!manifest, playing, buffering, finished, error, time: globalTime, duration: manifest?.durationSeconds ?? 0 });
  }, [onStatus, manifest, playing, buffering, finished, error, globalTime]);

  // Closing the player, switching video or leaving the page saves where it got to (only if it ever played, and never over a finished title).
  useEffect(() => {
    const flush = () => {
      if (manifestRef.current && hasPlayedRef.current && !finishedRef.current) saveProgress(currentGlobalTime(), false);
    };
    flushRef.current = flush;
    window.addEventListener("pagehide", flush);
    return () => window.removeEventListener("pagehide", flush);
  }, [saveProgress, currentGlobalTime]);

  // Shrinking to the bar ends fullscreen.
  useEffect(() => {
    if (mode === "mini" && document.fullscreenElement) void document.exitFullscreen();
  }, [mode]);

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
    // Out of sight, the player must not take over the keyboard (Space, arrows and letters belong to the page now).
    if (mode === "mini") return;
    function onKeyDown(e: KeyboardEvent) {
      if (["INPUT", "TEXTAREA"].includes((e.target as HTMLElement)?.tagName)) return;
      const duration = manifestRef.current?.durationSeconds ?? 0;
      const clampTime = (t: number) => Math.max(0, Math.min(t, Math.max(duration - 0.5, 0)));
      switch (e.code) {
        case "Space":
        case "KeyK":
          e.preventDefault();
          togglePlay();
          break;
        case "ArrowRight":
        case "KeyL":
          seekTo(clampTime(globalTime + SKIP_SECONDS));
          break;
        case "ArrowLeft":
        case "KeyJ":
          seekTo(clampTime(globalTime - SKIP_SECONDS));
          break;
        case "ArrowUp":
          e.preventDefault();
          setMuted(false);
          setVolume((v) => Math.min(1, Math.round((v + 0.1) * 10) / 10));
          break;
        case "ArrowDown":
          e.preventDefault();
          setVolume((v) => Math.max(0, Math.round((v - 0.1) * 10) / 10));
          break;
        case "KeyM":
          setMuted((m) => !m);
          break;
        case "KeyC":
          if (e.ctrlKey || e.metaKey || e.altKey) break;
          // Subtitles off, or back on with the last one loaded in this viewing.
          if (activeTrack) setActiveTrack(null);
          else if (tracks.length) setActiveTrack(tracks[tracks.length - 1].id);
          break;
        case "KeyF":
          toggleFullscreen();
          break;
        default:
          return;
      }
      showControls();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [mode, globalTime, seekTo, togglePlay, toggleFullscreen, showControls, activeTrack, tracks]);

  useEffect(() => {
    videoRefs.current.forEach((el) => {
      if (!el) return;
      el.volume = volume;
      el.muted = muted;
    });
  }, [volume, muted]);

  // Speed goes on both elements, as the default too, so a segment loaded into either one later starts at the same speed.
  useEffect(() => {
    videoRefs.current.forEach((el) => {
      if (!el) return;
      el.defaultPlaybackRate = rate;
      el.playbackRate = rate;
    });
  }, [rate, frontSlot, manifest]);

  /** Switches to another resolution of the same title: same place in the film, same play/pause state. */
  const switchVersion = useCallback(
    async (label: string) => {
      const m = manifestRef.current;
      if (!m || label === m.version) return;
      const at = currentGlobalTime();
      const wasPlaying = !(videoRefs.current[frontSlotRef.current]?.paused ?? true);
      flushRef.current();
      const token = ++switchTokenRef.current;
      const res = await fetch(playManifestUrl(ownerKind, ownerId, label)).catch(() => null);
      if (!res || !res.ok) return; // staying on the version already playing is better than an error
      const data: PlayManifest = await res.json();
      if (manifestRef.current !== m || token !== switchTokenRef.current) return; // another video opened, or a newer switch was asked for
      writePreferredHeight(data.versions?.find((v) => v.label === data.version)?.height ?? null);
      data.resumeSeconds = Math.min(at, Math.max(0, data.durationSeconds - 1));
      resumePlayingRef.current = wasPlaying;
      // The old files stop now, so no late event from them is read against the new version's parts.
      videoRefs.current.forEach((el) => el?.pause());
      segIndexRef.current = 0;
      manifestRef.current = data;
      setManifest(data);
    },
    [ownerKind, ownerId, currentGlobalTime]
  );

  const changeRate = useCallback((speed: number) => {
    rateTouchedRef.current = true;
    setRate(clampSpeed(speed));
  }, []);

  if (error && !manifest && mode === "full") {
    return (
      <div className="flex h-dvh flex-col items-center justify-center gap-4 bg-black px-6 text-center">
        <p className="max-w-sm text-sm text-white/80">{error}</p>
        <Button render={<Link href={backHref} />} variant="secondary" className="rounded-xl">
          <ArrowLeft /> Go back
        </Button>
      </div>
    );
  }

  const duration = manifest?.durationSeconds ?? 0;
  const displayTime = scrubTime ?? globalTime;
  const progressPct = duration > 0 ? Math.min(100, (displayTime / duration) * 100) : 0;
  const controlsShown = controlsVisible || !playing || finished;
  const hideCursor = playing && !controlsShown && !finished;

  function ratioFromPointer(e: React.PointerEvent) {
    const rect = scrubBarRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return 0;
    return Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  }

  return (
    <div
      ref={containerRef}
      onMouseMove={showControls}
      onPointerDown={showControls}
      className={cn(
        mode === "full" ? "relative h-dvh w-full overflow-hidden bg-black select-none" : "pointer-events-none fixed top-0 left-0 size-px overflow-hidden opacity-0",
        mode === "full" && hideCursor && "cursor-none"
      )}
      aria-hidden={mode === "mini" || undefined}
      inert={mode === "mini" || undefined}
    >
      {[0, 1].map((slot) => (
        <video
          key={slot}
          ref={(el) => {
            videoRefs.current[slot as 0 | 1] = el;
          }}
          playsInline
          className="absolute inset-0 h-full w-full object-contain"
          style={{ visibility: frontSlot === slot ? "visible" : "hidden" }}
        />
      ))}

      {mode === "full" && cues && <SubtitleOverlay cues={cues} getTime={currentGlobalTime} offset={subOffset} lifted={controlsShown} />}

      {/* Click anywhere on the picture to play/pause; double-click for fullscreen. */}
      <div
        className="absolute inset-0"
        onClick={manifest && !finished ? togglePlay : undefined}
        onDoubleClick={manifest ? toggleFullscreen : undefined}
      />

      {/* Top bar */}
      <div
        className={cn(
          "pointer-events-none absolute inset-x-0 top-0 flex items-start gap-3 bg-gradient-to-b from-black/85 via-black/40 to-transparent px-4 pt-4 pb-14 transition-opacity duration-300 sm:px-6",
          controlsShown ? "opacity-100" : "opacity-0"
        )}
      >
        <Link
          href={backHref}
          aria-label="Back"
          tabIndex={controlsShown ? 0 : -1}
          className={cn(
            "flex size-10 shrink-0 items-center justify-center rounded-full bg-white/10 text-white backdrop-blur transition hover:bg-white/25",
            controlsShown && "pointer-events-auto"
          )}
        >
          <ArrowLeft className="size-5" />
        </Link>
        <div className="min-w-0 pt-0.5">
          <p className="truncate text-base font-semibold text-white drop-shadow sm:text-lg">
            {title}
          </p>
          {subtitle && (
            <p className="truncate text-sm text-white/70 drop-shadow">{subtitle}</p>
          )}
        </div>
      </div>

      {/* Center: loading / buffering / big play */}
      {!manifest && !error && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <Loader2 className="size-10 animate-spin text-white/70" />
        </div>
      )}
      {manifest && buffering && playing && !finished && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <Loader2 className="size-12 animate-spin text-white/80 drop-shadow-lg" />
        </div>
      )}
      {manifest && !playing && !finished && (
        <button
          type="button"
          onClick={togglePlay}
          aria-label="Play"
          className="absolute top-1/2 left-1/2 flex size-20 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-[0_10px_50px_-6px_oklch(0.853_0.163_169/0.6)] transition-transform hover:scale-105"
        >
          <Play className="ml-1 size-9" fill="currentColor" />
        </button>
      )}

      {finished && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-5 bg-black/85 px-6 text-center backdrop-blur-sm">
          <div>
            <p className="text-2xl font-semibold text-white">{title}</p>
            {subtitle && <p className="mt-1 text-white/60">{subtitle}</p>}
          </div>
          <div className="flex flex-wrap justify-center gap-3">
            <Button
              render={<Link href={backHref} />}
              variant="secondary"
              className="h-11 gap-2 rounded-xl bg-white/10 px-5 hover:bg-white/20"
            >
              <ArrowLeft /> Back to details
            </Button>
            {nextHref && (
              <Button render={<Link href={nextHref} />} className="h-11 gap-2 rounded-xl px-6">
                <SkipForward />
                {nextLabel ?? "Play next"}
              </Button>
            )}
          </div>
        </div>
      )}

      {/* Bottom controls */}
      <div
        className={cn(
          "pointer-events-none absolute inset-x-0 bottom-0 flex flex-col gap-1 bg-gradient-to-t from-black/90 via-black/55 to-transparent px-4 pt-20 pb-4 transition-opacity duration-300 sm:px-6",
          controlsShown ? "opacity-100" : "opacity-0",
          controlsShown && "[&>*]:pointer-events-auto"
        )}
      >
        {/* Scrubber */}
        <div
          ref={scrubBarRef}
          role="slider"
          aria-label="Seek"
          aria-valuemin={0}
          aria-valuemax={Math.round(duration)}
          aria-valuenow={Math.round(displayTime)}
          tabIndex={-1}
          className="group/scrub relative flex h-6 cursor-pointer touch-none items-center"
          onPointerDown={(e) => {
            if (!manifest) return;
            e.currentTarget.setPointerCapture(e.pointerId);
            setScrubTime(ratioFromPointer(e) * duration);
          }}
          onPointerMove={(e) => {
            const ratio = ratioFromPointer(e);
            setHoverRatio(ratio);
            if (scrubTime !== null) setScrubTime(ratio * duration);
          }}
          onPointerUp={(e) => {
            if (scrubTime === null) return;
            e.currentTarget.releasePointerCapture(e.pointerId);
            seekTo(ratioFromPointer(e) * duration);
            setScrubTime(null);
          }}
          onPointerLeave={() => setHoverRatio(null)}
        >
          <div
            className={cn(
              "relative w-full rounded-full bg-white/25 transition-[height] duration-150",
              scrubTime !== null ? "h-2" : "h-1 group-hover/scrub:h-2"
            )}
          >
            <div
              className="absolute inset-y-0 left-0 rounded-full bg-primary"
              style={{ width: `${progressPct}%` }}
            />
            {/* Where a multi-part title's files join — they play as one, but it's a nice landmark. */}
            {manifest?.segments.slice(1).map((seg) => (
              <span
                key={seg.index}
                className="absolute inset-y-0 w-0.5 bg-black/60"
                style={{ left: `${(seg.startSeconds / duration) * 100}%` }}
              />
            ))}
            <span
              className={cn(
                "absolute top-1/2 size-4 -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary shadow-lg ring-4 ring-primary/30 transition-transform",
                scrubTime !== null ? "scale-100" : "scale-0 group-hover/scrub:scale-100"
              )}
              style={{ left: `${progressPct}%` }}
            />
          </div>
          {hoverRatio !== null && duration > 0 && (
            <span
              className="pointer-events-none absolute -top-7 -translate-x-1/2 rounded-md bg-black/85 px-2 py-0.5 text-xs font-medium tabular-nums text-white ring-1 ring-white/15"
              style={{ left: `${hoverRatio * 100}%` }}
            >
              {formatTime(hoverRatio * duration)}
            </span>
          )}
        </div>

        <div className="flex items-center gap-1 text-white sm:gap-2">
          <Button
            variant="ghost"
            size="icon-lg"
            onClick={togglePlay}
            aria-label={playing ? "Pause" : "Play"}
            className="size-11 rounded-full hover:bg-white/15"
          >
            {playing ? (
              <Pause className="size-6" fill="currentColor" />
            ) : (
              <Play className="size-6" fill="currentColor" />
            )}
          </Button>

          <Button
            variant="ghost"
            size="icon-lg"
            aria-label="Back 10 seconds"
            onClick={() => seekTo(Math.max(0, globalTime - SKIP_SECONDS))}
            className="relative size-10 rounded-full hover:bg-white/15"
          >
            <RotateCcw className="size-[22px]" />
            <span className="absolute text-[9px] font-bold">10</span>
          </Button>
          <Button
            variant="ghost"
            size="icon-lg"
            aria-label="Forward 10 seconds"
            onClick={() => seekTo(Math.min(duration - 0.5, globalTime + SKIP_SECONDS))}
            className="relative size-10 rounded-full hover:bg-white/15"
          >
            <RotateCw className="size-[22px]" />
            <span className="absolute text-[9px] font-bold">10</span>
          </Button>

          <div className="group/vol flex items-center">
            <Button
              variant="ghost"
              size="icon-lg"
              aria-label={muted ? "Unmute" : "Mute"}
              onClick={() => setMuted((m) => !m)}
              className="size-10 rounded-full hover:bg-white/15"
            >
              {muted || volume === 0 ? (
                <VolumeX className="size-5" />
              ) : (
                <Volume2 className="size-5" />
              )}
            </Button>
            <div className="w-0 overflow-hidden px-0 transition-all duration-200 group-hover/vol:w-24 group-hover/vol:px-2 group-focus-within/vol:w-24 group-focus-within/vol:px-2">
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
          </div>

          <span className="ml-1 text-sm tabular-nums text-white/85">
            {formatTime(displayTime)}
            <span className="text-white/45"> / {formatTime(duration)}</span>
          </span>

          <div className="flex-1" />

          {nextHref && (
            <Button
              render={<Link href={nextHref} />}
              variant="ghost"
              className="hidden h-10 gap-2 rounded-full px-4 text-white hover:bg-white/15 sm:inline-flex"
            >
              <SkipForward className="size-4" />
              Next
            </Button>
          )}
          <SettingsMenu
            rate={rate}
            onRate={changeRate}
            defaultSpeed={manifest?.libraryId ? { libraryId: manifest.libraryId, saved: manifest.defaultRate ?? null } : undefined}
            ownerKind={ownerKind}
            ownerId={ownerId}
            tracks={tracks}
            activeTrack={activeTrack}
            onSelectTrack={setActiveTrack}
            onLoadedTrack={addTrack}
            subtitleOffset={subOffset}
            onSubtitleOffset={setSubOffset}
            qualities={manifest?.versions ?? []}
            quality={manifest?.version ?? ""}
            onQuality={(label) => void switchVersion(label)}
          />
          <Button
            variant="ghost"
            size="icon-lg"
            aria-label={isFullscreen ? "Exit fullscreen" : "Fullscreen"}
            onClick={toggleFullscreen}
            className="size-10 rounded-full hover:bg-white/15"
          >
            {isFullscreen ? <Minimize className="size-5" /> : <Maximize className="size-5" />}
          </Button>
        </div>
      </div>
    </div>
  );
}
