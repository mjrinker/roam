/* eslint-disable @next/next/no-location-assign-relative-destination -- a plain page script for TV browsers, not a Next.js component */
/**
 * The only script Roam's TV pages load. It is compiled for Chromium 56 (Samsung 2018) and does three things:
 *  1. moves a highlight between the page's focusable items with the remote's arrow keys,
 *  2. handles Back and OK, and the media keys,
 *  3. on a watch page, plays the title in a <video> element, part after part, and keeps the viewer's place,
 *  4. on a listening page, does the same for audio (an audiobook, an audio file or a song) in an <audio> element,
 *  5. on a picture page, shows one picture full screen, with left and right for its neighbours and a slideshow.
 * No framework: the pages are plain HTML from the server.
 */
import { UNSUPPORTED_AUDIO_CODECS } from "@/lib/scan/codec-support";
import { formatClock, isFinished, locate, timelineAt, type Segment } from "./clock";
import { pickNext, type Box } from "./focus";
import { actionOf, directionOf, TIZEN_MEDIA_KEYS, type Action } from "./keys";
import { clampSpeed, formatSpeed, SPEED_STEP } from "@/lib/player/speed";
import { activeCues, type Cue } from "@/lib/subtitles/cues";
import { pickInitialTrack, readChoice, rememberedChoice, writeChoice } from "@/lib/subtitles/choice";

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
  maybeLoadMore(el);
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
  if (href) {
    if (!el.hasAttribute("data-back")) rememberFocus(href); // pressing Back is leaving, not choosing something to return to
    window.location.href = href;
  } else el.click();
}

// ── Remembering your place ───────────────────────────────────────────────

const PLACE_KEY = "roamTvPlaces";
const pageKey = () => window.location.pathname + window.location.search;

interface Place {
  /** The link that was opened from the page. */
  h: string;
  /** The extra pages the endless list had added by then, to be added again on the way back. */
  p: string[];
}
const addedPages: string[] = [];

/** Notes which link was opened from this page, so Back can put the highlight on it again instead of at the top. */
function rememberFocus(href: string) {
  try {
    const raw = window.sessionStorage.getItem(PLACE_KEY);
    const places: { [page: string]: Place } = raw ? JSON.parse(raw) : {};
    delete places[pageKey()];
    places[pageKey()] = { h: href, p: addedPages.slice() };
    const keys = Object.keys(places);
    for (let i = 0; i < keys.length - 30; i++) delete places[keys[i]]; // keep the last thirty pages
    window.sessionStorage.setItem(PLACE_KEY, JSON.stringify(places));
  } catch {
    /* storage may be unavailable; the highlight just starts at the top */
  }
}

/** Puts the highlight back on the link that was opened from this page last time (adding the pages of a long list again first). True when there was something to restore. */
function restoreFocus(fallback: () => void): boolean {
  try {
    const raw = window.sessionStorage.getItem(PLACE_KEY);
    if (!raw) return false;
    const places: { [page: string]: Place } = JSON.parse(raw);
    const place = places[pageKey()];
    if (!place || typeof place.h !== "string") return false;
    delete places[pageKey()];
    window.sessionStorage.setItem(PLACE_KEY, JSON.stringify(places));
    const focusIt = () => {
      const items = visibleItems();
      for (let i = 0; i < items.length; i++) {
        if (items[i].getAttribute("href") === place.h) return void focusEl(items[i]);
      }
      fallback();
    };
    const pages = Array.isArray(place.p) ? place.p : [];
    let chain: Promise<void> = Promise.resolve();
    for (let i = 0; i < pages.length; i++) {
      const page = pages[i];
      chain = chain.then(() => appendPage(page));
    }
    chain.then(focusIt, focusIt);
    return true;
  } catch {
    /* ignore */
  }
  return false;
}

// ── Endless lists (newer browsers) ──────────────────────────────────────

let loadingMore = false;

/** Fetches one more page of a list and adds its cards (and its link to the page after it) to this one. */
function appendPage(href: string): Promise<void> {
  const more = doc.querySelector("a[data-more]");
  const cards = doc.querySelector("[data-cards]");
  if (!cards) return Promise.reject(new Error("no list"));
  return fetch(href, { credentials: "same-origin" })
    .then((res) => {
      if (!res.ok) throw new Error("page failed");
      return res.text();
    })
    .then((text) => {
      const next = new DOMParser().parseFromString(text, "text/html");
      const added = next.querySelector("[data-cards]");
      if (!added) throw new Error("no cards");
      const nodes: Node[] = [];
      for (let i = 0; i < added.children.length; i++) nodes.push(added.children[i]);
      for (let i = 0; i < nodes.length; i++) cards.appendChild(doc.importNode(nodes[i], true));
      const nextMore = next.querySelector("a[data-more]");
      if (more) {
        if (nextMore) more.setAttribute("href", nextMore.getAttribute("href") || "");
        else if (more.parentNode) more.parentNode.removeChild(more);
      }
      addedPages.push(href);
    });
}

/** On a long list, the next page is fetched and added as the highlight nears the end, so there is no More button to press. */
function maybeLoadMore(el: HTMLElement) {
  if (!MODERN || loadingMore) return;
  const more = doc.querySelector("a[data-more]");
  const cards = doc.querySelector("[data-cards]");
  if (!more || !cards || !cards.contains(el)) return;
  let at = -1;
  for (let i = 0; i < cards.children.length; i++) if (cards.children[i] === el || cards.children[i].contains(el)) at = i;
  if (at < cards.children.length - 8) return;
  loadingMore = true;
  appendPage(more.getAttribute("href") || "").then(
    () => {
      loadingMore = false;
    },
    () => {
      // Fall back to the visible More button.
      more.className = more.className.replace(" auto", "");
      loadingMore = false;
    }
  );
}

function goBack() {
  const back = doc.querySelector("[data-back]");
  const href = back && back.getAttribute("href");
  if (href) window.location.href = href;
  else if (window.history.length > 1) window.history.back();
}

// ── Playback speed ───────────────────────────────────────────────────────

const FINE_STEP = 0.05;

/** The next multiple of 0.25 above (or below) a speed: 1.35 goes up to 1.5 and down to 1.25. */
function snapStep(rate: number, direction: 1 | -1): number {
  const n = rate / SPEED_STEP;
  const stepped = direction === 1 ? Math.floor(n + 1e-9) + 1 : Math.ceil(n - 1e-9) - 1;
  return clampSpeed(stepped * SPEED_STEP);
}

/**
 * Speed for a player: starts at the library's default (until the viewer changes it), applies to the element, and is changed with an overlay
 * the remote drives: up and down in steps of 0.25, left and right 0.05 at a time (so any speed from 0.25 to 3 can be reached), OK to close.
 * It lasts as long as the page keeps the player (a next episode or song keeps it) and is never saved.
 */
function createSpeedControl(media: HTMLMediaElement, onChange: () => void) {
  let rate = 1;
  let touched = false;
  let open = false;
  const box = doc.getElementById("speedbox");

  const apply = () => {
    media.defaultPlaybackRate = rate; // so a part loaded later starts at the same speed
    media.playbackRate = rate;
  };
  const draw = () => {
    if (!box) return;
    box.style.display = open ? "block" : "none";
    if (!open) return;
    box.innerHTML = "";
    const title = doc.createElement("div");
    title.textContent = "Playback speed";
    const big = doc.createElement("b");
    big.textContent = formatSpeed(rate);
    const hint = doc.createElement("small");
    hint.textContent = "Up and Down: 0.25 steps · Left and Right: fine tune · OK: done";
    box.appendChild(title);
    box.appendChild(big);
    box.appendChild(hint);
  };
  const set = (next: number) => {
    rate = clampSpeed(next);
    touched = true;
    apply();
    draw();
    onChange();
  };

  return {
    rate: () => rate,
    /** The library's own starting speed, used until the viewer picks one. */
    applyDefault(defaultRate: number | null | undefined) {
      if (touched) return;
      rate = clampSpeed(defaultRate === null || defaultRate === undefined ? 1 : defaultRate);
      apply();
      onChange();
    },
    isOpen: () => open,
    open() {
      open = true;
      draw();
    },
    /** While the overlay is open it takes every key. */
    key(action: Action | null, dirKey: string | null): boolean {
      if (dirKey === "up") set(snapStep(rate, 1));
      else if (dirKey === "down") set(snapStep(rate, -1));
      else if (dirKey === "right") set(rate + FINE_STEP);
      else if (dirKey === "left") set(rate - FINE_STEP);
      else if (action === "enter" || action === "back" || action === "stop") {
        open = false;
        draw();
      }
      return true;
    },
  };
}

// ── Subtitles ────────────────────────────────────────────────────────────

interface SubtitleTrack {
  id: string;
  language: string;
  label: string;
  hearingImpaired: boolean;
}

const SUBTITLE_DELAY_STEP = 0.5;

/**
 * Subtitles on the TV: the words drawn over the picture from the player's clock, and a picker the remote drives (Down opens it: up and
 * down choose Off or a track, left and right move the delay by half a second, OK closes). The language last chosen on this TV is
 * switched on by itself when a video has it.
 */
function createSubtitleControl(getTime: () => number) {
  let tracks: SubtitleTrack[] = [];
  let activeId: string | null = null;
  let cues: Cue[] | null = null;
  let offset = 0;
  let open = false;
  let cursor = 0;
  let shown = "";
  const words = doc.getElementById("subs");
  const picker = doc.getElementById("subpicker");

  const drawWords = () => {
    if (!words) return;
    const now = cues ? activeCues(cues, getTime(), offset) : [];
    const key = now.map((c) => c[0] + ":" + c[1]).join("|");
    if (key === shown) return;
    shown = key;
    words.innerHTML = "";
    for (let i = 0; i < now.length; i++) {
      const p = doc.createElement("p");
      p.textContent = now[i][2];
      words.appendChild(p);
    }
  };
  window.setInterval(drawWords, 120);

  const drawPicker = () => {
    if (!picker) return;
    picker.style.display = open ? "block" : "none";
    if (!open) return;
    picker.className = "speedbox subpick";
    picker.innerHTML = "";
    const title = doc.createElement("div");
    title.textContent = "Subtitles";
    picker.appendChild(title);
    const rows = ["Off"].concat(tracks.map((t) => t.label));
    for (let i = 0; i < rows.length; i++) {
      const row = doc.createElement("div");
      row.className = "row2" + (i === cursor ? " on" : "");
      const isActive = i === 0 ? activeId === null : tracks[i - 1].id === activeId;
      row.textContent = (i === cursor ? "▶ " : "   ") + rows[i] + (isActive ? "  ✓" : "");
      picker.appendChild(row);
    }
    const hint = doc.createElement("small");
    hint.textContent = "Up and Down: choose · OK: select" + (activeId ? " · Left and Right: delay " + (offset > 0 ? "+" : "") + offset.toFixed(1) + "s" : "");
    picker.appendChild(hint);
  };

  /** Switches a track on or off without remembering it (what happens when a video loads); `choose` is for the viewer's own choice. */
  const apply = (id: string | null) => {
    activeId = id;
    cues = null;
    shown = "";
    if (words) words.innerHTML = ""; // whatever was on screen goes now, not at the next tick
    if (id) {
      fetch("/api/subtitles/" + id, { credentials: "same-origin" })
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error("no cues"))))
        .then((body: { cues: Cue[] }) => {
          if (activeId === id) cues = body.cues;
        })
        .catch(() => {
          if (activeId === id) activeId = null;
        });
    }
    drawWords();
  };
  const choose = (id: string | null) => {
    apply(id);
    writeChoice(rememberedChoice(tracks.filter((t) => t.id === id)[0] || null));
  };

  return {
    hasTracks: () => tracks.length > 0,
    /** A video's tracks (from its manifest): resets the delay and switches on the remembered language, if there is one. */
    setTracks(next: SubtitleTrack[] | undefined) {
      tracks = next || [];
      offset = 0;
      open = false;
      apply(null);
      const wanted = pickInitialTrack(tracks, readChoice());
      if (wanted) apply(wanted.id);
      const hint = doc.getElementById("vhint");
      if (hint) hint.textContent = "Up: playback speed" + (tracks.length ? "  ·  Down: subtitles" : "");
    },
    isOpen: () => open,
    open() {
      open = true;
      cursor = activeId === null ? 0 : 1 + Math.max(0, tracks.map((t) => t.id).indexOf(activeId));
      drawPicker();
    },
    key(action: Action | null, dirKey: string | null): boolean {
      if (dirKey === "up") cursor = Math.max(0, cursor - 1);
      else if (dirKey === "down") cursor = Math.min(tracks.length, cursor + 1);
      else if (dirKey === "left" && activeId) offset = Math.round((offset - SUBTITLE_DELAY_STEP) * 10) / 10;
      else if (dirKey === "right" && activeId) offset = Math.round((offset + SUBTITLE_DELAY_STEP) * 10) / 10;
      else if (action === "enter") {
        choose(cursor === 0 ? null : tracks[cursor - 1].id);
        open = false;
      } else if (action === "back" || action === "stop") open = false;
      drawPicker();
      drawWords();
      return true;
    },
  };
}

/** " · 1.25x" after the clock when the speed is not normal. */
const speedSuffix = (rate: number) => (Math.abs(rate - 1) < 1e-9 ? "" : "  ·  " + formatSpeed(rate));

// ── Player ───────────────────────────────────────────────────────────────

interface PlayConfig {
  ownerKind: "title" | "episode";
  ownerId: string;
  back: string;
  next: string | null;
  upNextSeconds?: number;
  title?: string;
  subtitle?: string | null;
}
interface Manifest {
  durationSeconds: number;
  segments: Segment[];
  resumeSeconds: number;
  defaultRate?: number | null;
  subtitles?: SubtitleTrack[];
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

function startPlayer(first: PlayConfig) {
  let cfg = first;
  const video = doc.getElementById("pv") as HTMLVideoElement;
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
  const speed = createSpeedControl(video, () => paint());
  const subs = createSubtitleControl(() => position());

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
    clock.textContent = formatClock(p) + " / " + formatClock(manifest.durationSeconds) + speedSuffix(speed.rate());
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
    } catch {
      /* fall through to a normal request */
    }
    fetch("/api/watch-state", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: body, credentials: "same-origin" }).catch(function () {
      /* a save lost to a page change is not worth an error */
    });
  }

  let pendingMeta: (() => void) | null = null;
  function openPart(seg: Segment, fileTime: number, autoplay: boolean) {
    part = seg;
    video.src = seg.url;
    // A part still loading when another is chosen must not act on the new one's metadata.
    if (pendingMeta) video.removeEventListener("loadedmetadata", pendingMeta);
    const onMeta = () => {
      video.removeEventListener("loadedmetadata", onMeta);
      if (pendingMeta === onMeta) pendingMeta = null;
      video.currentTime = fileTime;
      if (autoplay) {
        const played = video.play();
        if (played && played.catch) played.catch(() => say("Press OK to play"));
      }
    };
    pendingMeta = onMeta;
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

  function fetchPlay(kind: string, id: string): Promise<Manifest> {
    return fetch("/api/play/" + kind + "/" + id + unsupportedCodecsQuery(), { credentials: "same-origin" }).then((res) => {
      if (res.status === 401 || res.status === 403) {
        window.location.href = "/tv";
        throw new Error("Signed out.");
      }
      if (res.status === 429) throw new Error("The demo has reached today's play limit. Try again tomorrow.");
      if (!res.ok) throw new Error("This can't be played right now.");
      return res.json();
    });
  }

  function load(resumeFrom?: number, autoplay?: boolean, ahead?: Promise<Manifest>) {
    say("Loading…");
    (ahead || fetchPlay(cfg.ownerKind, cfg.ownerId))
      .then((m: Manifest) => {
        manifest = m;
        speed.applyDefault(m.defaultRate);
        subs.setTracks(m.subtitles);
        const start = resumeFrom !== undefined ? resumeFrom : m.resumeSeconds > 0 && m.resumeSeconds < m.durationSeconds - 30 ? m.resumeSeconds : 0;
        const at = locate(m.segments, start);
        say("");
        openPart(at.segment, at.localTime, autoplay === undefined ? true : autoplay);
      })
      .catch((e: Error) => say(e.message || "This can't be played right now."));
  }

  // ── Up next (newer browsers): the next episode starts in this page after a short countdown ──
  let upNextTimer: number | undefined;
  let upNextGo: (() => void) | null = null;
  let upNextPending = false; // the episode has ended and the next one's details are on their way
  let upNextCancelled = false; // Back was pressed in that gap

  function upNext() {
    const nextHref = cfg.next as string;
    upNextPending = true;
    upNextCancelled = false;
    fetch(nextHref + (nextHref.indexOf("?") < 0 ? "?" : "&") + "json=1", { credentials: "same-origin" })
      .then((res) => {
        if (!res.ok) throw new Error("no details");
        return res.json();
      })
      .then((info: PlayConfig) => {
        upNextPending = false;
        if (upNextCancelled) return;
        const box = doc.getElementById("upnext") as HTMLElement;
        const ahead = fetchPlay(info.ownerKind, info.ownerId); // fetched during the countdown, so the episode starts at once
        ahead.catch(() => undefined);
        let left = info.upNextSeconds || 10;
        const paint2 = () => {
          box.innerHTML = "";
          const head = doc.createElement("div");
          head.textContent = "Up next in " + left;
          const name = doc.createElement("b");
          name.textContent = (info.title || "") + (info.subtitle ? " · " + info.subtitle : "");
          const hint = doc.createElement("small");
          hint.textContent = "OK to play now · Back to stop";
          box.appendChild(head);
          box.appendChild(name);
          box.appendChild(hint);
        };
        const go = () => {
          window.clearTimeout(upNextTimer);
          upNextGo = null;
          box.style.display = "none";
          cfg = { ownerKind: info.ownerKind, ownerId: info.ownerId, back: info.back, next: info.next, upNextSeconds: info.upNextSeconds };
          manifest = null;
          part = null;
          recoveries = 0;
          const t = doc.getElementById("wtitle");
          const sub = doc.getElementById("wsub");
          if (t) t.textContent = info.title || "";
          if (sub) sub.textContent = info.subtitle ? " · " + info.subtitle : "";
          doc.title = (info.title || "") + " · Roam";
          try {
            window.history.replaceState(null, "", nextHref);
          } catch {
            /* the address is only cosmetic */
          }
          load(undefined, true, ahead);
        };
        upNextGo = go;
        box.style.display = "block";
        paint2();
        const tick = () => {
          left--;
          if (left <= 0) return go();
          paint2();
          upNextTimer = window.setTimeout(tick, 1000);
        };
        upNextTimer = window.setTimeout(tick, 1000);
      })
      .catch(() => {
        upNextPending = false;
        if (!upNextCancelled) window.location.href = nextHref; // couldn't get the details: load the next page the ordinary way
      });
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
    if (MODERN && cfg.next) return upNext();
    window.location.href = cfg.next || cfg.back;
  });
  video.addEventListener("error", () => {
    // Usually a link that expired while paused: ask for fresh ones and carry on from the same spot (twice at most).
    if (manifest && recoveries < 2) {
      recoveries++;
      load(position(), wantPlaying);
    } else say("Playback failed. Press Back and try again.");
  });
  window.addEventListener("pagehide", () => save(undefined, true));

  /** Player keys, called from the page's key handler; returns true when it handled the key. */
  playerKeys = (action: Action | null, dirKey: string | null): boolean => {
    if (speed.isOpen()) return speed.key(action, dirKey);
    if (subs.isOpen()) return subs.key(action, dirKey);
    if (upNextPending) {
      // The episode has ended and the next one's details haven't arrived: Back still stops, OK waits for them.
      if (action === "back" || action === "stop") {
        upNextCancelled = true;
        window.location.href = cfg.back;
      }
      return true;
    }
    if (upNextGo) {
      // While the countdown runs, OK starts the next episode now and Back stops (the episode just watched is already saved as finished).
      if (action === "enter" || action === "play" || action === "playpause") upNextGo();
      else if (action === "back" || action === "stop") window.location.href = cfg.back;
      return true;
    }
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
    if (dirKey === "up") return speed.open(), showHud(), true;
    if (dirKey === "down") return subs.hasTracks() ? (subs.open(), showHud(), true) : (showHud(), true);
    return false;
  };
  bar.style.display = "block";
  load();
}


// ── Listening (audiobooks, audio files, songs) ───────────────────────────────

interface ListenConfig {
  ownerKind: "title";
  ownerId: string;
  /** Whether the place is saved (audiobooks and audio files, not songs). */
  remembers: boolean;
  skip: number;
  back: string;
  next: string | null;
  /** An album's songs and this one's place: newer browsers play on to the next song in the same page. */
  queue?: { items: { id: string; title: string; by: string | null; cover?: string | null }[]; index: number; cover?: string | null } | null;
}
interface AudioPart {
  index: number;
  startSeconds: number;
  durationSeconds: number;
}
interface AudioManifest {
  durationSeconds: number;
  segments: AudioPart[];
  resumeSeconds: number;
  urls: { index: number; url: string; expiresAt: string }[];
  defaultRate?: number | null;
}

function startListening(cfg: ListenConfig) {
  const audio = doc.getElementById("pa") as HTMLAudioElement;
  const bar = doc.getElementById("bar") as HTMLElement;
  const fill = doc.getElementById("fill") as HTMLElement;
  const clock = doc.getElementById("clock") as HTMLElement;
  const status = doc.getElementById("status") as HTMLElement;
  const hud = doc.getElementById("hud") as HTMLElement;
  let manifest: AudioManifest | null = null;
  let part: AudioPart | null = null;
  let lastSave = 0;
  let wantPlaying = true;
  let recoveries = 0;
  let hudTimer: number | undefined;
  // The song being played. A newer browser keeps going through the album in this page; an older one loads each song's page.
  let id = cfg.ownerId;
  let qi = cfg.queue && MODERN ? cfg.queue.index : -1;
  let prefetched: { id: string; manifest: Promise<AudioManifest> } | null = null;
  let loadSeq = 0; // each load() takes a number, and a reply that is not from the latest one is ignored (a fast skip must not play the wrong song)
  const queue = cfg.queue && MODERN ? cfg.queue.items : null;
  const queueEl = doc.getElementById("queuelist");

  /** Under the title: the next few songs, and the keys that move between songs. */
  function paintQueue() {
    if (!queue || !queueEl) return;
    queueEl.innerHTML = "";
    const upcoming = queue.slice(qi + 1, qi + 4);
    const line = doc.createElement("div");
    line.textContent = upcoming.length ? "Next: " + upcoming.map((x) => x.title).join(" · ") : "Last song";
    const hint = doc.createElement("div");
    hint.textContent = "Song " + (qi + 1) + " of " + queue.length + " · Up: previous song · Down: next song";
    queueEl.appendChild(line);
    queueEl.appendChild(hint);
  }

  /** Lets the system (and a newer TV's own remote handling) show and control what is playing. */
  function tellSystem(title: string, by: string | null, cover?: string | null) {
    const ms = (navigator as unknown as { mediaSession?: { metadata: unknown; setActionHandler(name: string, fn: (() => void) | null): void } }).mediaSession;
    const Meta = (window as unknown as { MediaMetadata?: new (init: { title: string; artist: string; artwork: { src: string }[] }) => unknown }).MediaMetadata;
    if (!MODERN || !ms || !Meta) return;
    try {
      ms.metadata = new Meta({ title: title, artist: by || "", artwork: cover ? [{ src: cover }] : [] });
      ms.setActionHandler("play", () => (audio.paused ? toggle() : undefined));
      ms.setActionHandler("pause", () => (audio.paused ? undefined : toggle()));
      ms.setActionHandler("nexttrack", queue && qi + 1 < queue.length ? () => goToSong(qi + 1) : null);
      ms.setActionHandler("previoustrack", queue ? () => previousSong() : null);
    } catch {
      /* some browsers refuse an action they don't know */
    }
  }

  /** A song from another album brings its own cover: the big picture and the blurred backdrop follow it. */
  function showCover(src: string | null) {
    // A song with no cover shows none, rather than the previous album's.
    const set = (el: HTMLElement | null) => {
      if (!el) return;
      if (src) el.setAttribute("src", src);
      else el.removeAttribute("src");
    };
    set(doc.getElementById("coverimg"));
    if (MODERN) set(doc.getElementById("bgimg"));
  }

  function previousSong() {
    if (!queue) return;
    if (position() > 5 || qi === 0) seekTo(0);
    else goToSong(qi - 1);
  }

  const position = () => (manifest && part ? part.startSeconds + audio.currentTime : 0);
  const speed = createSpeedControl(audio, () => paint());
  const say = (text: string) => {
    status.textContent = text;
    status.style.display = text ? "block" : "none";
  };
  function showHud() {
    hud.className = "hud on";
    if (hudTimer) window.clearTimeout(hudTimer);
    hudTimer = window.setTimeout(() => {
      if (!audio.paused) hud.className = "hud";
    }, 5000);
  }
  function paint() {
    if (!manifest) return;
    const p = position();
    fill.style.width = Math.min(100, (p / Math.max(1, manifest.durationSeconds)) * 100) + "%";
    clock.textContent = formatClock(p) + " / " + formatClock(manifest.durationSeconds) + speedSuffix(speed.rate());
  }
  function save(finished?: boolean, leaving?: boolean) {
    if (!cfg.remembers || !manifest) return;
    const p = Math.floor(position());
    lastSave = Date.now();
    const body = JSON.stringify({ ownerKind: cfg.ownerKind, ownerId: id, positionSeconds: p, durationSeconds: Math.floor(manifest.durationSeconds), finished: finished === undefined ? isFinished(p, manifest.durationSeconds) : finished });
    try {
      // text/plain: Chromium 69 refuses a JSON beacon (see the video player)
      if (leaving && navigator.sendBeacon && navigator.sendBeacon("/api/watch-state", new Blob([body], { type: "text/plain" }))) return;
    } catch {
      /* fall through to a normal request */
    }
    fetch("/api/watch-state", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: body, credentials: "same-origin" }).catch(function () {
      /* a save lost to a page change is not worth an error */
    });
  }

  /** The link for one part: the manifest carries the first two, any other (or an expired one) is asked for. */
  function urlFor(index: number): Promise<string> {
    const known = manifest && manifest.urls.filter((u) => u.index === index && Date.parse(u.expiresAt) - Date.now() > 60000)[0];
    if (known) return Promise.resolve(known.url);
    return fetch("/api/audiobooks/" + id + "/segments/" + index, { credentials: "same-origin" })
      .then((r) => {
        if (!r.ok) throw new Error("This can't be played right now.");
        return r.json();
      })
      .then((j: { url: string }) => j.url);
  }

  let opening = 0;
  let pendingMeta: (() => void) | null = null;
  function openPart(seg: AudioPart, fileTime: number, autoplay: boolean) {
    const ticket = ++opening;
    // A part still loading when another is chosen must not act on the new one's metadata.
    if (pendingMeta) audio.removeEventListener("loadedmetadata", pendingMeta);
    pendingMeta = null;
    urlFor(seg.index)
      .then((url) => {
        if (ticket !== opening) return; // another part was chosen while this link was being fetched
        // Only now does this part replace the one that is playing, so a save in the meantime still reports the old, true position.
        part = seg;
        audio.src = url;
        const onMeta = () => {
          audio.removeEventListener("loadedmetadata", onMeta);
          if (pendingMeta === onMeta) pendingMeta = null;
          audio.currentTime = fileTime;
          if (autoplay) {
            const played = audio.play();
            if (played && played.catch) played.catch(() => say("Press OK to play"));
          }
        };
        pendingMeta = onMeta;
        audio.addEventListener("loadedmetadata", onMeta);
        audio.load();
      })
      .catch((e: Error) => say(e.message || "This can't be played right now."));
  }

  function partAt(seconds: number): { seg: AudioPart; local: number } {
    const segs = (manifest as AudioManifest).segments;
    let found = segs[0];
    for (let i = 0; i < segs.length; i++) if (segs[i].startSeconds <= seconds) found = segs[i];
    return { seg: found, local: Math.max(0, seconds - found.startSeconds) };
  }
  function seekTo(seconds: number) {
    if (!manifest) return;
    const t = Math.min(Math.max(0, seconds), Math.max(0, manifest.durationSeconds - 1));
    const at = partAt(t);
    if (part && at.seg.index === part.index) audio.currentTime = at.local;
    else openPart(at.seg, at.local, wantPlaying);
    paint();
    showHud();
  }
  function toggle() {
    if (audio.paused) {
      wantPlaying = true;
      const p = audio.play();
      if (p && p.catch) p.catch(() => undefined);
    } else {
      wantPlaying = false;
      audio.pause();
    }
    showHud();
  }

  function fetchManifest(trackId: string): Promise<AudioManifest> {
    return fetch("/api/audiobooks/" + trackId + "/manifest", { credentials: "same-origin" }).then((res) => {
      if (res.status === 401 || res.status === 403) {
        window.location.href = "/tv";
        throw new Error("Signed out.");
      }
      if (res.status === 429) throw new Error("The demo has reached today's play limit. Try again tomorrow.");
      if (res.status === 409) throw new Error("This isn't ready to play yet. Try again in a few minutes.");
      if (!res.ok) throw new Error("This can't be played right now.");
      return res.json();
    });
  }

  function load(resumeFrom?: number, autoplay?: boolean) {
    say("Loading…");
    // The next song's details are fetched ahead of time, so moving on waits for the audio only, not for a round trip first.
    const ahead = prefetched && prefetched.id === id ? prefetched.manifest : null;
    prefetched = null;
    const seq = ++loadSeq;
    (ahead || fetchManifest(id))
      .then((m: AudioManifest) => {
        if (seq !== loadSeq) return;
        manifest = m;
        speed.applyDefault(m.defaultRate);
        const resume = cfg.remembers && m.resumeSeconds > 0 && m.resumeSeconds < m.durationSeconds - 30 ? m.resumeSeconds : 0;
        const at = partAt(resumeFrom !== undefined ? resumeFrom : resume);
        say("");
        openPart(at.seg, at.local, autoplay === undefined ? true : autoplay);
      })
      .catch((e: Error) => {
        if (seq === loadSeq) say(e.message || "This can't be played right now.");
      });
  }

  /** Moves on to song `i` of the album without loading a page, and keeps the address and the screen in step. */
  function goToSong(i: number) {
    if (!queue) return;
    const item = queue[i];
    qi = i;
    id = item.id;
    manifest = null;
    part = null;
    recoveries = 0;
    const ttl = doc.getElementById("ttl");
    const by = doc.getElementById("by");
    if (ttl) ttl.textContent = item.title;
    if (by) by.textContent = item.by || "";
    doc.title = item.title + " · Roam";
    const base = window.location.pathname.replace(/\/listen\/[^/]+$/, "");
    try {
      window.history.replaceState(null, "", base + "/listen/" + item.id + window.location.search);
    } catch {
      /* the address is only cosmetic */
    }
    cfg.next = i + 1 < queue.length ? base + "/listen/" + queue[i + 1].id : null;
    paintQueue();
    const cover = item.cover !== undefined ? item.cover : (cfg.queue && cfg.queue.cover) || null; // an artist queue names each song's own cover (or none)
    showCover(cover);
    tellSystem(item.title, item.by, cover);
    load(undefined, true);
  }

  audio.addEventListener("timeupdate", () => {
    paint();
    if (queue && manifest && !prefetched && qi + 1 < queue.length && manifest.durationSeconds - position() < 30) {
      const nextId = queue[qi + 1].id;
      const ahead = fetchManifest(nextId);
      prefetched = { id: nextId, manifest: ahead };
      ahead.catch(() => {
        if (prefetched && prefetched.manifest === ahead) prefetched = null; // fetched again when the song comes up
      });
    }
    if (Date.now() - lastSave > SAVE_EVERY_MS && !audio.paused) save();
  });
  audio.addEventListener("playing", () => {
    recoveries = 0;
    say("");
    showHud();
    keepAwake(true);
  });
  audio.addEventListener("waiting", () => say("Buffering…"));
  audio.addEventListener("pause", () => {
    showHud();
    save();
    if (audio.ended) return; // the next song may be starting; keep the screen awake
    keepAwake(false);
  });
  audio.addEventListener("ended", () => {
    if (!manifest || !part) return;
    const nextPart = manifest.segments[part.index + 1];
    if (nextPart) return openPart(nextPart, 0, true);
    save(true, true);
    if (queue && qi + 1 < queue.length) return goToSong(qi + 1);
    window.location.href = cfg.next || cfg.back;
  });
  audio.addEventListener("error", () => {
    // Usually a link that expired while paused: ask again and carry on from the same spot (twice at most).
    if (manifest && recoveries < 2) {
      recoveries++;
      load(position(), wantPlaying);
    } else say("Playback failed. Press Back and try again.");
  });
  window.addEventListener("pagehide", () => save(undefined, true));

  playerKeys = (action: Action | null, dirKey: string | null): boolean => {
    if (speed.isOpen()) return speed.key(action, dirKey);
    if (action === "back" || action === "stop") {
      save(undefined, true);
      window.location.href = cfg.back;
      return true;
    }
    if (action === "playpause" || action === "enter") return toggle(), true;
    if (action === "play") return audio.paused ? (toggle(), true) : true;
    if (action === "pause") return audio.paused ? true : (toggle(), true);
    if (action === "forward" || dirKey === "right") return seekTo(position() + (action === "forward" ? cfg.skip * 3 : cfg.skip)), true;
    if (action === "rewind" || dirKey === "left") return seekTo(position() - (action === "rewind" ? cfg.skip * 3 : cfg.skip)), true;
    if (queue && dirKey === "down") return qi + 1 < queue.length ? (goToSong(qi + 1), true) : (showHud(), true);
    if (queue && dirKey === "up") return previousSong(), true;
    // A song queue uses Up and Down for songs; anything else (an audiobook, an audio file) uses Up for the speed.
    if (!queue && dirKey === "up") return speed.open(), showHud(), true;
    if (dirKey === "up" || dirKey === "down") return showHud(), true;
    return false;
  };
  bar.style.display = "block";
  const speedHint = doc.getElementById("speedhint");
  if (queue && speedHint && speedHint.parentNode) speedHint.parentNode.removeChild(speedHint);
  if (MODERN) {
    const bg = doc.querySelector(".listen .bg img[data-src]");
    if (bg) bg.setAttribute("src", bg.getAttribute("data-src") || "");
  }
  paintQueue();
  if (queue) tellSystem(queue[qi].title, queue[qi].by, queue[qi].cover || cfg.queue?.cover || null);
  load();
}

// ── Pictures ─────────────────────────────────────────────────────────────

interface PhotoConfig {
  prev: string | null;
  next: string | null;
  back: string;
  nextImage?: string | null;
  saver?: boolean;
}

const SLIDE_MS = 6000;

function startPhotoViewer(cfg: PhotoConfig) {
  const img = doc.getElementById("pimg") as HTMLImageElement;
  const status = doc.getElementById("status") as HTMLElement;
  const hud = doc.getElementById("hud") as HTMLElement;
  let slideshow = window.location.hash === "#slide" || !!cfg.saver;
  let slideTimer: number | undefined;
  let hudTimer: number | undefined;

  const go = (href: string | null, keepShow: boolean) => {
    if (!href) return;
    window.location.href = href + (keepShow && slideshow ? "#slide" : "");
  };
  function showHud() {
    hud.className = "hud on";
    if (hudTimer) window.clearTimeout(hudTimer);
    hudTimer = window.setTimeout(() => {
      hud.className = "hud";
    }, 4000);
  }
  function armSlideshow() {
    if (slideTimer) window.clearTimeout(slideTimer);
    if (slideshow && cfg.next) slideTimer = window.setTimeout(() => go(cfg.next, true), SLIDE_MS);
  }
  const failed = () => {
    status.textContent = "This picture can't be shown.";
    status.style.display = "block";
    armSlideshow();
  };
  img.addEventListener("error", failed);
  img.addEventListener("load", armSlideshow);
  // The picture may have finished (or failed) before this script started, in which case neither event will fire.
  if (img.complete) {
    if (img.naturalWidth > 0) armSlideshow();
    else failed();
  }
  showHud();
  keepAwake(slideshow);
  if (MODERN && cfg.nextImage) {
    // Fetch the next picture while this one is on screen, so the slideshow never waits for it.
    const ahead = new Image();
    ahead.src = cfg.nextImage;
  }

  playerKeys = (action: Action | null, dirKey: string | null): boolean => {
    if (action === "back" || action === "stop") return keepAwake(false), go(cfg.back, false), true;
    if (dirKey === "right" || action === "forward") return go(cfg.next, true), true;
    if (dirKey === "left" || action === "rewind") return go(cfg.prev, true), true;
    if (action === "enter" || action === "playpause" || action === "play" || action === "pause") {
      slideshow = action === "pause" ? false : action === "play" ? true : !slideshow;
      keepAwake(slideshow);
      status.textContent = slideshow ? "Slideshow" : "Slideshow stopped";
      status.style.display = "block";
      window.setTimeout(() => {
        status.style.display = "none";
      }, 1500);
      armSlideshow();
      showHud();
      return true;
    }
    if (dirKey === "up" || dirKey === "down") return showHud(), true;
    return false;
  };
}

let playerKeys: ((action: Action | null, dirKey: string | null) => boolean) | null = null;

// ── Newer browsers ────────────────────────────────────────────────────────

/**
 * Whether to add the extras that older TV browsers can't do well (backdrop pictures, softer focus, songs that move on without
 * loading a page). Asks the browser what it can do rather than trusting its name. Off when the server says so (TV_BASIC_ONLY=1),
 * and for one TV when its address carries ?modern=0 (?modern=1 turns it back on): the owner's way to rescue a TV that misbehaves.
 */
function modernBrowser(): boolean {
  try {
    const set = /[?&]modern=([01])(?:&|$)/.exec(window.location.search);
    if (set) window.localStorage.setItem("roamTvModern", set[1]);
  } catch {
    /* storage may be unavailable; the page still works */
  }
  if (doc.documentElement.getAttribute("data-basic")) return false;
  try {
    if (window.localStorage.getItem("roamTvModern") === "0") return false;
  } catch {
    /* ignore */
  }
  return !!(window.CSS && window.CSS.supports && window.CSS.supports("display", "grid") && typeof IntersectionObserver !== "undefined");
}
const MODERN = modernBrowser();

interface WakeLockSentinelLike {
  release(): Promise<void>;
  addEventListener?(type: "release", fn: () => void): void;
}
let wakeLock: WakeLockSentinelLike | null = null;
let wakeWanted = false;
let wakePending = false;

function acquireWake() {
  const api = (navigator as unknown as { wakeLock?: { request(type: string): Promise<WakeLockSentinelLike> } }).wakeLock;
  if (!MODERN || !api || !wakeWanted || wakeLock || wakePending) return;
  wakePending = true;
  api.request("screen").then(
    (lock) => {
      wakePending = false;
      if (!wakeWanted) {
        lock.release().then(undefined, () => undefined); // no longer wanted by the time it was granted
        return;
      }
      wakeLock = lock;
      // The system can take it back (the page was hidden); then it is asked for again when the page returns.
      if (lock.addEventListener)
        lock.addEventListener("release", () => {
          if (wakeLock === lock) wakeLock = null;
        });
    },
    () => {
      wakePending = false;
    }
  );
}

/** Asks a newer browser not to dim the screen or sleep while music or a slideshow plays (video keeps the TV awake by itself). */
function keepAwake(on: boolean) {
  wakeWanted = on;
  if (on) acquireWake();
  else if (wakeLock) {
    const lock = wakeLock;
    wakeLock = null;
    lock.release().then(undefined, () => undefined);
  }
}
doc.addEventListener("visibilitychange", () => {
  if (!doc.hidden) acquireWake();
});

/** After a quiet spell on the home screen, a newer browser starts the picture screensaver (any key resets the wait). */
let idleTimer: number | undefined;
let idleArmedAt = 0;
function armIdle() {
  idleArmedAt = Date.now();
  const el = doc.querySelector("[data-saver]");
  if (!MODERN || !el) return;
  window.clearTimeout(idleTimer);
  const seconds = Number(el.getAttribute("data-saver-after")) || 300;
  idleTimer = window.setTimeout(() => {
    window.location.href = el.getAttribute("data-saver") || "/tv";
  }, seconds * 1000);
}

/** Marks the page and loads the wide pictures that only newer browsers get (the basic page never downloads them). */
function enhance() {
  if (!MODERN) return;
  doc.documentElement.className += " modern";
  const imgs = doc.querySelectorAll(".backdrop img[data-src]");
  for (let i = 0; i < imgs.length; i++) imgs[i].setAttribute("src", imgs[i].getAttribute("data-src") || "");
}

// ── "More" buttons ───────────────────────────────────────────────────────

/** A More button shows or hides the actions behind it, in place (hidden ones can't be reached with the arrows). */
doc.addEventListener("click", (e: MouseEvent) => {
  const target = e.target as Element | null;
  const toggle = target && target.closest ? target.closest("[data-more-toggle]") : null;
  if (!toggle || !toggle.parentNode) return;
  const wrap = toggle.parentNode as HTMLElement;
  const opening = wrap.className.indexOf(" open") < 0;
  wrap.className = opening ? wrap.className + " open" : wrap.className.replace(" open", "");
  if (opening) {
    // Bring the whole revealed row into view (the last one first, then the first, which also takes the highlight), so
    // nothing opens below the bottom edge of the screen.
    const revealed = wrap.querySelectorAll(".more-item [data-f]");
    if (revealed.length) reveal(revealed[revealed.length - 1] as HTMLElement);
    const first = revealed[0] as HTMLElement | undefined;
    if (first) focusEl(first);
  }
});

// ── Wiring ───────────────────────────────────────────────────────────────

// A pointer remote (moving or clicking) counts as activity too, not only the arrow keys.
const onPointer = () => {
  if (Date.now() - idleArmedAt > 1000) armIdle();
};
doc.addEventListener("mousemove", onPointer);
doc.addEventListener("click", onPointer);
doc.addEventListener("touchstart", onPointer);

doc.addEventListener("keydown", (e: KeyboardEvent) => {
  armIdle();
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
  enhance();
  armIdle();
  try {
    if (typeof tizen !== "undefined" && tizen && tizen.tvinputdevice) for (let i = 0; i < TIZEN_MEDIA_KEYS.length; i++) tizen.tvinputdevice.registerKey(TIZEN_MEDIA_KEYS[i]);
  } catch {
    /* not on a Samsung TV, or the app lacks the privilege */
  }
  const cfgEl = doc.getElementById("play-config");
  if (cfgEl) return startPlayer(JSON.parse(cfgEl.textContent || "{}") as PlayConfig);
  const listenEl = doc.getElementById("listen-config");
  if (listenEl) return startListening(JSON.parse(listenEl.textContent || "{}") as ListenConfig);
  const photoEl = doc.getElementById("photo-config");
  if (photoEl) return startPhotoViewer(JSON.parse(photoEl.textContent || "{}") as PhotoConfig);
  const start = doc.querySelector("[data-autofocus]") as HTMLElement | null;
  const items = visibleItems();
  const more = doc.querySelector("a[data-more]");
  if (more && MODERN) more.className += " auto"; // the next page loads by itself; the button stays as a fallback
  const focusFirst = () => {
    if (start) focusEl(start);
    else if (items.length) focusEl(items[0]);
  };
  if (!restoreFocus(focusFirst)) focusFirst();
  // A page that polls (the pairing screen) names its script-free refresh target.
  const poll = doc.querySelector("[data-poll]");
  if (poll) startPolling(poll as HTMLElement);
}

/** The pairing screen: ask the server every few seconds whether the code has been approved, and go on when it has. */
function startPolling(el: HTMLElement) {
  const url = el.getAttribute("data-poll") || "";
  const done = el.getAttribute("data-done") || "/tv";
  const gone = el.getAttribute("data-expired") || window.location.href;
  const giveUp = Date.now() + 11 * 60 * 1000; // a code lasts ten minutes; after that, ask for a new one
  const tick = () => {
    if (Date.now() > giveUp) {
      window.location.href = gone;
      return;
    }
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
