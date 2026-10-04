"use client";

import {
  createContext,
  useContext,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";
import { useRouter } from "next/navigation";
import {
  chapterEnd,
  chapterIndexAt,
  clampRate,
  findSegmentAt,
  isEffectivelyFinished,
} from "@/lib/player/timeline";
import type { AudiobookManifest, AudiobookSegmentUrl } from "@/lib/player/types";
import { shouldContinueQueue, type BookQueue } from "@/components/audio/queue-handoff";

// One <audio> element for the whole book, mounted above the pages so audio
// keeps playing as you browse. A single element (rather than the video
// player's two-element swap) is deliberate: iOS only lets an element that
// has already been unlocked by a tap keep playing in the background, so
// moving to the next part means swapping `src` on the same element.

export const SKIP_BACK_SECONDS = 15;
export const SKIP_FORWARD_SECONDS = 30;

const URL_MIN_REMAINING_MS = 30_000; // don't trust a URL with less than this left
const PRELOAD_NEXT_URL_SECONDS = 30; // mint the next part's URL this early
const PROGRESS_SAVE_INTERVAL_MS = 15_000;
const POSITION_STATE_INTERVAL_MS = 5_000;
const MAX_RECOVERY_ATTEMPTS = 3;
// Per profile, so two people on one device don't share a speed.
const rateStorageKey = (viewerId: string) => `roam-playback-rate:${viewerId}`;

export type AudioBook = Omit<AudiobookManifest, "urls" | "resumeSeconds">;
export type SleepTimer =
  | { kind: "minutes"; endsAt: number }
  | { kind: "chapter"; endsAtSeconds: number }
  | null;
export type SleepRequest = { minutes: number } | "chapter" | null;
export type PlayerStatus = "idle" | "loading" | "paused" | "playing" | "finished" | "error";

export interface AudioPlayerState {
  book: AudioBook | null;
  status: PlayerStatus;
  error: string | null;
  buffering: boolean;
  /** Seconds into the whole book (across every part). */
  position: number;
  rate: number;
  sleep: SleepTimer;
  /** Whole minutes left on a timed sleep timer (kept current while playing); null otherwise. */
  sleepMinutesLeft: number | null;
  /** Index of the current chapter, or -1 if the book has none. */
  chapterIndex: number;
}

export interface AudioPlayerActions {
  /** Loads a book (resuming where the user left off unless `startAt` is given). */
  load(
    titleId: string,
    opts?: { autoplay?: boolean; startAt?: number; queue?: BookQueue }
  ): Promise<{ ok: boolean; error?: string }>;
  play(): void;
  pause(): void;
  toggle(): void;
  seek(globalSeconds: number): void;
  skip(deltaSeconds: number): void;
  jumpToChapter(index: number): void;
  setRate(rate: number): void;
  setSleep(request: SleepRequest): void;
  /** Stops playback and unloads the book. */
  close(): void;
}

const StateContext = createContext<AudioPlayerState | null>(null);
const ActionsContext = createContext<AudioPlayerActions | null>(null);

/** Full player state plus actions. Re-renders on every position update. */
export function useAudioPlayer(): (AudioPlayerState & AudioPlayerActions) | null {
  const state = useContext(StateContext);
  const actions = useContext(ActionsContext);
  return useMemo(() => (state && actions ? { ...state, ...actions } : null), [state, actions]);
}

/** Just the actions: a stable object that never re-renders its consumer. Null outside a provider. */
export function useAudioActions(): AudioPlayerActions | null {
  return useContext(ActionsContext);
}

// ── Engine ───────────────────────────────────────────────────────────────

type MediaEl = HTMLAudioElement & { webkitPreservesPitch?: boolean };

interface CachedUrl {
  url: string;
  expiresAtMs: number;
}

/** Hooks the element's event listeners call; not part of the public API. */
interface EngineInternals {
  attach(el: MediaEl | null): void;
  audio(): MediaEl | null;
  saveProgress(): void;
  openSegment(index: number, localTime: number, play: boolean, forceFresh?: boolean): Promise<void>;
  getUrl(index: number): Promise<string>;
  updatePositionState(): void;
  clearSleep(): void;
  pause(): void;
  /** Mutable engine state, read by the event handlers. */
  e: Engine;
}

interface Engine {
  book: AudioBook | null;
  segmentIndex: number;
  urls: Map<number, CachedUrl>;
  /** Bumped whenever a newer load/seek supersedes an in-flight one. */
  token: number;
  rate: number;
  position: number;
  /** Whether playback has started this session, so merely opening a book never overwrites saved progress. */
  hasPlayed: boolean;
  recoveries: number;
  lastSaveAt: number;
  lastPositionStateAt: number;
  sleep: SleepTimer;
  sleepTimeout: ReturnType<typeof setTimeout> | null;
  rateSaveTimeout: ReturnType<typeof setTimeout> | null;
  /** What the user last asked for, kept separately from element state (which flips during part swaps). */
  playRequested: boolean;
  /** The playlist queue this book was started from, if any; cleared when a different book starts or the player closes. */
  queue: (BookQueue & { titleId: string }) | null;
}

function createPlayer(
  setState: Dispatch<SetStateAction<AudioPlayerState>>,
  initialRate: number,
  viewerId: string
): { actions: AudioPlayerActions; internals: EngineInternals } {
  const e: Engine = {
    book: null,
    segmentIndex: 0,
    urls: new Map(),
    token: 0,
    rate: initialRate,
    position: 0,
    hasPlayed: false,
    recoveries: 0,
    lastSaveAt: 0,
    lastPositionStateAt: 0,
    sleep: null,
    sleepTimeout: null,
    rateSaveTimeout: null,
    playRequested: false,
    queue: null,
  };

  const patch = (p: Partial<AudioPlayerState>) => setState((s) => ({ ...s, ...p }));
  // The <audio> element is handed over by the provider's callback ref (attach).
  let audioEl: MediaEl | null = null;
  const audio = () => audioEl;

  function applyRate(el: MediaEl) {
    el.playbackRate = e.rate;
    el.defaultPlaybackRate = e.rate;
    el.preservesPitch = true;
    el.webkitPreservesPitch = true;
  }

  function chapterIndexFor(book: AudioBook | null, position: number) {
    return book ? chapterIndexAt(book.chapters, position) : -1;
  }

  function saveProgress() {
    const book = e.book;
    if (!book || !e.hasPlayed) return;
    const payload = JSON.stringify({
      ownerKind: "title",
      ownerId: book.titleId,
      positionSeconds: Math.max(0, Math.floor(e.position)),
      durationSeconds: Math.floor(book.durationSeconds),
      finished: isEffectivelyFinished(e.position, book.durationSeconds),
    });
    e.lastSaveAt = Date.now();
    // sendBeacon (POST) survives page unload; fetch is the fallback.
    if (typeof navigator !== "undefined" && navigator.sendBeacon) {
      navigator.sendBeacon("/api/watch-state", new Blob([payload], { type: "application/json" }));
    } else {
      fetch("/api/watch-state", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: payload,
        keepalive: true,
      }).catch(() => {});
    }
  }

  function updatePositionState() {
    const book = e.book;
    if (!book || typeof navigator === "undefined" || !("mediaSession" in navigator)) return;
    e.lastPositionStateAt = Date.now();
    try {
      navigator.mediaSession.setPositionState({
        duration: book.durationSeconds,
        position: Math.min(Math.max(e.position, 0), book.durationSeconds),
        playbackRate: e.rate,
      });
    } catch {
      // invalid combinations (e.g. mid-seek) are harmless to skip
    }
  }

  /** A streaming URL for a part, reusing a still-valid cached one. */
  async function getUrl(index: number, forceFresh = false): Promise<string> {
    const cached = e.urls.get(index);
    if (!forceFresh && cached && cached.expiresAtMs - Date.now() > URL_MIN_REMAINING_MS) return cached.url;

    const book = e.book;
    if (!book) throw new Error("No book loaded");
    const res = await fetch(`/api/audiobooks/${book.titleId}/segments/${index}`);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(typeof body.error === "string" ? body.error : "Couldn't get the audio for this part.");
    }
    const fresh = (await res.json()) as AudiobookSegmentUrl;
    e.urls.set(index, { url: fresh.url, expiresAtMs: Date.parse(fresh.expiresAt) });
    return fresh.url;
  }

  /** Points the element at a part and, once it can seek, jumps to `localTime` (and plays if asked). */
  async function openSegment(index: number, localTime: number, play: boolean, forceFresh = false) {
    const el = audio();
    if (!el || !e.book) return;

    const token = ++e.token;
    e.playRequested = play;
    patch({ buffering: true });
    try {
      const url = await getUrl(index, forceFresh);
      if (token !== e.token) return;

      e.segmentIndex = index;
      el.addEventListener(
        "loadedmetadata",
        () => {
          if (token !== e.token) return;
          applyRate(el);
          if (localTime > 0) el.currentTime = localTime;
          if (e.playRequested) {
            el.play().catch(() => patch({ status: "paused", buffering: false }));
          } else {
            patch({ buffering: false });
          }
        },
        { once: true }
      );
      el.src = url;
      applyRate(el);
      el.load();
    } catch (err) {
      if (token !== e.token) return;
      patch({ status: "error", error: (err as Error).message, buffering: false });
    }
  }

  function clearSleep() {
    e.sleep = null;
    if (e.sleepTimeout) clearTimeout(e.sleepTimeout);
    e.sleepTimeout = null;
    patch({ sleep: null, sleepMinutesLeft: null });
  }

  function pause() {
    e.playRequested = false;
    audio()?.pause();
  }

  function seek(globalSeconds: number) {
    const el = audio();
    const book = e.book;
    if (!el || !book) return;

    const { segment, index, localTime } = findSegmentAt(book.segments, book.durationSeconds, globalSeconds);
    const target = segment.startSeconds + localTime;
    e.position = target;
    setState((s) => ({
      ...s,
      position: target,
      chapterIndex: chapterIndexFor(book, target),
      // Seeking away from the end of a finished book un-finishes it.
      status: s.status === "finished" ? "paused" : s.status,
    }));

    if (index === e.segmentIndex && el.readyState >= 1) {
      el.currentTime = localTime;
    } else {
      void openSegment(index, localTime, !el.paused || e.playRequested);
    }
    updatePositionState();
  }

  function play() {
    const el = audio();
    const book = e.book;
    if (!el || !book) return;
    e.playRequested = true;

    // Playing again from the very end starts over.
    if (e.position >= book.durationSeconds - 0.5) {
      seek(0);
      return;
    }

    // A URL about to expire (or already expired while paused) would cut out
    // mid-part; reopen the part with a fresh one at the same spot.
    const cached = e.urls.get(e.segmentIndex);
    if (!el.src || !cached || cached.expiresAtMs - Date.now() < URL_MIN_REMAINING_MS) {
      const at = el.src ? el.currentTime : e.position - (book.segments[e.segmentIndex]?.startSeconds ?? 0);
      void openSegment(e.segmentIndex, at, true, true);
      return;
    }
    el.play().catch(() => patch({ status: "paused" }));
  }

  function setSleep(request: SleepRequest) {
    if (e.sleepTimeout) clearTimeout(e.sleepTimeout);
    e.sleepTimeout = null;
    if (request === null) return clearSleep();

    if (request === "chapter") {
      const book = e.book;
      if (!book) return;
      const index = chapterIndexFor(book, e.position);
      const endsAtSeconds =
        index >= 0 ? chapterEnd(book.chapters, index, book.durationSeconds) : book.durationSeconds;
      e.sleep = { kind: "chapter", endsAtSeconds };
    } else {
      e.sleep = { kind: "minutes", endsAt: Date.now() + request.minutes * 60_000 };
      // Backup for when timeupdate is throttled in the background.
      e.sleepTimeout = setTimeout(() => {
        pause();
        clearSleep();
      }, request.minutes * 60_000);
    }
    patch({ sleep: e.sleep, sleepMinutesLeft: request === "chapter" ? null : request.minutes });
  }

  const actions: AudioPlayerActions = {
    async load(titleId, opts = {}) {
      // A queue belongs to the book it started with: starting any other book drops it.
      if (opts.queue) e.queue = { ...opts.queue, titleId };
      else if (e.queue && e.queue.titleId !== titleId) e.queue = null;

      // Same book already loaded: just steer it.
      if (e.book?.titleId === titleId) {
        if (opts.startAt !== undefined) seek(opts.startAt);
        if (opts.autoplay) play();
        return { ok: true };
      }

      saveProgress();
      e.token++;
      audio()?.pause();
      clearSleep();
      patch({ status: "loading", error: null, buffering: true });

      try {
        const res = await fetch(`/api/audiobooks/${titleId}/manifest`);
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(typeof body.error === "string" ? body.error : "Couldn't load this audiobook.");
        }
        const { urls, resumeSeconds, ...book } = (await res.json()) as AudiobookManifest;

        e.book = book;
        e.hasPlayed = false;
        e.recoveries = 0;
        e.urls = new Map(urls.map((u) => [u.index, { url: u.url, expiresAtMs: Date.parse(u.expiresAt) }]));

        const start = Math.min(opts.startAt ?? resumeSeconds, book.durationSeconds);
        const { segment, index, localTime } = findSegmentAt(book.segments, book.durationSeconds, start);
        e.position = segment.startSeconds + localTime;
        patch({
          book,
          status: opts.autoplay ? "loading" : "paused",
          position: e.position,
          chapterIndex: chapterIndexFor(book, e.position),
        });
        await openSegment(index, localTime, !!opts.autoplay);
        return { ok: true };
      } catch (err) {
        const message = (err as Error).message;
        patch({ status: "error", error: message, buffering: false });
        return { ok: false, error: message };
      }
    },

    play,
    pause,
    toggle() {
      if (audio()?.paused || !e.playRequested) play();
      else pause();
    },
    seek,
    skip(deltaSeconds) {
      seek(e.position + deltaSeconds);
    },
    jumpToChapter(index) {
      const chapter = e.book?.chapters[index];
      if (chapter) seek(chapter.startSeconds);
    },

    setRate(rate) {
      e.rate = clampRate(rate);
      const el = audio();
      if (el) applyRate(el);
      patch({ rate: e.rate });
      updatePositionState();
      try {
        localStorage.setItem(rateStorageKey(viewerId), String(e.rate));
      } catch {
        // storage can be unavailable; the profile copy below still saves
      }
      if (e.rateSaveTimeout) clearTimeout(e.rateSaveTimeout);
      e.rateSaveTimeout = setTimeout(() => {
        fetch("/api/viewers/current/playback-rate", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ rate: e.rate }),
          keepalive: true,
        }).catch(() => {});
      }, 600);
    },

    setSleep,

    close() {
      saveProgress();
      e.queue = null;
      e.token++;
      e.playRequested = false;
      e.book = null;
      e.urls.clear();
      clearSleep();
      const el = audio();
      if (el) {
        el.pause();
        el.removeAttribute("src");
        el.load();
      }
      patch({ book: null, status: "idle", error: null, buffering: false, position: 0, chapterIndex: -1, sleepMinutesLeft: null });
    },
  };

  return {
    actions,
    internals: {
      attach: (el) => {
        audioEl = el;
      },
      audio,
      saveProgress,
      openSegment,
      getUrl,
      updatePositionState,
      clearSleep,
      pause,
      e,
    },
  };
}

// ── Provider ─────────────────────────────────────────────────────────────

export function AudioPlayerProvider({
  initialRate,
  viewerId,
  children,
}: {
  /** The selected profile's saved speed; authoritative on load. */
  initialRate?: number;
  /** Keys this device's cached speed to the profile. */
  viewerId: string;
  children: ReactNode;
}) {
  const startRate = clampRate(initialRate ?? 1);

  const [state, setState] = useState<AudioPlayerState>({
    book: null,
    status: "idle",
    error: null,
    buffering: false,
    position: 0,
    rate: startRate,
    sleep: null,
    sleepMinutesLeft: null,
    chapterIndex: -1,
  });

  const [{ actions, internals }] = useState(() => createPlayer(setState, startRate, viewerId));
  const router = useRouter();
  // createPlayer lives outside React, so the end-of-book hand-off reaches the router through this ref.
  const queueEnded = useRef<(queue: BookQueue) => void>(() => {});
  useEffect(() => {
    queueEnded.current = (queue) => {
      if (!shouldContinueQueue(window.location.search, queue)) return;
      void (async () => {
        try {
          const res = await fetch(`/api/playlists/${queue.playlistId}/next?after=${queue.itemId}`);
          if (!res.ok) return;
          const body = (await res.json()) as { next: { href: string } | null };
          if (body.next?.href) router.push(body.next.href);
        } catch {
          /* best-effort: the book simply ends */
        }
      })();
    };
  }, [router]);
  const attachAudio = useCallback((node: MediaEl | null) => internals.attach(node), [internals]);

  // Element events and page lifecycle.
  useEffect(() => {
    const node = internals.audio();
    if (!node) return;
    const el: MediaEl = node;
    const { e } = internals;
    const patch = (p: Partial<AudioPlayerState>) => setState((s) => ({ ...s, ...p }));

    function onTimeUpdate() {
      const book = e.book;
      const segment = book?.segments[e.segmentIndex];
      if (!book || !segment) return;

      const position = segment.startSeconds + el.currentTime;
      e.position = position;
      const chapterIndex = chapterIndexAt(book.chapters, position);
      const sleepMinutesLeft =
        e.sleep?.kind === "minutes" ? Math.max(1, Math.ceil((e.sleep.endsAt - Date.now()) / 60_000)) : null;
      setState((s) =>
        s.chapterIndex === chapterIndex && s.sleepMinutesLeft === sleepMinutesLeft
          ? { ...s, position }
          : { ...s, position, chapterIndex, sleepMinutesLeft }
      );

      // Sleep timer: wall clock and end-of-chapter, checked here as well as
      // by its setTimeout, since background tabs throttle timers.
      const sleep = e.sleep;
      if (
        sleep &&
        ((sleep.kind === "minutes" && Date.now() >= sleep.endsAt) ||
          (sleep.kind === "chapter" && position >= sleep.endsAtSeconds - 0.25))
      ) {
        internals.pause();
        internals.clearSleep();
      }

      // Mint the next part's URL ahead of time so the swap doesn't wait on a fetch.
      const next = e.segmentIndex + 1;
      if (next < book.segments.length && segment.durationSeconds - el.currentTime <= PRELOAD_NEXT_URL_SECONDS) {
        void internals.getUrl(next).catch(() => {});
      }

      const now = Date.now();
      if (now - e.lastSaveAt >= PROGRESS_SAVE_INTERVAL_MS) internals.saveProgress();
      if (now - e.lastPositionStateAt >= POSITION_STATE_INTERVAL_MS) internals.updatePositionState();
    }

    function onPlay() {
      e.hasPlayed = true;
      patch({ status: "playing", error: null });
    }
    function onPlaying() {
      e.recoveries = 0;
      patch({ buffering: false, status: "playing" });
    }
    function onPause() {
      if (el.ended) return;
      patch({ status: "paused" });
      internals.saveProgress();
    }
    function onWaiting() {
      patch({ buffering: true });
    }
    function onEnded() {
      const book = e.book;
      if (!book) return;
      const next = e.segmentIndex + 1;
      if (next < book.segments.length) {
        void internals.openSegment(next, 0, true);
      } else {
        e.position = book.durationSeconds;
        e.playRequested = false;
        patch({ status: "finished", position: book.durationSeconds, buffering: false });
        internals.saveProgress();
        // Started from a playlist: carry on with whatever comes next in it.
        const queue = e.queue;
        e.queue = null;
        if (queue && queue.titleId === book.titleId) queueEnded.current(queue);
      }
    }
    function onError() {
      if (!e.book || !el.src) return;
      // Usually an expired URL: reopen this part with a fresh one at the same spot.
      if (e.recoveries < MAX_RECOVERY_ATTEMPTS) {
        e.recoveries++;
        void internals.openSegment(e.segmentIndex, el.currentTime, e.playRequested, true);
      } else {
        patch({ status: "error", error: "Playback failed. Check your connection and try again.", buffering: false });
      }
    }

    const listeners: [string, () => void][] = [
      ["timeupdate", onTimeUpdate],
      ["play", onPlay],
      ["playing", onPlaying],
      ["pause", onPause],
      ["waiting", onWaiting],
      ["ended", onEnded],
      ["error", onError],
    ];
    for (const [name, fn] of listeners) el.addEventListener(name, fn);

    const onVisibility = () => {
      if (document.visibilityState === "hidden") internals.saveProgress();
    };
    const onPageHide = () => internals.saveProgress();
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", onPageHide);

    return () => {
      for (const [name, fn] of listeners) el.removeEventListener(name, fn);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", onPageHide);
      internals.saveProgress();
      el.pause();
      if (e.sleepTimeout) clearTimeout(e.sleepTimeout);
      if (e.rateSaveTimeout) clearTimeout(e.rateSaveTimeout);
    };
  }, [internals]);

  // If the profile's speed isn't available, fall back to the last one used on this device.
  useEffect(() => {
    if (initialRate !== undefined) return;
    try {
      const saved = Number(localStorage.getItem(rateStorageKey(viewerId)));
      if (saved) actions.setRate(saved);
    } catch {
      // ignore
    }
  }, [initialRate, actions, viewerId]);

  // Lock-screen / headset / notification controls.
  const book = state.book;
  useEffect(() => {
    if (!book || typeof navigator === "undefined" || !("mediaSession" in navigator)) return;
    const session = navigator.mediaSession;

    session.metadata = new MediaMetadata({
      title: book.name,
      artist: book.authors.join(", "),
      album: book.seriesName ?? "Audiobook",
      artwork: book.coverUrl ? [{ src: book.coverUrl, sizes: "500x500" }] : [],
    });
    const handlers: [MediaSessionAction, MediaSessionActionHandler][] = [
      ["play", () => actions.play()],
      ["pause", () => actions.pause()],
      ["seekbackward", (d) => actions.skip(-(d.seekOffset ?? SKIP_BACK_SECONDS))],
      ["seekforward", (d) => actions.skip(d.seekOffset ?? SKIP_FORWARD_SECONDS)],
      ["seekto", (d) => typeof d.seekTime === "number" && actions.seek(d.seekTime)],
    ];
    for (const [action, handler] of handlers) {
      try {
        session.setActionHandler(action, handler);
      } catch {
        // unsupported action on this browser
      }
    }
    return () => {
      for (const [action] of handlers) {
        try {
          session.setActionHandler(action, null);
        } catch {
          // ignore
        }
      }
    };
  }, [book, actions]);

  return (
    <ActionsContext.Provider value={actions}>
      <StateContext.Provider value={state}>
        {children}
        <audio
          ref={attachAudio}
          preload="auto"
          className="hidden"
        />
      </StateContext.Provider>
    </ActionsContext.Provider>
  );
}
