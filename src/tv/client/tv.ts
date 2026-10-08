/**
 * The only script Roam's TV pages load. It is compiled for Chromium 56 (Samsung 2018) and does three things:
 *  1. moves a highlight between the page's focusable items with the remote's arrow keys,
 *  2. handles Back and OK, and the media keys,
 *  3. on a watch page, plays the title in a <video> element, part after part, and keeps the viewer's place.
 * No framework: the pages are plain HTML from the server.
 */
import { UNSUPPORTED_AUDIO_CODECS } from "@/lib/scan/codec-support";
import { formatClock, isFinished, locate, timelineAt, type Segment } from "./clock";
import { pickNext, type Box } from "./focus";
import { actionOf, directionOf, TIZEN_MEDIA_KEYS, type Action } from "./keys";

declare const tizen: { tvinputdevice?: { registerKey(name: string): void } } | undefined;

const FOCUSABLE = "[data-f]";
const doc = document;

// ── Focus ────────────────────────────────────────────────────────────────

function visibleItems(): HTMLElement[] {
  const all = doc.querySelectorAll(FOCUSABLE);
  const out: HTMLElement[] = [];
  for (let i = 0; i < all.length; i++) {
    const el = all[i] as HTMLElement;
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) out.push(el);
  }
  return out;
}

const boxOf = (el: HTMLElement): Box => {
  const r = el.getBoundingClientRect();
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
};

/** Brings an element into view without smooth scrolling (slow TVs stutter), keeping a margin around it. */
function reveal(el: HTMLElement) {
  const r = el.getBoundingClientRect();
  const margin = 80;
  const vh = window.innerHeight;
  if (r.top < margin) window.scrollBy(0, r.top - margin);
  else if (r.bottom > vh - margin) window.scrollBy(0, r.bottom - vh + margin);
}

function focusEl(el: HTMLElement) {
  el.focus();
  reveal(el);
}

function current(): HTMLElement | null {
  const a = doc.activeElement as HTMLElement | null;
  return a && a.hasAttribute("data-f") ? a : null;
}

function move(dir: "left" | "up" | "right" | "down") {
  const items = visibleItems();
  const from = current();
  if (!from) {
    if (items.length) focusEl(items[0]);
    return;
  }
  const others = items.filter((e) => e !== from);
  const pick = pickNext(boxOf(from), others.map(boxOf), dir);
  if (pick >= 0) focusEl(others[pick]);
  else if (dir === "down" && !doc.querySelector("[data-end]")) {
    // nothing further down: let a page offer more (a "Show more" link is itself an item), otherwise stay put
  }
}

function activate(el: HTMLElement) {
  const href = el.getAttribute("href");
  if (href) window.location.href = href;
  else el.click();
}

function goBack() {
  const back = doc.querySelector("[data-back]");
  const href = back && back.getAttribute("href");
  if (href) window.location.href = href;
  else if (window.history.length > 1) window.history.back();
}

// ── Player ───────────────────────────────────────────────────────────────

interface PlayConfig {
  ownerKind: "title" | "episode";
  ownerId: string;
  back: string;
  next: string | null;
}
interface Manifest {
  durationSeconds: number;
  segments: Segment[];
  resumeSeconds: number;
}

const SAVE_EVERY_MS = 15000;
const SKIP_SECONDS = 10;

function unsupportedCodecsQuery(): string {
  const probe = doc.createElement("video");
  const bad: string[] = [];
  for (let i = 0; i < UNSUPPORTED_AUDIO_CODECS.length; i++) {
    if (!probe.canPlayType('video/mp4; codecs="' + UNSUPPORTED_AUDIO_CODECS[i] + '"')) bad.push(UNSUPPORTED_AUDIO_CODECS[i]);
  }
  return bad.length ? "?unsupportedCodecs=" + bad.join(",") : "";
}

function startPlayer(cfg: PlayConfig) {
  const video = doc.getElementById("video") as HTMLVideoElement;
  const bar = doc.getElementById("bar") as HTMLElement;
  const fill = doc.getElementById("fill") as HTMLElement;
  const clock = doc.getElementById("clock") as HTMLElement;
  const status = doc.getElementById("status") as HTMLElement;
  const hud = doc.getElementById("hud") as HTMLElement;
  let manifest: Manifest | null = null;
  let part: Segment | null = null;
  let hudTimer: number | undefined;
  let lastSave = 0;
  let wantPlaying = true;
  let recoveries = 0;

  const position = () => (manifest && part ? timelineAt(part, video.currentTime) : 0);

  function say(text: string) {
    status.textContent = text;
    status.style.display = text ? "block" : "none";
  }
  function showHud() {
    hud.className = "hud on";
    if (hudTimer) window.clearTimeout(hudTimer);
    hudTimer = window.setTimeout(() => {
      if (!video.paused) hud.className = "hud";
    }, 4000);
  }
  function paint() {
    if (!manifest) return;
    const p = position();
    fill.style.width = Math.min(100, (p / Math.max(1, manifest.durationSeconds)) * 100) + "%";
    clock.textContent = formatClock(p) + " / " + formatClock(manifest.durationSeconds);
  }

  /** `leaving`: the page is about to change, so use sendBeacon, which the browser finishes even then (fetch can be cancelled). */
  function save(finished?: boolean, leaving?: boolean) {
    if (!manifest) return;
    const p = Math.floor(position());
    lastSave = Date.now();
    const body = JSON.stringify({ ownerKind: cfg.ownerKind, ownerId: cfg.ownerId, positionSeconds: p, durationSeconds: Math.floor(manifest.durationSeconds), finished: finished === undefined ? isFinished(p, manifest.durationSeconds) : finished });
    // A beacon is finished by the browser even as the page goes away. Chromium 69 (Samsung 2020) refuses a beacon whose type is
    // application/json, and fails fetch's keepalive outright, so the beacon is text/plain (the server reads the body as JSON
    // whatever its type) and a normal fetch does the rest.
    try {
      if (leaving && navigator.sendBeacon && navigator.sendBeacon("/api/watch-state", new Blob([body], { type: "text/plain" }))) return;
    } catch (e) {
      /* fall through to a normal request */
    }
    fetch("/api/watch-state", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: body, credentials: "same-origin" }).catch(function () {
      /* a save lost to a page change is not worth an error */
    });
  }

  function openPart(seg: Segment, fileTime: number, autoplay: boolean) {
    part = seg;
    video.src = seg.url;
    const onMeta = () => {
      video.removeEventListener("loadedmetadata", onMeta);
      if (fileTime > 0) video.currentTime = fileTime;
      if (autoplay) {
        const played = video.play();
        if (played && played.catch) played.catch(() => say("Press OK to play"));
      }
    };
    video.addEventListener("loadedmetadata", onMeta);
    video.load();
  }

  function seekTo(seconds: number) {
    if (!manifest) return;
    const t = Math.min(Math.max(0, seconds), manifest.durationSeconds - 1);
    const at = locate(manifest.segments, t);
    if (part && at.segment.index === part.index) video.currentTime = at.localTime;
    else openPart(at.segment, at.localTime, wantPlaying);
    paint();
    showHud();
  }

  function toggle() {
    if (video.paused) {
      wantPlaying = true;
      const p = video.play();
      if (p && p.catch) p.catch(() => undefined);
    } else {
      wantPlaying = false;
      video.pause();
    }
    showHud();
  }

  function load(resumeFrom?: number) {
    say("Loading…");
    fetch("/api/play/" + cfg.ownerKind + "/" + cfg.ownerId + unsupportedCodecsQuery(), { credentials: "same-origin" })
      .then((res) => {
        if (res.status === 429) throw new Error("The demo has reached today's play limit. Try again tomorrow.");
        if (!res.ok) throw new Error("This can't be played right now.");
        return res.json();
      })
      .then((m: Manifest) => {
        manifest = m;
        const start = resumeFrom !== undefined ? resumeFrom : m.resumeSeconds > 0 && m.resumeSeconds < m.durationSeconds - 30 ? m.resumeSeconds : 0;
        const at = locate(m.segments, start);
        say("");
        openPart(at.segment, at.localTime, true);
      })
      .catch((e: Error) => say(e.message || "This can't be played right now."));
  }

  video.addEventListener("timeupdate", () => {
    paint();
    if (Date.now() - lastSave > SAVE_EVERY_MS && !video.paused) save();
  });
  video.addEventListener("playing", () => {
    recoveries = 0;
    say("");
    showHud();
  });
  video.addEventListener("waiting", () => say("Buffering…"));
  video.addEventListener("pause", () => {
    showHud();
    save();
  });
  video.addEventListener("ended", () => {
    if (!manifest || !part) return;
    const nextPart = manifest.segments[part.index + 1];
    if (nextPart) return openPart(nextPart, nextPart.inFileOffsetSeconds || 0, true);
    save(true, true);
    window.location.href = cfg.next || cfg.back;
  });
  video.addEventListener("error", () => {
    // Usually a link that expired while paused: ask for fresh ones and carry on from the same spot (twice at most).
    if (manifest && recoveries < 2) {
      recoveries++;
      load(position());
    } else say("Playback failed. Press Back and try again.");
  });
  window.addEventListener("pagehide", () => save(undefined, true));

  /** Player keys, called from the page's key handler; returns true when it handled the key. */
  playerKeys = (action: Action | null, dirKey: string | null): boolean => {
    if (action === "back" || action === "stop") {
      save(undefined, true);
      window.location.href = cfg.back;
      return true;
    }
    if (action === "playpause" || action === "enter") return toggle(), true;
    if (action === "play") return wantPlaying || video.paused ? (toggle(), true) : true;
    if (action === "pause") return video.paused ? true : (toggle(), true);
    if (action === "forward" || dirKey === "right") return seekTo(position() + (action === "forward" ? 30 : SKIP_SECONDS)), true;
    if (action === "rewind" || dirKey === "left") return seekTo(position() - (action === "rewind" ? 30 : SKIP_SECONDS)), true;
    if (dirKey === "up" || dirKey === "down") return showHud(), true;
    return false;
  };
  bar.style.display = "block";
  load();
}

let playerKeys: ((action: Action | null, dirKey: string | null) => boolean) | null = null;

// ── Wiring ───────────────────────────────────────────────────────────────

doc.addEventListener("keydown", (e: KeyboardEvent) => {
  const code = e.keyCode;
  const dir = directionOf(code);
  const action = actionOf(code);
  if (playerKeys) {
    if (playerKeys(action, dir)) e.preventDefault();
    return;
  }
  if (dir) {
    e.preventDefault();
    move(dir);
  } else if (action === "enter") {
    const el = current();
    if (el) {
      e.preventDefault();
      activate(el);
    }
  } else if (action === "back") {
    e.preventDefault();
    goBack();
  }
});

function init() {
  try {
    if (typeof tizen !== "undefined" && tizen && tizen.tvinputdevice) for (let i = 0; i < TIZEN_MEDIA_KEYS.length; i++) tizen.tvinputdevice.registerKey(TIZEN_MEDIA_KEYS[i]);
  } catch (e) {
    /* not on a Samsung TV, or the app lacks the privilege */
  }
  const cfgEl = doc.getElementById("play-config");
  if (cfgEl) return startPlayer(JSON.parse(cfgEl.textContent || "{}") as PlayConfig);
  const start = doc.querySelector("[data-autofocus]") as HTMLElement | null;
  const items = visibleItems();
  if (start) focusEl(start);
  else if (items.length) focusEl(items[0]);
  // A page that polls (the pairing screen) names its script-free refresh target.
  const poll = doc.querySelector("[data-poll]");
  if (poll) startPolling(poll as HTMLElement);
}

/** The pairing screen: ask the server every few seconds whether the code has been approved, and go on when it has. */
function startPolling(el: HTMLElement) {
  const url = el.getAttribute("data-poll") || "";
  const done = el.getAttribute("data-done") || "/tv";
  const gone = el.getAttribute("data-expired") || window.location.href;
  const tick = () => {
    fetch(url, { method: "POST", credentials: "same-origin" })
      .then((r) => r.json())
      .then((j: { status: string }) => {
        if (j.status === "approved") window.location.href = done;
        else if (j.status === "expired") window.location.href = gone;
        else window.setTimeout(tick, 3000);
      })
      .catch(() => window.setTimeout(tick, 5000));
  };
  window.setTimeout(tick, 3000);
}

if (doc.readyState === "loading") doc.addEventListener("DOMContentLoaded", init);
else init();
