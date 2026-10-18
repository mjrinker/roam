/**
 * Plays another audio track of a video file alongside the picture. A browser plays only the first audio track of an MP4, so for any other
 * the player asks Roam for that track as short fragmented-MP4 pieces (see lib/media-tracks), feeds them to a hidden <audio> element
 * through Media Source Extensions, and keeps that element in step with the (silenced) video.
 */

/** How far ahead of the picture's position sound is kept loaded, and how much is kept behind it. */
const AHEAD_SECONDS = 70;
const BEHIND_SECONDS = 30;
/** The pieces are this long (the server's FRAGMENT_SECONDS). */
export const PIECE_SECONDS = 20;
const DRIFT_SECONDS = 0.2;
const TICK_MS = 250;

export interface AltAudioOptions {
  /** Where this track's `init` and numbered pieces are: ".../tracks/<file>/audio/<track>". */
  base: string;
  mime: string;
  /** The video's duration in seconds, to close the stream properly at the end. */
  onFailure?: (message: string) => void;
}

export class AltAudio {
  readonly element: HTMLAudioElement;
  private readonly source: MediaSource;
  private buffer: SourceBuffer | null = null;
  private readonly url: string;
  private readonly loaded = new Set<number>();
  private readonly loading = new Set<number>();
  private queue: { piece: number; bytes: ArrayBuffer }[] = [];
  private picture: HTMLVideoElement | null = null;
  private timer: ReturnType<typeof setInterval> | undefined;
  private destroyed = false;
  private initDone = false;
  private failed = false;

  constructor(private readonly options: AltAudioOptions) {
    this.element = new Audio();
    this.element.preload = "auto";
    this.source = new MediaSource();
    this.url = URL.createObjectURL(this.source);
    this.element.src = this.url;
    this.source.addEventListener("sourceopen", () => void this.open(), { once: true });
  }

  private fail(message: string) {
    if (this.failed || this.destroyed) return;
    this.failed = true;
    this.options.onFailure?.(message);
  }

  private async open() {
    try {
      this.buffer = this.source.addSourceBuffer(this.options.mime);
      this.buffer.mode = "segments";
      this.buffer.addEventListener("updateend", () => this.pump());
      const init = await this.get("init");
      if (!init || this.destroyed) return;
      this.queue.push({ piece: -1, bytes: init });
      this.pump();
      this.initDone = true;
      this.fill();
    } catch {
      this.fail("This audio track can't be played in this browser.");
    }
  }

  private async get(piece: string): Promise<ArrayBuffer | null> {
    const res = await fetch(`${this.options.base}/${piece}`, { credentials: "same-origin" }).catch(() => null);
    if (!res || (!res.ok && res.status !== 204)) {
      if (res && res.status !== 404) this.fail("This audio track couldn't be loaded.");
      return null;
    }
    return res.status === 204 ? new ArrayBuffer(0) : res.arrayBuffer();
  }

  /** Appends queued pieces one at a time (a SourceBuffer takes one append until it says it has finished). */
  private pump() {
    const sb = this.buffer;
    if (!sb || sb.updating || this.destroyed || this.source.readyState !== "open") return;
    const next = this.queue.shift();
    if (!next) return;
    try {
      if (next.bytes.byteLength > 0) sb.appendBuffer(next.bytes);
      if (next.piece >= 0) this.loaded.add(next.piece);
      if (next.bytes.byteLength === 0) this.pump();
    } catch (err) {
      // A full buffer: drop what's behind and try this piece again; anything else is a failure.
      if (err instanceof DOMException && err.name === "QuotaExceededError") {
        this.queue.unshift(next);
        this.trim(true);
      } else this.fail("This audio track couldn't be played.");
    }
  }

  private trim(hard = false) {
    const sb = this.buffer;
    if (!sb || sb.updating || this.source.readyState !== "open") return;
    const now = this.element.currentTime;
    const keepFrom = now - (hard ? 5 : BEHIND_SECONDS);
    if (keepFrom > 1 && sb.buffered.length > 0 && sb.buffered.start(0) < keepFrom - 1) {
      try {
        sb.remove(0, keepFrom);
        for (const p of [...this.loaded]) if ((p + 1) * PIECE_SECONDS <= keepFrom) this.loaded.delete(p);
      } catch {
        // nothing worth doing
      }
    }
  }

  /** Makes sure the pieces for the next AHEAD_SECONDS after the picture's position are loaded or on their way. */
  fill() {
    if (!this.initDone || this.destroyed) return;
    const at = this.picture?.currentTime ?? 0;
    const first = Math.floor(Math.max(0, at - 2) / PIECE_SECONDS);
    const last = Math.floor((at + AHEAD_SECONDS) / PIECE_SECONDS);
    for (let n = first; n <= last; n++) {
      if (this.loaded.has(n) || this.loading.has(n) || this.queue.some((q) => q.piece === n)) continue;
      this.loading.add(n);
      void this.get(String(n)).then((bytes) => {
        this.loading.delete(n);
        if (!bytes || this.destroyed) return;
        // Pieces must be appended in order of time, but each carries its own timestamps, so any order is fine in "segments" mode.
        this.queue.push({ piece: n, bytes });
        this.pump();
      });
    }
    this.trim();
  }

  /** Follows this video: its position, play and pause, speed, and mute. Call again with another video to move on to it. */
  attach(element: HTMLVideoElement) {
    this.picture = element;
    clearInterval(this.timer);
    this.timer = setInterval(() => this.sync(), TICK_MS);
    this.sync();
  }

  detach() {
    clearInterval(this.timer);
    this.picture = null;
    this.element.pause();
  }

  /** Brings the sound in step with the picture. */
  sync() {
    const v = this.picture;
    if (!v || this.destroyed) return;
    const a = this.element;
    a.muted = v.muted;
    if (Math.abs(a.playbackRate - v.playbackRate) > 0.001) a.playbackRate = v.playbackRate;
    this.fill();
    const buffered = this.hasSoundAt(v.currentTime);
    if (v.paused || v.seeking || v.readyState < 3 || !buffered) {
      if (!a.paused) a.pause();
      if (!buffered || v.paused) this.seekIfFar(v.currentTime, 0.05);
      return;
    }
    this.seekIfFar(v.currentTime, DRIFT_SECONDS);
    if (a.paused) void a.play().catch(() => undefined);
  }

  private seekIfFar(time: number, tolerance: number) {
    const a = this.element;
    if (Math.abs(a.currentTime - time) > tolerance && this.hasSoundAt(time)) a.currentTime = time;
  }

  private hasSoundAt(time: number): boolean {
    const b = this.buffer?.buffered;
    if (!b) return false;
    for (let i = 0; i < b.length; i++) if (time >= b.start(i) - 0.05 && time < b.end(i) - 0.05) return true;
    return false;
  }

  setVolume(volume: number) {
    this.element.volume = Math.min(1, Math.max(0, volume));
  }

  destroy() {
    this.destroyed = true;
    clearInterval(this.timer);
    this.element.pause();
    this.element.removeAttribute("src");
    this.element.load();
    URL.revokeObjectURL(this.url);
  }
}

/** Whether this browser can play an audio track as pieces through Media Source Extensions. */
export function canPlayAltAudio(mime: string | null): boolean {
  return !!mime && typeof MediaSource !== "undefined" && MediaSource.isTypeSupported(mime);
}
