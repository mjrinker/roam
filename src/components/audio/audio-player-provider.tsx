"use client";

import { holdPlace } from "@/lib/ownership/client";
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
import { nextIndex, previousStep, type ListQueue } from "@/lib/music/list-queue";
import { clampCrossfade, fadeGains, readStoredCrossfade, shouldHandOver, shouldPrepareNext, storeCrossfade, volumeIsAdjustable } from "@/lib/music/crossfade";
import { localAudioFor, offlineAudioManifest, openLocalFiles, type LocalFiles } from "@/lib/offline/local-playback";
import { queueProgress } from "@/lib/offline/sync";

// One <audio> element for the whole book, mounted above the pages so audio
// keeps playing as you browse. A single element (rather than the video
// player's two-element swap) is deliberate: iOS only lets an element that
// has already been unlocked by a tap keep playing in the background, so
// moving to the next part means swapping `src` on the same element.
//
// The one exception is a list of songs: a second, standby element gets the next
// song ready while the current one plays, and takes over the moment it ends
// (gapless) or a few seconds before (crossfade), then the two swap roles. Without
// that, every song change waited on a fetch. If the standby is missing or fails,
// songs are loaded one at a time as before.

export const SKIP_BACK_SECONDS = 15;
export const SKIP_FORWARD_SECONDS = 30;

const URL_MIN_REMAINING_MS = 30_000; // don't trust a URL with less than this left
const PRELOAD_NEXT_URL_SECONDS = 30; // mint the next part's URL this early
const PROGRESS_SAVE_INTERVAL_MS = 15_000;
/** A tenth of a second of silence (8-bit mono WAV), for unlocking the standby element (see unlockStandby). */
function silentWav(): string {
  const samples = 800;
  const rate = 8000;
  const bytes = new Uint8Array(44 + samples).fill(128);
  const view = new DataView(bytes.buffer);
  const text = (at: number, value: string) => [...value].forEach((c, i) => view.setUint8(at + i, c.charCodeAt(0)));
  text(0, "RIFF");
  view.setUint32(4, 36 + samples, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate, true);
  view.setUint16(32, 1, true);
  view.setUint16(34, 8, true);
  text(36, "data");
  view.setUint32(40, samples, true);
  return `data:audio/wav;base64,${btoa(String.fromCharCode(...bytes))}`;
}
const POSITION_STATE_INTERVAL_MS = 5_000;
const MAX_RECOVERY_ATTEMPTS = 3;
// Per profile, so two people on one device don't share a speed.

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
  /** Where the playing song is in the list it was started from (an album), or null when it wasn't started from one. */
  listPosition: { index: number; length: number } | null;
  /** Seconds the end of one song overlaps the start of the next in a list (0 is off; kept on this device). */
  crossfade: number;
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
  /** Plays these titles one after another, starting at `startIndex`. */
  playList(titleIds: string[], startIndex?: number): Promise<{ ok: boolean; error?: string }>;
  /** Next / previous song in the list being played (previous restarts a song heard for a few seconds). */
  next(): void;
  previous(): void;
  /** How long songs in a list overlap (0 to 12 seconds; 0 plays them back to back). Remembered on this device. */
  setCrossfade(seconds: number): void;
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
  /** The second element that gets the next song ready (optional: without it songs load one at a time). */
  attachStandby(el: MediaEl | null): void;
  audio(): MediaEl | null;
  standbyAudio(): MediaEl | null;
  prepareNext(): Promise<void>;
  handover(fadeSeconds: number): boolean;
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
  /** What the user last asked for, kept separately from element state (which flips during part swaps). */
  playRequested: boolean;
  /** The playlist queue this book was started from, if any; cleared when a different book starts or the player closes. */
  queue: (BookQueue & { titleId: string }) | null;
  /** The songs being played in order (an album), if any; dropped when something outside it starts. */
  list: ListQueue | null;
  /** The downloaded files the book is playing from, if it is a downloaded one (their addresses are let go when it ends). */
  localFiles: LocalFiles | null;
  /** Lets go of the place this book holds when the server limits playing at once (see lib/ownership/client). */
  releaseHold: (() => void) | null;
  /** The next song of the list, fetched and loaded on the standby element, ready to take over. */
  next: PreparedSong | null;
  /** The song being fetched for `next`, so it is not fetched twice. */
  preparing: string | null;
  /** Seconds of overlap between songs of a list. */
  crossfade: number;
  /** A crossfade under way: the element fading out, and what to let go of when it is done. */
  fade: { timer: ReturnType<typeof setInterval>; from: MediaEl; to: MediaEl; oldLocal: LocalFiles | null } | null;
}

interface PreparedSong {
  titleId: string;
  manifest: AudiobookManifest;
  local: LocalFiles | null;
}

/** Exported for tests; the provider below is the only real caller. */
export function createPlayer(
  setState: Dispatch<SetStateAction<AudioPlayerState>>,
  initialRate = 1,
  initialCrossfade = 0
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
    playRequested: false,
    queue: null,
    list: null,
    localFiles: null,
    releaseHold: null,
    next: null,
    preparing: null,
    crossfade: initialCrossfade,
    fade: null,
  };

  const patch = (p: Partial<AudioPlayerState>) => setState((s) => ({ ...s, ...p }));
  // The <audio> element is handed over by the provider's callback ref (attach).
  let audioEl: MediaEl | null = null;
  let standbyEl: MediaEl | null = null;
  const audio = () => audioEl;
  const standby = () => standbyEl;
  let volumeWorks: boolean | null = null;
  let standbyUnlocked = false;

  /**
   * iPhones only let an element start playing from code once it has been started by a tap. The standby never is, so on the first tap of a
   * session it is "played" silently for an instant (called from the tap itself, before anything is awaited).
   */
  function unlockStandby() {
    const el = standbyEl;
    if (standbyUnlocked || !el || typeof el.play !== "function") return;
    standbyUnlocked = true;
    try {
      el.muted = true;
      el.src = silentWav();
      const started = el.play();
      void Promise.resolve(started)
        .then(() => {
          el.pause();
        })
        .catch(() => {})
        .finally(() => {
          el.muted = false;
          if (el.src.startsWith("data:")) {
            el.removeAttribute("src");
            el.load();
          }
        });
    } catch {
      standbyUnlocked = false;
    }
  }
  const canFade = (el: MediaEl) => (volumeWorks ??= volumeIsAdjustable(el));

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
    // With no connection the progress waits on this device and is sent once there is one.
    if (typeof navigator !== "undefined" && !navigator.onLine) {
      void queueProgress({ ownerKind: "title", ownerId: book.titleId, positionSeconds: Math.max(0, Math.floor(e.position)), durationSeconds: Math.floor(book.durationSeconds), finished: isEffectivelyFinished(e.position, book.durationSeconds) });
      return;
    }
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

  /**
   * The manifest of a book or song, with its downloaded copy opened when it has one (that plays from this device; the server is still asked
   * when it can be, with no connection what was saved is enough). Throws with a message fit to show.
   */
  async function fetchManifest(titleId: string): Promise<{ manifest: AudiobookManifest; local: LocalFiles | null }> {
    const downloaded = await localAudioFor(titleId).catch(() => null);
    const res = await fetch(`/api/audiobooks/${titleId}/manifest`).catch(() => null);
    if (res && res.ok) {
      const manifest = (await res.json()) as AudiobookManifest;
      let local: LocalFiles | null = null;
      if (downloaded && downloaded.files.length === manifest.segments.length) {
        local = await openLocalFiles(downloaded).catch(() => null);
        if (local) {
          const expiresAt = new Date(Date.now() + 7 * 24 * 3600_000).toISOString();
          manifest.urls = local.urls.map((url, index) => ({ index, url, expiresAt }));
        }
      }
      return { manifest, local };
    }
    if (downloaded && (!res || res.status >= 500 || res.status === 401)) {
      const local = await openLocalFiles(downloaded).catch(() => null);
      const offline = local ? await offlineAudioManifest(downloaded, local) : null;
      if (!local || !offline) throw new Error("This download can't be opened. Remove it and download it again.");
      return { manifest: offline, local };
    }
    const body = res ? await res.json().catch(() => ({})) : {};
    throw new Error(typeof body.error === "string" ? body.error : res ? "Couldn't load this audiobook." : "You're offline, and this isn't downloaded.");
  }

  /** Holds a place for this book when the server limits how many can play at once (letting go of the last one's). */
  function takeHold(titleId: string, heartbeat: boolean | undefined) {
    e.releaseHold?.();
    e.releaseHold = heartbeat
      ? holdPlace("title", titleId, () => !!audio()?.paused, (lost) => {
          audio()?.pause();
          patch({ status: "error", error: lost.error, buffering: false });
        })
      : null;
  }

  // ── Gapless and crossfade (songs of a list) ──

  /** Ends a crossfade at once: the song going out stops, the one coming in is at full volume. */
  function finishFade() {
    const f = e.fade;
    if (!f) return;
    clearInterval(f.timer);
    e.fade = null;
    f.from.pause();
    f.from.volume = 1;
    f.to.volume = 1;
    f.from.removeAttribute("src");
    f.from.load();
    f.oldLocal?.release();
  }

  /** Drops the song that was being got ready (the list changed, or something else was asked for). */
  function discardNext() {
    const n = e.next;
    e.next = null;
    e.preparing = null;
    if (!n) return;
    n.local?.release();
    const el = standbyEl;
    if (el && !e.fade) {
      el.removeAttribute("src");
      el.load();
    }
  }

  /** Fetches the next song of the list and loads it on the standby element, so it can start the moment it is wanted. Quietly gives up on any trouble: the normal load path then does it. */
  async function prepareNext() {
    const q = e.list;
    const el = standbyEl;
    if (!q || !el || !e.book || e.fade) return;
    const index = nextIndex(q);
    if (index === null) return;
    const titleId = q.ids[index];
    if (e.next?.titleId === titleId || e.preparing === titleId) return;
    if (e.next) discardNext();
    e.preparing = titleId;
    try {
      const { manifest, local } = await fetchManifest(titleId);
      // Still the next song of the same list? (It may have moved on, or been closed, while this was fetched.)
      // (A song that holds a place on a server that limits playing at once is left to the normal path: asking for it now would take the place early.)
      if (e.list !== q || nextIndex(q) !== index || e.preparing !== titleId || !e.book || manifest.segments.length !== 1 || !manifest.urls[0] || manifest.heartbeat) {
        local?.release();
        return; // e.preparing stays set, so this song is not fetched again every quarter second
      }
      el.volume = 1;
      el.src = manifest.urls[0].url;
      el.preload = "auto";
      applyRate(el);
      el.load();
      e.next = { titleId, manifest, local };
      e.preparing = null;
    } catch {
      // the normal path will load it when it is wanted (e.preparing stays set, so it is not tried again and again)
    }
  }

  /**
   * Starts the prepared next song on the standby element and swaps the two (the old one fades out over `fadeSeconds`, or stops at once
   * when that is 0 or the device can't change volume). False when nothing suitable is ready, and nothing has changed.
   */
  function handover(fadeSeconds: number): boolean {
    const q = e.list;
    const n = e.next;
    const to = standbyEl;
    const from = audioEl;
    if (!q || !n || !to || !from || !e.book) return false;
    const index = nextIndex(q);
    if (index === null || q.ids[index] !== n.titleId) {
      discardNext();
      return false;
    }
    finishFade(); // an earlier hand-over still fading out is over now
    saveProgress();
    ++e.token; // anything still loading is superseded
    e.next = null;
    const { urls, resumeSeconds, ...book } = n.manifest;
    void resumeSeconds;
    const oldLocal = e.localFiles;
    e.localFiles = n.local;
    q.index = index;
    e.book = book;
    takeHold(n.titleId, n.manifest.heartbeat);
    e.hasPlayed = false;
    e.recoveries = 0;
    e.urls = new Map(urls.map((u) => [u.index, { url: u.url, expiresAtMs: Date.parse(u.expiresAt) }]));
    e.segmentIndex = 0;
    e.position = 0;
    e.playRequested = true;
    audioEl = to;
    standbyEl = from;
    applyRate(to);
    to.currentTime = 0;
    const fading = fadeSeconds > 0 && canFade(to);
    if (fading) {
      to.volume = 0;
      const startedAt = Date.now();
      const timer = setInterval(() => {
        const gains = fadeGains((Date.now() - startedAt) / (fadeSeconds * 1000));
        from.volume = gains.out;
        to.volume = gains.in;
        if (Date.now() - startedAt >= fadeSeconds * 1000) finishFade();
      }, 50);
      e.fade = { timer, from, to, oldLocal };
    } else {
      to.volume = 1;
      from.pause();
      from.removeAttribute("src");
      from.load();
      oldLocal?.release();
    }
    announcePlay();
    patch({ book, status: "playing", error: null, buffering: false, position: 0, chapterIndex: chapterIndexFor(book, 0), listPosition: { index, length: q.ids.length } });
    to.play().catch(() => patch({ status: "paused" }));
    updatePositionState();
    return true;
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
    finishFade(); // pausing in the middle of a crossfade stops the song going out
    audio()?.pause();
  }

  function seek(globalSeconds: number) {
    const el = audio();
    const book = e.book;
    if (!el || !book) return;
    finishFade();

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

  /** Tells the rest of the page that audio is about to play, so a video that is open pauses (one thing plays at a time). */
  function announcePlay() {
    if (typeof window !== "undefined") window.dispatchEvent(new Event("roam:audio-play"));
  }

  function play() {
    const el = audio();
    const book = e.book;
    if (!el || !book) return;
    unlockStandby();
    e.playRequested = true;
    announcePlay();

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

  /**
   * Moves a song list to `index` and plays it. If that song can't be loaded (removed or hidden meanwhile, say), going
   * forward carries on to the one after it; otherwise the list goes back to pointing at the song that is really loaded,
   * so the position shown and what plays never disagree.
   */
  function goTo(q: ListQueue, index: number, direction: 1 | -1) {
    q.index = index;
    patch({ listPosition: { index, length: q.ids.length } });
    void actions.load(q.ids[index], { autoplay: true, startAt: 0 }).then((res) => {
      if (res.ok || e.list !== q || q.index !== index) return;
      const further = direction === 1 ? nextIndex(q) : null;
      if (further !== null) return goTo(q, further, 1);
      const at = e.book ? q.ids.indexOf(e.book.titleId) : -1;
      if (at >= 0) {
        q.index = at;
        patch({ listPosition: { index: at, length: q.ids.length } });
      }
    });
  }

  const actions: AudioPlayerActions = {
    async load(titleId, opts = {}) {
      if (opts.autoplay) unlockStandby();
      // A list queue belongs to the songs in it: starting anything outside it drops it.
      if (e.list && e.list.ids[e.list.index] !== titleId) {
        e.list = null;
        patch({ listPosition: null });
      }
      // A playlist queue and a song list never run together: the one just asked for wins.
      if (opts.queue && e.list) {
        e.list = null;
        patch({ listPosition: null });
      }
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
      const token = ++e.token;
      finishFade();
      discardNext();
      audio()?.pause();
      clearSleep();
      if (opts.autoplay) announcePlay();
      patch({ status: "loading", error: null, buffering: true });

      try {
        const { manifest, local } = await fetchManifest(titleId);
        if (e.token !== token) {
          local?.release();
          return { ok: true }; // a newer load took over while this one was fetching
        }
        e.localFiles?.release();
        e.localFiles = local;
        const { urls, resumeSeconds, ...book } = manifest;
        const { defaultRate } = book;

        // Starting from nothing (the player was closed): begin at this library's speed. Moving between books or songs keeps the speed in use.
        if (e.book === null) {
          e.rate = clampRate(defaultRate ?? 1);
          patch({ rate: e.rate });
        }

        e.book = book;
        takeHold(titleId, manifest.heartbeat);
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

    async playList(titleIds, startIndex = 0) {
      unlockStandby();
      const index = Math.min(Math.max(startIndex, 0), titleIds.length - 1);
      if (titleIds.length === 0 || index < 0) return { ok: false, error: "Nothing to play." };
      e.list = { ids: [...titleIds], index };
      patch({ listPosition: { index, length: titleIds.length } });
      return actions.load(titleIds[index], { autoplay: true, startAt: 0 });
    },
    next() {
      const q = e.list;
      const index = q ? nextIndex(q) : null;
      if (!q || index === null) return;
      // The next song is already loaded and waiting: start it at once.
      if (e.next && e.next.titleId === q.ids[index] && handover(0)) return;
      goTo(q, index, 1);
    },
    previous() {
      const q = e.list;
      if (!q) return;
      const step = previousStep(q, e.position);
      if (step.restart) return seek(0);
      goTo(q, step.index, -1);
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
      if (standbyEl) applyRate(standbyEl);
      patch({ rate: e.rate });
      updatePositionState();
      // Not saved anywhere: a speed picked while listening lasts until the player is closed (a library's own starting speed is an admin setting).
    },

    setSleep,

    setCrossfade(seconds) {
      e.crossfade = clampCrossfade(seconds);
      storeCrossfade(e.crossfade);
      patch({ crossfade: e.crossfade });
    },

    close() {
      saveProgress();
      finishFade();
      discardNext();
      e.queue = null;
      e.list = null;
      e.token++;
      e.playRequested = false;
      e.book = null;
      e.releaseHold?.();
      e.releaseHold = null;
      e.urls.clear();
      e.localFiles?.release();
      e.localFiles = null;
      clearSleep();
      e.rate = 1; // closing the player ends the speed too
      const el = audio();
      if (el) {
        el.pause();
        el.removeAttribute("src");
        el.load();
      }
      patch({ rate: 1, book: null, status: "idle", error: null, buffering: false, position: 0, chapterIndex: -1, sleepMinutesLeft: null, listPosition: null });
    },
  };

  return {
    actions,
    internals: {
      attach: (el) => {
        audioEl = el;
      },
      attachStandby: (el) => {
        standbyEl = el;
      },
      audio,
      standbyAudio: standby,
      prepareNext,
      handover,
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

export function AudioPlayerProvider({ children }: { children: ReactNode }) {
  const startRate = 1;
  // The crossfade chosen on this device (the server render has no storage, and nothing it draws depends on it).
  const [startCrossfade] = useState(() => (typeof window === "undefined" ? 0 : readStoredCrossfade()));

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
    listPosition: null,
    crossfade: startCrossfade,
  });

  const [{ actions, internals }] = useState(() => createPlayer(setState, startRate, startCrossfade));
  const router = useRouter();
  // createPlayer lives outside React, so the end-of-book hand-off reaches the router through this ref.
  const queueEnded = useRef<(queue: BookQueue) => void>(() => {});
  useEffect(() => {
    queueEnded.current = (queue) => {
      if (!shouldContinueQueue(window.location.search, queue)) return;
      void (async () => {
        try {
          const res = await fetch(`/api/playlists/${queue.playlistId}/next?after=${queue.itemId}${queue.shuffle ? `&shuffle=${queue.shuffle}` : ""}`);
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
  const attachStandby = useCallback((node: MediaEl | null) => internals.attachStandby(node), [internals]);

  // Element events and page lifecycle. Both elements are listened to; only what the one playing now says counts (the other is
  // getting the next song ready, or fading out the last).
  useEffect(() => {
    const first = internals.audio();
    if (!first) return;
    const elements = [first, internals.standbyAudio()].filter((x): x is MediaEl => x !== null);
    const { e } = internals;
    const patch = (p: Partial<AudioPlayerState>) => setState((s) => ({ ...s, ...p }));
    const active = (ev: Event) => ev.target === internals.audio();

    function onTimeUpdate(ev: Event) {
      if (!active(ev)) return;
      const el = internals.audio() as MediaEl;
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

      // A list of songs: get the next one ready on the other element, and with crossfade on, hand over to it before this one ends.
      if (e.list && book.segments.length === 1) {
        const remaining = segment.durationSeconds - el.currentTime;
        if (shouldPrepareNext(remaining)) void internals.prepareNext();
        if (e.next && !e.fade && !el.paused && shouldHandOver({ crossfade: e.crossfade, songSeconds: segment.durationSeconds, remainingSeconds: remaining })) {
          internals.handover(remaining);
        }
      }

      const now = Date.now();
      if (now - e.lastSaveAt >= PROGRESS_SAVE_INTERVAL_MS) internals.saveProgress();
      if (now - e.lastPositionStateAt >= POSITION_STATE_INTERVAL_MS) internals.updatePositionState();
    }

    function onPlay(ev: Event) {
      if (!active(ev)) return;
      e.hasPlayed = true;
      patch({ status: "playing", error: null });
    }
    function onPlaying(ev: Event) {
      if (!active(ev)) return;
      e.recoveries = 0;
      patch({ buffering: false, status: "playing" });
    }
    function onPause(ev: Event) {
      if (!active(ev)) return;
      if ((ev.target as MediaEl).ended) return;
      patch({ status: "paused" });
      internals.saveProgress();
    }
    function onWaiting(ev: Event) {
      if (!active(ev)) return;
      patch({ buffering: true });
    }
    function onEnded(ev: Event) {
      if (!active(ev)) return;
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
        // Playing an album (or any list of songs): on to the next one (straight away when it is already loaded).
        if (e.list && nextIndex(e.list) !== null) {
          actions.next();
          return;
        }
        // Started from a playlist: carry on with whatever comes next in it.
        const queue = e.queue;
        e.queue = null;
        if (queue && queue.titleId === book.titleId) queueEnded.current(queue);
      }
    }
    function onError(ev: Event) {
      if (!active(ev)) return;
      const el = ev.target as MediaEl;
      if (!e.book || !el.src) return;
      // Usually an expired URL: reopen this part with a fresh one at the same spot.
      if (e.recoveries < MAX_RECOVERY_ATTEMPTS) {
        e.recoveries++;
        void internals.openSegment(e.segmentIndex, el.currentTime, e.playRequested, true);
      } else {
        patch({ status: "error", error: "Playback failed. Check your connection and try again.", buffering: false });
      }
    }

    const listeners: [string, (ev: Event) => void][] = [
      ["timeupdate", onTimeUpdate],
      ["play", onPlay],
      ["playing", onPlaying],
      ["pause", onPause],
      ["waiting", onWaiting],
      ["ended", onEnded],
      ["error", onError],
    ];
    for (const el of elements) for (const [name, fn] of listeners) el.addEventListener(name, fn);

    const onVisibility = () => {
      if (document.visibilityState === "hidden") internals.saveProgress();
    };
    const onPageHide = () => internals.saveProgress();
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", onPageHide);

    return () => {
      for (const el of elements) for (const [name, fn] of listeners) el.removeEventListener(name, fn);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", onPageHide);
      internals.saveProgress();
      for (const el of elements) el.pause();
      if (e.sleepTimeout) clearTimeout(e.sleepTimeout);
    };
  }, [internals, actions]); // both are stable for the life of the provider

  // Lock-screen / headset / notification controls.
  const book = state.book;
  const hasList = state.listPosition !== null;
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
      ...(hasList
        ? ([["nexttrack", () => actions.next()], ["previoustrack", () => actions.previous()]] as [MediaSessionAction, MediaSessionActionHandler][])
        : []),
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
  }, [book, actions, hasList]);

  return (
    <ActionsContext.Provider value={actions}>
      <StateContext.Provider value={state}>
        {children}
        <audio
          ref={attachAudio}
          preload="auto"
          className="hidden"
        />
        {/* The standby: gets the next song of a list ready, then takes over (see the note at the top). */}
        <audio ref={attachStandby} preload="auto" className="hidden" />
      </StateContext.Provider>
    </ActionsContext.Provider>
  );
}
