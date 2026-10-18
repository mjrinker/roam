"use client";

import { cameFrom } from "@/lib/player/previous-page";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  Loader2,
  Flag,
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
import { useDataSaverState } from "@/components/ui/data-saver-context";
import { AUTOPLAY_SECONDS, readAutoplay, writeAutoplay } from "@/lib/player/autoplay";
import { CastButton } from "@/components/player/cast-button";
import { useCast } from "@/components/player/use-cast";
import { airPlayUsable } from "@/lib/player/cast";
import { useWatchTogether } from "@/components/player/use-watch-together";
import { WatchTogetherButton } from "@/components/player/watch-together";
import { rememberLanguage, useEmbeddedTracks } from "@/components/player/use-embedded-tracks";
import { MarkPanel } from "@/components/player/mark-panel";
import { SkipButton } from "@/components/player/skip-button";
import { activeSkipButton, autoSkipNow, skipKey } from "@/lib/skipdb/active";
import { readPreferredHeight, readQualityMode, writePreferredHeight, writeQualityMode, type QualityMode } from "@/lib/player/quality-preference";
import { automaticHeight, conditionsNow } from "@/lib/player/automatic-quality";
import { applyLocalFiles, localVideoFor, offlineVideoManifest, openLocalFiles, type LocalFiles } from "@/lib/offline/local-playback";
import { queueProgress } from "@/lib/offline/sync";
import type { PlayManifest, PlayOwnerKind } from "@/lib/player/types";
import { unsupportedCodecsParam } from "@/lib/player/codec-query";
import {
  crossedVirtualEnd,
  remainingInSegment,
  toElementTime,
  toLocalTime,
  windowClampTarget,
} from "@/lib/player/timeline";
import { snapToChapter } from "@/lib/chapters/chapters";
import { holdPlace, readUnavailable, releasePlace, type Unavailable } from "@/lib/ownership/client";
import { UnavailableScreen } from "@/components/player/unavailable-screen";
import { isRemoved, removedRanges, toRealTime, toViewTime, viewDuration } from "@/lib/content-filter/timeline";

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
  /** Closes the player in place instead of going to `backHref` (a player shown over a list, such as a downloaded video). */
  onBack?: () => void;
  /** Shown as a button on the finished screen, e.g. linking to the next episode. */
  nextHref?: string;
  nextLabel?: string;
  /** Start here (seconds) instead of where the viewer left off, e.g. a chapter picked on the details page; `startToken` is new for each request. */
  startAt?: number;
  startToken?: number;
  /** Scenes to skip for this play only, on top of the profile's own ("violence:high,language:low"). */
  extraSkip?: string;
  /** A watch-together room to join (from the invite link). */
  room?: string;
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

/** "Next episode in 9": counts down on the finished screen, then goes on by itself unless cancelled. */
function NextCountdown({ href, label, onCancel }: { href: string; label: string; onCancel: () => void }) {
  const router = useRouter();
  const [left, setLeft] = useState(AUTOPLAY_SECONDS);
  useEffect(() => {
    if (left <= 0) {
      router.push(href);
      return;
    }
    const t = setTimeout(() => setLeft((n) => n - 1), 1000);
    return () => clearTimeout(t);
  }, [left, href, router]);
  return (
    <p className="flex items-center gap-3 text-sm text-white/80" aria-live="polite">
      <span>
        {label} in {Math.max(left, 0)}
      </span>
      <button type="button" onClick={onCancel} className="rounded-md px-2 py-1 text-white underline hover:bg-white/10">
        Cancel
      </button>
    </p>
  );
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
function playManifestUrl(ownerKind: PlayOwnerKind, ownerId: string, version?: string, extraSkip?: string, dataSaver?: "1" | "0" | null): string {
  const params = new URLSearchParams(unsupportedCodecsParam());
  if (extraSkip) params.set("skip", extraSkip);
  // This device's own choice about data saver (absent: the profile's setting applies).
  if (dataSaver) params.set("dataSaver", dataSaver);
  // Which resolution: the one asked for; else Original (the best, even with data saver on) or Automatic (fitted to this screen and
  // connection) when this device chose that; else the one closest to what it last picked; else the best the title has.
  const mode = readQualityMode();
  if (version !== undefined) params.set("version", version);
  else if (mode === "original") params.set("quality", "original");
  else if (mode === "auto") params.set("height", String(automaticHeight(conditionsNow(dataSaver === "1"))));
  else {
    const height = readPreferredHeight();
    if (height !== null) params.set("height", String(height));
  }
  const query = params.toString();
  return `/api/play/${ownerKind}/${ownerId}${query ? `?${query}` : ""}`;
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
  onBack,
  nextHref,
  nextLabel,
  startAt,
  startToken,
  extraSkip,
  room,
}: SeamlessPlayerProps) {
  // A movie takes over: pause any audiobook that's playing in the background.
  const audioActions = useAudioActions();
  useEffect(() => {
    audioActions?.pause();
  }, [audioActions]);

  const router = useRouter();
  const containerRef = useRef<HTMLDivElement>(null);
  const videoRefs = useRef<[HTMLVideoElement | null, HTMLVideoElement | null]>([
    null,
    null,
  ]);

  const manifestRef = useRef<PlayManifest | null>(null);
  const [manifest, setManifest] = useState<PlayManifest | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The server tracks who owns what, and no copy of this can be played now (withdrawn, or all being played); retry bumps to ask again.
  const [unavailable, setUnavailable] = useState<Unavailable | null>(null);
  const [retryKey, setRetryKey] = useState(0);
  const retry = useCallback(() => setRetryKey((k) => k + 1), []);

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
  // Going on to the next episode by itself (a choice kept on this device), and whether this ending's countdown was cancelled.
  const [autoplay, setAutoplay] = useState(() => (typeof window === "undefined" ? true : readAutoplay()));
  const [cancelledFor, setCancelledFor] = useState<PlayManifest | null>(null);
  /** The touch now happening found the controls hidden: it only reveals them (see the container's pointer-down). */
  const revealingTap = useRef(false);
  // Screen time: the seconds of watching left (from the manifest) run down while playing; at zero the picture stops.
  const [screenSpent, setScreenSpent] = useState<{ m: PlayManifest | null; n: number }>({ m: null, n: 0 });
  const screenLimit = manifest?.screenTime?.stopInSeconds ?? null;
  const screenLeft = screenLimit === null ? null : screenLimit - (screenSpent.m === manifest ? screenSpent.n : 0);
  const screenUp = screenLeft !== null && screenLeft <= 0;
  useEffect(() => {
    if (!playing || screenLimit === null || mode !== "full") return;
    const t = setInterval(() => setScreenSpent((s) => ({ m: manifest, n: (s.m === manifest ? s.n : 0) + 1 })), 1000);
    return () => clearInterval(t);
  }, [playing, screenLimit, manifest, mode]);
  useEffect(() => {
    if (screenUp) videoRefs.current.forEach((el) => el?.pause());
  }, [screenUp]);
  const changeAutoplay = useCallback((on: boolean) => {
    writeAutoplay(on);
    setAutoplay(on);
  }, []);
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
  // The downloaded files this video is playing from, if any (their addresses are let go when the video changes).
  const localFilesRef = useRef<LocalFiles | null>(null);
  const switchTokenRef = useRef(0);
  // The viewer pressed back and the page behind is still loading.
  const [leaving, setLeaving] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(true);
  const controlsShownRef = useRef(true);
  useEffect(() => {
    controlsShownRef.current = controlsVisible || !playing || finished;
  }, [controlsVisible, playing, finished]);
  const [hoverRatio, setHoverRatio] = useState<number | null>(null);
  const [hoverChapter, setHoverChapter] = useState<string | null>(null);
  // One message when playback starts if filtering this viewer asked for couldn't be applied (never about scenes that were skipped).
  const [notice, setNotice] = useState<string | null>(null);
  // The panel an admin marks scenes in while watching.
  const [markOpen, setMarkOpen] = useState(false);

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

  // A chapter asked for while this video is already open (from its details page, with the bar showing) is a seek, not a reload.
  const startAtRef = useRef(startAt);
  const startTokenRef = useRef(startToken);
  const handledStartRef = useRef<number | undefined>(undefined);
  const extraSkipRef = useRef(extraSkip);
  // This device's own data saver choice, sent with every manifest request (absent: the profile's setting).
  const dataSaverParamRef = useRef<"1" | "0" | null>(null);
  const saver = useDataSaverState();
  useEffect(() => {
    dataSaverParamRef.current = saver.param;
  }, [saver.param]);
  useEffect(() => {
    startAtRef.current = startAt;
    startTokenRef.current = startToken;
    extraSkipRef.current = extraSkip;
  }, [startAt, startToken, extraSkip]);

  // ── Load the manifest ─────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    const videos = videoRefs.current; // the same two-slot list for the player's whole life
    (async () => {
      // A downloaded copy is played from this device. When there is a connection the server is still asked (for where the viewer left
      // off, the speed and the other versions), for the downloaded version; with none, what was saved is enough.
      const downloaded = await localVideoFor(ownerKind, ownerId).catch(() => null);
      const res = await fetch(playManifestUrl(ownerKind, ownerId, downloaded?.version, extraSkipRef.current, dataSaverParamRef.current)).catch(() => null);
      if (cancelled) return;
      let data: PlayManifest;
      if (res && res.ok) {
        data = await res.json();
        const files = await applyLocalFiles(data).catch(() => null);
        if (cancelled) return files?.release();
        localFilesRef.current?.release();
        localFilesRef.current = files;
      } else if (downloaded && (!res || res.status >= 500 || res.status === 401)) {
        const files = await openLocalFiles(downloaded).catch(() => null);
        const offline = files ? await offlineVideoManifest(downloaded, files) : null;
        if (cancelled) return files?.release();
        if (!files || !offline) {
          setError("This download can't be opened. Remove it and download it again.");
          return;
        }
        localFilesRef.current?.release();
        localFilesRef.current = files;
        data = offline;
      } else {
        const blocked = await readUnavailable(res);
        if (cancelled) return;
        if (blocked) {
          setUnavailable(blocked);
          return;
        }
        const body = res ? await res.json().catch(() => ({})) : {};
        setError(body.error ?? (res ? "This can't be played right now." : "You're offline, and this isn't downloaded."));
        return;
      }
      // Opened at a chosen chapter: that, not where the viewer left off.
      if (startAtRef.current != null) {
        data.resumeSeconds = Math.max(0, Math.min(startAtRef.current, Math.max(0, data.durationSeconds - 1)));
        handledStartRef.current = startTokenRef.current;
      }
      setUnavailable(null);
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
      localFilesRef.current?.release();
      localFilesRef.current = null;
    };
  }, [ownerKind, ownerId, retryKey]);

  // ── Hold this player's place (when the server limits playing at once) ──
  const playingRef = useRef(false);
  useEffect(() => {
    playingRef.current = playing;
  }, [playing]);
  const holdsPlace = !!manifest?.heartbeat;
  useEffect(() => {
    if (!holdsPlace) return;
    return holdPlace(
      ownerKind,
      ownerId,
      () => !playingRef.current,
      (lost) => {
        // The place was lost (an owner withdrew their copy): stop and say so.
        videoRefs.current.forEach((el) => el?.pause());
        setUnavailable(lost);
        setManifest(null);
      }
    );
  }, [holdsPlace, ownerKind, ownerId]);
  useEffect(() => {
    const leave = () => releasePlace();
    if (!holdsPlace) return;
    window.addEventListener("pagehide", leave);
    return () => window.removeEventListener("pagehide", leave);
  }, [holdsPlace]);

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
      // A trailer or other extra never keeps a place.
      if (!m || m.ownerKind === "extra") return;
      const payload = JSON.stringify({
        ownerKind: m.ownerKind,
        ownerId: m.ownerId,
        positionSeconds: Math.floor(positionSeconds),
        durationSeconds: Math.floor(m.durationSeconds),
        finished: isFinished,
      });
      // With no connection the progress waits on this device and is sent once there is one.
      if (typeof navigator !== "undefined" && !navigator.onLine) {
        void queueProgress({ ownerKind: m.ownerKind, ownerId: m.ownerId, positionSeconds: Math.floor(positionSeconds), durationSeconds: Math.floor(m.durationSeconds), finished: isFinished });
        return;
      }
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
        fetch(playManifestUrl(ownerKind, ownerId, manifestRef.current?.version, extraSkipRef.current, dataSaverParamRef.current))
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
    if (localFilesRef.current) return; // files on this device don't expire
    const msUntilExpiry = new Date(manifest.expiresAt).getTime() - Date.now();
    const refreshInMs = Math.max(msUntilExpiry - 60_000, 30_000);
    const timer = setTimeout(async () => {
      const seg = manifestRef.current!.segments[segIndexRef.current];
      const currentGlobal = seg.startSeconds + toLocalTime(seg, videoRefs.current[frontSlotRef.current]?.currentTime ?? 0);
      const res = await fetch(playManifestUrl(ownerKind, ownerId, manifestRef.current?.version, extraSkipRef.current, dataSaverParamRef.current)).catch(() => null);
      if (!res?.ok) return;
      const fresh: PlayManifest = await res.json();
      fresh.resumeSeconds = currentGlobal;
      manifestRef.current = fresh;
      // Note: we don't reset the currently-playing element (it's still
      // valid); this just refreshes the URLs used for the *next* preload.
    }, refreshInMs);
    return () => clearTimeout(timer);
  }, [manifest, ownerKind, ownerId]);

  // Languages and subtitles inside the video's own files.
  const currentSegment = manifest ? findSegment(manifest, globalTime).segment : null;
  const getFrontVideo = useCallback(() => videoRefs.current[frontSlotRef.current], []);
  const embedded = useEmbeddedTracks({ manifest, ownerKind, ownerId, segment: currentSegment, globalTime, frontVideo: getFrontVideo, frontSlot, volume, prefs: manifest?.languagePrefs });
  const allTracks = [...embedded.embeddedTracks, ...tracks];
  const cues = allTracks.find((t) => t.id === activeTrack)?.cues ?? null;
  const selectTrack = useCallback(
    (id: string | null, remember = true) => {
      // The language of an embedded track is remembered for the next video; turning subtitles off after one forgets it. A subtitle file the
      // viewer loaded themselves is for this viewing only.
      if (remember) {
        const picked = embedded.embeddedTracks.find((e) => e.id === id)?.embedded?.language;
        const was = embedded.embeddedTracks.find((e) => e.id === activeTrack);
        if (picked) rememberLanguage({ subtitles: picked });
        else if (id === null && was) rememberLanguage({ subtitles: null });
      }
      const t = embedded.embeddedTracks.find((e) => e.id === id);
      if (t?.embedded && !t.embedded.loaded) {
        void (t.embedded.trackId ? embedded.loadSaved(t.embedded.trackId) : embedded.loadText(t.embedded.language)).then((ok) => {
          if (ok) {
            setActiveTrack(id);
            setSubOffset(0);
          }
        });
        return;
      }
      setActiveTrack(id);
    },
    [embedded, activeTrack]
  );
  // A new video turns the profile's subtitles on by itself once, when the file has them.
  const subtitlesAppliedFor = useRef<PlayManifest | null>(null);
  useEffect(() => {
    if (!manifest || !embedded.preferredText || subtitlesAppliedFor.current === manifest) return;
    subtitlesAppliedFor.current = manifest;
    selectTrack(embedded.preferredText, false);
  }, [manifest, embedded.preferredText, selectTrack]);
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

  // A chapter chosen while this video is already open: go there and play. (A video opened at a chapter starts there from the manifest.)
  useEffect(() => {
    if (!manifest || startAt == null || startToken === handledStartRef.current) return;
    handledStartRef.current = startToken;
    seekTo(Math.max(0, Math.min(startAt, Math.max(0, manifest.durationSeconds - 1))));
    void videoRefs.current[frontSlotRef.current]?.play().catch(() => {});
  }, [manifest, startAt, startToken, seekTo]);

  /** Seconds into the whole title right now, read from the element itself. */
  const currentGlobalTime = useCallback(() => {
    const m = manifestRef.current;
    const front = videoRefs.current[frontSlotRef.current];
    const seg = m?.segments[segIndexRef.current];
    return m && seg && front ? seg.startSeconds + toLocalTime(seg, front.currentTime) : 0;
  }, []);

  // Watching together: a room (from an invite link, or one the viewer starts) keeps this player in step with the others.
  const [roomId, setRoomId] = useState<string | null>(room ?? null);
  const [roomNotice, setRoomNotice] = useState<string | null>(null);
  const roomLocal = useCallback(() => {
    const front = videoRefs.current[frontSlotRef.current];
    return manifestRef.current && front ? { playing: !front.paused, time: currentGlobalTime() } : null;
  }, [currentGlobalTime]);
  const roomApply = useCallback(
    async (playing: boolean, position: number) => {
      const front = videoRefs.current[frontSlotRef.current];
      if (!front || !manifestRef.current) return false;
      if (Math.abs(currentGlobalTime() - position) > 1.5) seekTo(Math.max(0, Math.min(position, manifestRef.current.durationSeconds - 0.5)));
      if (playing && front.paused) {
        try {
          await front.play();
        } catch {
          // The browser wants a press before it will start sound: the viewer presses play and joins in.
          setRoomNotice("Press play to join in.");
          return false;
        }
      } else if (!playing && !front.paused) front.pause();
      setRoomNotice(null);
      return true;
    },
    [currentGlobalTime, seekTo]
  );
  // Casting: the picture goes to a Chromecast (and its place comes back here when it stops), or to an AirPlay screen in Safari.
  const cast = useCast({
    manifest,
    enabled: mode === "full" && ownerKind !== "extra",
    title,
    getTime: currentGlobalTime,
    pauseLocal: () => videoRefs.current.forEach((el) => el?.pause()),
    resumeLocal: (at) => seekTo(Math.max(0, Math.min(at, (manifestRef.current?.durationSeconds ?? at) - 0.5))),
  });
  // While casting, where it got to is kept as the place (a quarter of a minute apart).
  const castTime = cast.casting?.time ?? null;
  const castSavedAt = useRef(0);
  useEffect(() => {
    if (castTime === null || Date.now() - castSavedAt.current < 15_000) return;
    castSavedAt.current = Date.now();
    saveProgress(castTime, false);
  }, [castTime, saveProgress]);
  const together = useWatchTogether({
    roomId: mode === "full" ? roomId : null,
    getLocal: roomLocal,
    apply: roomApply,
    onEnded: (why) => {
      setRoomId(null);
      setRoomNotice(why === "full" ? "That room is full." : "That watch-together room has ended.");
    },
  });

  // Scenes this viewer chose to skip or silence (see lib/content-filter): checked ten times a second, so a skip lands within a tenth of a
  // second of the scene's start (the element's own time updates come only about four times a second).
  useEffect(() => {
    const text = manifest?.notice ?? null;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- a message that appears with a newly loaded video and clears itself
    setNotice(text);
    if (!text) return;
    const id = setTimeout(() => setNotice(null), 7000);
    return () => clearTimeout(id);
  }, [manifest]);

  // A profile that skips intros, recaps, credits or previews by itself: each part once per play, as it starts (going back into one is the viewer's choice).
  const autoSkipped = useRef<Set<string>>(new Set());
  useEffect(() => {
    autoSkipped.current = new Set();
  }, [manifest]);
  useEffect(() => {
    if (!manifest?.autoSkip) return;
    const state = autoSkipNow(activeSkipButton(manifest.skipSegments, globalTime, manifest.durationSeconds, !!nextHref), manifest.autoSkip, autoSkipped.current);
    if (!state) return;
    autoSkipped.current.add(skipKey(state));
    if (state.action === "next") {
      if (nextHref) router.push(nextHref);
    } else seekTo(state.toSeconds ?? 0);
  }, [manifest, globalTime, nextHref, router, seekTo]);
  const mutedRef = useRef(muted);
  useEffect(() => {
    mutedRef.current = muted;
  }, [muted]);
  useEffect(() => {
    const skips = manifest?.skips;
    if (!skips || skips.length === 0) return;
    const videos = videoRefs.current;
    let silenced = false;
    let last: { end: number; at: number } | null = null;
    const id = setInterval(() => {
      const m = manifestRef.current;
      const front = videoRefs.current[frontSlotRef.current];
      if (!m || !front) return;
      const gt = currentGlobalTime();
      const hit = skips.find((s) => gt >= s.startSeconds - 0.02 && gt < s.endSeconds - 0.02);
      if (hit?.action === "skip" && (!last || last.end !== hit.endSeconds || Date.now() - last.at > 1000)) {
        last = { end: hit.endSeconds, at: Date.now() };
        seekTo(Math.min(hit.endSeconds, Math.max(0, m.durationSeconds - 0.5)));
        return;
      }
      const wantSilence = hit?.action === "mute";
      if (wantSilence && !silenced) {
        silenced = true;
        front.muted = true;
      } else if (!wantSilence && silenced) {
        silenced = false;
        front.muted = mutedRef.current;
      }
    }, 100);
    return () => {
      clearInterval(id);
      if (silenced) videos.forEach((el) => el && (el.muted = mutedRef.current));
    };
  }, [manifest, currentGlobalTime, seekTo]);

  // A floating bar drives the player through these.
  useEffect(() => {
    if (!controlsRef) return;
    controlsRef.current = {
      toggle: togglePlay,
      skip(seconds) {
        const m = manifestRef.current;
        if (!m) return;
        // Measured on the bar the viewer sees, without the scenes they skip.
        const removed = removedRanges(m.skips);
        const viewNow = toViewTime(currentGlobalTime(), removed);
        seekTo(toRealTime(Math.max(0, Math.min(viewDuration(m.durationSeconds, removed) - 0.5, viewNow + seconds)), removed));
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
    onStatus?.({ ready: !!manifest, playing, buffering, finished, error: error ?? unavailable?.error ?? null, time: toViewTime(globalTime, removedRanges(manifest?.skips)), duration: viewDuration(manifest?.durationSeconds ?? 0, removedRanges(manifest?.skips)) });
  }, [onStatus, manifest, playing, buffering, finished, error, unavailable, globalTime]);

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
      if (["INPUT", "TEXTAREA", "SELECT"].includes((e.target as HTMLElement)?.tagName)) return;
      // Steps are measured on the bar the viewer sees, without the scenes they skip.
      const removed = removedRanges(manifestRef.current?.skips);
      const duration = viewDuration(manifestRef.current?.durationSeconds ?? 0, removed);
      const stepFrom = (seconds: number) => toRealTime(Math.max(0, Math.min(toViewTime(globalTime, removed) + seconds, Math.max(duration - 0.5, 0))), removed);
      switch (e.code) {
        case "Space":
        case "KeyK":
          e.preventDefault();
          togglePlay();
          break;
        case "ArrowRight":
        case "KeyL":
          seekTo(stepFrom(SKIP_SECONDS));
          break;
        case "ArrowLeft":
        case "KeyJ":
          seekTo(stepFrom(-SKIP_SECONDS));
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
      // Another language plays on its own element (see use-embedded-tracks), so the picture's own sound is turned all the way down.
      el.volume = embedded.altAudioActive ? 0 : volume;
      el.muted = muted;
    });
  }, [volume, muted, embedded.altAudioActive, frontSlot]);

  // Speed goes on both elements, as the default too, so a segment loaded into either one later starts at the same speed.
  useEffect(() => {
    videoRefs.current.forEach((el) => {
      if (!el) return;
      el.defaultPlaybackRate = rate;
      el.playbackRate = rate;
    });
  }, [rate, frontSlot, manifest]);

  /** Switches to another resolution of the same title: same place in the film, same play/pause state. */
  const [qualityMode, setQualityMode] = useState<QualityMode>(() => (typeof window === "undefined" ? "pick" : readQualityMode()));
  const switchVersion = useCallback(
    async (choice: string) => {
      const m = manifestRef.current;
      if (!m) return;
      // "@auto" and "@original" are the two ways of letting the player choose; anything else is a version picked by hand.
      const special = choice === "@auto" ? "auto" : choice === "@original" ? "original" : null;
      const label = special ? undefined : choice;
      if (special) {
        writeQualityMode(special);
        setQualityMode(special);
      } else {
        const picked = m.versions?.find((v) => v.label === choice)?.height ?? null;
        writePreferredHeight(picked);
        setQualityMode("pick");
        if (choice === m.version) return;
      }
      const at = currentGlobalTime();
      const wasPlaying = !(videoRefs.current[frontSlotRef.current]?.paused ?? true);
      flushRef.current();
      const token = ++switchTokenRef.current;
      const res = await fetch(playManifestUrl(ownerKind, ownerId, label, extraSkipRef.current, dataSaverParamRef.current)).catch(() => null);
      if (!res || !res.ok) return; // staying on the version already playing is better than an error
      const data: PlayManifest = await res.json();
      if (special && data.version === m.version) return; // the choice is kept, and it is the version already playing
      if (manifestRef.current !== m || token !== switchTokenRef.current) return; // another video opened, or a newer switch was asked for
      const files = await applyLocalFiles(data).catch(() => null); // the chosen version may be one that is downloaded
      localFilesRef.current?.release();
      localFilesRef.current = files;
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

  if (unavailable && !manifest && mode === "full") {
    return <UnavailableScreen info={unavailable} backHref={backHref} onRetry={retry} />;
  }

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

  // The bar and the times shown are measured without the scenes this viewer skips; seeking and saving still use the video's own clock.
  const removed = removedRanges(manifest?.skips);
  const duration = viewDuration(manifest?.durationSeconds ?? 0, removed);
  const viewChapters = (manifest?.chapters ?? [])
    .filter((c) => !isRemoved(c.startSeconds, removed))
    .map((c) => ({ title: c.title, startSeconds: toViewTime(c.startSeconds, removed), real: c.startSeconds }));
  const viewNow = toViewTime(globalTime, removed);
  const skipButton = activeSkipButton(manifest?.skipSegments, globalTime, manifest?.durationSeconds ?? 0, !!nextHref);
  const displayTime = scrubTime ?? viewNow;
  const progressPct = duration > 0 ? Math.min(100, (displayTime / duration) * 100) : 0;
  const controlsShown = controlsVisible || !playing || finished;

  const hideCursor = playing && !controlsShown && !finished;

  function ratioFromPointer(e: React.PointerEvent) {
    const rect = scrubBarRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return 0;
    return Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  }

  /** Where the pointer is on the bar: the time on the bar (view) and in the video (real), pulled onto a chapter mark when close to one. */
  function pointerTarget(e: React.PointerEvent) {
    const width = scrubBarRef.current?.getBoundingClientRect().width ?? 0;
    const snap = snapToChapter(ratioFromPointer(e) * duration, viewChapters, duration, width);
    return { view: snap.time, real: snap.chapter ? snap.chapter.real : toRealTime(snap.time, removed), chapter: snap.chapter };
  }

  return (
    <div
      ref={containerRef}
      onMouseMove={showControls}
      onPointerDown={(e) => {
        // A touch that finds the controls hidden only brings them back: it must not also press whatever was under the finger (play or pause).
        revealingTap.current = e.pointerType === "touch" && !controlsShownRef.current;
        showControls();
      }}
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
        onClick={
          manifest && !finished
            ? () => {
                if (revealingTap.current) {
                  revealingTap.current = false;
                  return;
                }
                togglePlay();
              }
            : undefined
        }
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
          onClick={(e) => {
            // Going back answers at once: the screen says so while the page behind it loads.
            if (onBack) {
              e.preventDefault();
              onBack();
              return;
            }
            setLeaving(true);
            setTimeout(() => setLeaving(false), 8000);
            // Came from that page: step back to it rather than adding it to the history again.
            if (cameFrom(backHref)) {
              e.preventDefault();
              window.history.back();
            }
          }}
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

      {leaving && (
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-black">
          <Loader2 className="size-10 animate-spin text-white/70" />
        </div>
      )}

      {/* Center: loading / buffering / big play */}
      {!manifest && !error && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <Loader2 className="size-10 animate-spin text-white/70" />
        </div>
      )}
      {mode === "full" && skipButton && !finished && !markOpen && <SkipButton state={skipButton} nextHref={nextHref} onSeek={seekTo} />}
      {mode === "full" && markOpen && manifest?.canMark && ownerKind !== "extra" && (
        <MarkPanel
          ownerKind={ownerKind}
          ownerId={ownerId}
          version={manifest.version ?? ""}
          getTime={currentGlobalTime}
          seekTo={seekTo}
          pause={() => videoRefs.current[frontSlotRef.current]?.pause()}
          onClose={() => setMarkOpen(false)}
        />
      )}
      {mode === "full" && notice && (
        <div role="status" className="pointer-events-none absolute top-20 left-1/2 z-10 w-[min(90vw,28rem)] -translate-x-1/2 rounded-xl bg-black/85 px-4 py-2.5 text-center text-sm text-white ring-1 ring-white/15">
          {notice}
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

      {cast.casting && (
        <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-4 bg-black/90 px-6 text-center" role="status" aria-label="Casting">
          <p className="text-xl font-semibold text-white">Playing on {cast.casting.device}</p>
          <p className="text-sm text-white/70">{formatTime(cast.casting.time)} of {formatTime(manifest?.durationSeconds ?? 0)}</p>
          <div className="flex gap-3">
            <Button variant="secondary" className="h-11 rounded-xl bg-white/10 px-5 hover:bg-white/20" onClick={cast.togglePause}>
              {cast.casting.playing ? "Pause" : "Play"}
            </Button>
            <Button variant="secondary" className="h-11 rounded-xl bg-white/10 px-5 hover:bg-white/20" onClick={cast.stop}>
              Stop casting
            </Button>
          </div>
        </div>
      )}
      {screenUp && !finished && (
        <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-4 bg-black/90 px-6 text-center" role="alertdialog" aria-label="Screen time">
          <p className="text-2xl font-semibold text-white">Time to take a break</p>
          <p className="max-w-sm text-sm text-white/70">Screen time is up for now. You can come back later.</p>
          <Button render={<Link href={backHref} />} variant="secondary" className="h-11 gap-2 rounded-xl bg-white/10 px-5 hover:bg-white/20">
            <ArrowLeft /> Back
          </Button>
        </div>
      )}
      {mode === "full" && screenLeft !== null && screenLeft > 0 && screenLeft <= 60 && playing && (
        <p className="pointer-events-none absolute top-4 left-1/2 z-10 -translate-x-1/2 rounded-full bg-black/70 px-4 py-1.5 text-sm text-white" role="status">
          {screenLeft <= 10 ? `${screenLeft} seconds left` : "About a minute of screen time left"}
        </p>
      )}
      {finished && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-5 bg-black/85 px-6 text-center backdrop-blur-sm">
          <div>
            <p className="text-2xl font-semibold text-white">{title}</p>
            {subtitle && <p className="mt-1 text-white/60">{subtitle}</p>}
          </div>
          {nextHref && autoplay && cancelledFor !== manifest && mode === "full" && <NextCountdown href={nextHref} label={nextLabel ?? "Next up"} onCancel={() => setCancelledFor(manifest)} />}
          <div className="flex flex-wrap justify-center gap-3">
            <Button
              render={
                <Link
                  href={backHref}
                  onClick={(e) => {
                    if (onBack) {
                      e.preventDefault();
                      onBack();
                    } else {
                      setLeaving(true);
                      if (cameFrom(backHref)) {
                        e.preventDefault();
                        window.history.back();
                      }
                    }
                  }}
                />
              }
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
            setScrubTime(pointerTarget(e).view);
          }}
          onPointerMove={(e) => {
            const target = pointerTarget(e);
            setHoverRatio(duration > 0 ? target.view / duration : 0);
            setHoverChapter(target.chapter?.title ?? null);
            if (scrubTime !== null) setScrubTime(target.view);
          }}
          onPointerUp={(e) => {
            if (scrubTime === null) return;
            e.currentTarget.releasePointerCapture(e.pointerId);
            seekTo(pointerTarget(e).real);
            setScrubTime(null);
          }}
          onPointerLeave={() => {
            setHoverRatio(null);
            setHoverChapter(null);
          }}
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
            {/* Chapter marks. (Where a multi-part title's files join is not marked: that is not a chapter.) */}
            {duration > 0 &&
              viewChapters.filter((c) => c.startSeconds > 0.5).map((c) => (
                <span
                  key={c.startSeconds}
                  aria-hidden="true"
                  className="absolute inset-y-0 w-[3px] -translate-x-1/2 bg-black/70"
                  style={{ left: `${(c.startSeconds / duration) * 100}%` }}
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
              {hoverChapter ? `${hoverChapter} · ` : ""}
              {formatTime(hoverRatio * duration)}
            </span>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-x-1 gap-y-0 text-white sm:gap-x-2">
         <div className="flex items-center gap-0.5 sm:gap-2">
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
            onClick={() => seekTo(toRealTime(Math.max(0, viewNow - SKIP_SECONDS), removed))}
            className="relative size-10 rounded-full hover:bg-white/15"
          >
            <RotateCcw className="size-[22px]" />
            <span className="absolute text-[9px] font-bold">10</span>
          </Button>
          <Button
            variant="ghost"
            size="icon-lg"
            aria-label="Forward 10 seconds"
            onClick={() => seekTo(toRealTime(Math.min(duration - 0.5, viewNow + SKIP_SECONDS), removed))}
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

         </div>
         <div className="ml-auto flex items-center gap-0.5 max-sm:w-full max-sm:justify-end sm:gap-2">
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
          {manifest?.canMark && ownerKind !== "extra" && (
            <Button
              variant="ghost"
              size="icon-lg"
              aria-label="Mark a scene"
              aria-pressed={markOpen}
              onClick={() => setMarkOpen((o) => !o)}
              className="size-10 rounded-full hover:bg-white/15"
            >
              <Flag className="size-5" />
            </Button>
          )}
          {mode === "full" && ownerKind !== "extra" && (
            <CastButton
              available={cast.available}
              airPlay={airPlayUsable(manifest, typeof HTMLVideoElement === "undefined" ? null : (HTMLVideoElement.prototype as { webkitShowPlaybackTargetPicker?: unknown }))}
              problem={cast.problem}
              onCast={() => void cast.start()}
              onAirPlay={() => (videoRefs.current[frontSlotRef.current] as unknown as { webkitShowPlaybackTargetPicker: () => void } | null)?.webkitShowPlaybackTargetPicker()}
            />
          )}
          {mode === "full" && ownerKind !== "extra" && (
            <WatchTogetherButton roomId={roomId} watching={together.watching} ownerKind={ownerKind} ownerId={ownerId} notice={roomNotice} onStart={setRoomId} onLeave={() => setRoomId(null)} />
          )}
          <SettingsMenu
            rate={rate}
            onRate={changeRate}
            defaultSpeed={manifest?.libraryId ? { libraryId: manifest.libraryId, saved: manifest.defaultRate ?? null } : undefined}
            ownerKind={ownerKind}
            ownerId={ownerId}
            tracks={allTracks}
            activeTrack={activeTrack}
            onSelectTrack={selectTrack}
            autoplay={nextHref ? autoplay : undefined}
            onAutoplay={changeAutoplay}
            canKeepSubtitles={manifest?.canMark}
            audioOptions={embedded.audioOptions}
            audioIndex={embedded.selectedAudio}
            onAudio={embedded.selectAudio}
            audioProblem={embedded.audioProblem}
            onLoadedTrack={addTrack}
            subtitleOffset={subOffset}
            onSubtitleOffset={setSubOffset}
            qualities={manifest?.versions ?? []}
            quality={manifest?.version ?? ""}
            qualityMode={qualityMode}
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
    </div>
  );
}
