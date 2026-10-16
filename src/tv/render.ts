/**
 * HTML for Roam's TV pages, built as plain strings: the pages must work on a 2018 TV's browser, so no React reaches them. Every
 * value that came from a library (names, descriptions, addresses) goes through `esc` or `attr` on its way in.
 */

export const esc = (s: string | number | null | undefined): string =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

/** An address that is safe to put in href or src: a path on this site or an https address, never javascript: or data:. */
export function safeUrl(url: string | null | undefined): string | null {
  const u = (url ?? "").trim();
  // A leading "/\" is read by browsers as "//" (another site), so a backslash or control character anywhere rules the address out.
  if (/[\\\u0000-\u001f\u007f]/.test(u)) return null;
  if (/^\/(?!\/)/.test(u) || /^https:\/\//i.test(u)) return u;
  return null;
}

/** Changes whenever the deployed build does, so a TV that cached the script or stylesheet fetches the new one. */
export const ASSET_VERSION = (process.env.VERCEL_GIT_COMMIT_SHA ?? "dev").slice(0, 8);

export function tvDocument(opts: { title: string; body: string; script?: boolean; bodyClass?: string }): string {
  return (
    `<!doctype html><html lang="en"${process.env.TV_BASIC_ONLY === "1" ? ' data-basic="1"' : ""}><head><meta charset="utf-8"><title>${esc(opts.title)} · Roam</title>` +
    `<meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/tv/tv.css?v=${ASSET_VERSION}"></head>` +
    `<body${opts.bodyClass ? ` class="${esc(opts.bodyClass)}"` : ""}>${opts.body}` +
    (opts.script === false ? "" : `<script src="/tv/tv.js?v=${ASSET_VERSION}"></script>`) +
    `</body></html>`
  );
}

/** A button that sends a POST (for anything that changes state): a focusable submit button works with the remote's OK key. */
export const postButton = (action: string, label: string, opts: { autofocus?: boolean; fields?: Record<string, string>; className?: string } = {}): string =>
  `<form method="post" action="${esc(action)}" style="display:inline">${Object.entries(opts.fields ?? {}).map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join("")}` +
  `<button type="submit" class="${esc(opts.className ?? "btn")}" data-f${opts.autofocus ? " data-autofocus" : ""}>${esc(label)}</button></form>`;

/** The most action buttons shown at once; any beyond this sit behind a More button. */
export const MAX_ACTIONS = 2;

/**
 * A row of action buttons: the first MAX_ACTIONS as they are, the rest hidden behind a "More" button that shows them in place
 * (the script toggles it; hidden things can't be reached with the arrows). `items` are already-rendered buttons and links.
 */
export function actionRow(items: string[]): string {
  const shown = items.slice(0, MAX_ACTIONS).join("");
  const rest = items.slice(MAX_ACTIONS);
  if (rest.length === 0) return shown;
  return `${shown}<span class="morewrap"><button type="button" class="btn" data-f data-more-toggle>More</button>${rest.map((x) => `<span class="more-item">${x}</span>`).join("")}</span>`;
}

const top = (right = "") => `<div class="top"><span class="brand">ROAM</span><span class="sub" style="margin:0">${right}</span></div>`;

// ── Pairing ──────────────────────────────────────────────────────────────

export function pairPage(args: { userCode: string; linkUrl: string; pollUrl: string; expiredUrl: string; qr?: string }): string {
  return tvDocument({
    title: "Sign in",
    body:
      `<div class="page" data-poll="${esc(args.pollUrl)}" data-done="/tv" data-expired="${esc(args.expiredUrl)}">${top()}` +
      `<h1>Sign in to Roam</h1>` +
      `<div class="pair">${args.qr ? `<div class="qrbox">${args.qr}<p class="note" style="text-align:center;margin-top:0.6rem">Scan with your phone</p></div>` : ""}<div>` +
      `<p class="sub">Or on your phone or computer, open</p><p class="sub" style="color:#ececf1;font-size:1.8rem">${esc(args.linkUrl)}</p>` +
      `<p class="sub">and enter this code:</p><div class="code">${esc(args.userCode)}</div></div></div>` +
      `<p class="note">This screen continues by itself once you approve it. The code works for ten minutes.</p></div>`,
  });
}

export function messagePage(title: string, message: string, link?: { href: string; label: string; post?: boolean }): string {
  return tvDocument({
    title,
    body: `<div class="page">${top()}<h1>${esc(title)}</h1><p class="msg">${esc(message)}</p>${link ? (link.post ? postButton(link.href, link.label, { autofocus: true, className: "btn primary" }) : `<a class="btn primary" data-f data-autofocus href="${esc(safeUrl(link.href) ?? "/tv")}">${esc(link.label)}</a>`) : ""}</div>`,
  });
}

// ── Browsing ─────────────────────────────────────────────────────────────

export interface Poster {
  href: string;
  name: string;
  meta?: string | null;
  posterUrl: string | null;
  /** 0..1, for a bar under a card (continue watching). */
  progress?: number | null;
  /** A square picture (album covers, photos) rather than a tall poster. */
  square?: boolean;
}

export const card = (p: Poster, autofocus = false): string => {
  const img = safeUrl(p.posterUrl);
  return (
    `<a class="card${p.square ? " sq" : ""}" data-f${autofocus ? " data-autofocus" : ""} href="${esc(safeUrl(p.href) ?? "/tv")}"><span class="poster">${img ? `<img src="${esc(img)}" alt="" loading="lazy">` : ""}</span>` +
    `<span class="name">${esc(p.name)}</span>${p.meta ? `<span class="meta">${esc(p.meta)}</span>` : ""}` +
    (p.progress ? `<span class="bar"><b style="width:${Math.round(Math.min(1, Math.max(0, p.progress)) * 100)}%"></b></span>` : "") +
    `</a>`
  );
};

export interface HomeData {
  serverName: string;
  base: string;
  profileName: string;
  continueWatching: Poster[];
  /** The next episode of each show being watched. */
  upNext?: Poster[];
  /** Titles like the ones the profile rated highly. */
  recommended?: Poster[];
  continueListening?: Poster[];
  recentlyAdded?: Poster[];
  /** Whether this profile has any playlists to show. */
  hasPlaylists?: boolean;
  /** Show the Settings button (a profile that may change its own settings). */
  hasSettings?: boolean;
  /** Unread notifications; the button shows when there are any. */
  unread?: number;
  /** A screensaver of the profile's pictures, started by a newer browser after a quiet spell on this page. */
  screensaver?: { href: string; afterSeconds: number } | null;
  libraries: { id: string; name: string; kind: string; count?: number | null }[];
  /** Libraries that exist but have no TV interface yet. */
  unsupported: number;
}

export function homePage(d: HomeData): string {
  const cont = d.continueWatching.length
    ? `<h2>Continue watching</h2><div class="row">${d.continueWatching.map((c, i) => card(c, i === 0)).join("")}</div>`
    : "";
  const next = d.upNext?.length ? `<h2>Up next</h2><div class="row">${d.upNext.map((c, i) => card(c, i === 0 && !cont)).join("")}</div>` : "";
  const picks = d.recommended?.length ? `<h2>Recommended for you</h2><div class="row">${d.recommended.map((c, i) => card(c, i === 0 && !cont && !next)).join("")}</div>` : "";
  const listening = d.continueListening?.length
    ? `<h2>Continue listening</h2><div class="row">${d.continueListening.map((c, i) => card(c, i === 0 && !cont && !next && !picks)).join("")}</div>`
    : "";
  const recent = d.recentlyAdded?.length
    ? `<h2>Recently added</h2><div class="row">${d.recentlyAdded.map((c, i) => card(c, i === 0 && !cont && !next && !picks && !listening)).join("")}</div>`
    : "";
  const first = !cont && !next && !picks && !listening && !recent;
  const libs = d.libraries.length
    ? `<h2>Libraries</h2><div class="row">${d.libraries.map((l, i) => `<a class="tile" data-f${first && i === 0 ? " data-autofocus" : ""} href="${esc(d.base)}/library/${esc(l.id)}">${esc(l.name)}<small>${esc(l.kind)}</small></a>`).join("")}</div>`
    : `<p class="sub">Nothing to show here yet.</p>`;
  const more = d.unsupported > 0 ? `<p class="note">${d.unsupported} more ${d.unsupported === 1 ? "library isn't" : "libraries aren't"} available on TV yet.</p>` : "";
  return tvDocument({
    title: d.serverName,
    body: `<div class="page"${d.screensaver ? ` data-saver="${esc(safeUrl(d.screensaver.href) ?? "")}" data-saver-after="${Math.max(1, Math.floor(d.screensaver.afterSeconds))}"` : ""}>${top(esc(d.profileName))}<h1>${esc(d.serverName)}</h1>${cont}${next}${picks}${listening}${recent}${libs}${more}<div class="row" style="margin-top:2rem">${actionRow([`<a class="btn" data-f href="${esc(d.base)}/search">Search</a>`, ...(d.hasPlaylists ? [`<a class="btn" data-f href="${esc(d.base)}/playlists">Playlists</a>`] : []), ...(d.unread ? [`<a class="btn" data-f href="${esc(d.base)}/notifications">Notifications (${d.unread})</a>`] : []), ...(d.hasSettings ? [`<a class="btn" data-f href="${esc(d.base)}/settings">Settings</a>`] : []), `<a class="btn" data-f href="/tv/profiles">Switch profile</a>`, postButton("/tv/signout", "Sign out")])}</div></div>`,
  });
}

export interface ListData {
  base: string;
  title: string;
  subtitle?: string | null;
  backHref: string;
  items: Poster[];
  /** Buttons at the top of the page (Play all, Shuffle...): two show, the rest sit behind More. */
  actions?: { href: string; name: string; note?: string }[];
  /** Subfolders to open before the items. */
  folders?: { href: string; name: string; note?: string }[];
  /** Link to the next page, or null. */
  nextHref: string | null;
  prevHref: string | null;
  /** Buttons for sorting and narrowing the list (each leads to the same list, changed). */
  toolbar?: { href: string; label: string }[];
  /** A row of letters to jump to. */
  letters?: { href: string; label: string }[];
}

export function listPage(d: ListData): string {
  const body =
    `<div class="page">${top(`<a data-f data-back href="${esc(d.backHref)}" class="btn" style="margin:0">Back</a>`)}<h1>${esc(d.title)}</h1>${d.subtitle ? `<p class="sub">${esc(d.subtitle)}</p>` : ""}` +
    (d.actions?.length ? `<div class="row">${actionRow(d.actions.map((f, i) => `<a class="tile folder" data-f${i === 0 ? " data-autofocus" : ""} href="${esc(safeUrl(f.href) ?? "/tv")}">${esc(f.name)}<small>${esc(f.note ?? "")}</small></a>`))}</div>` : "") +
    (d.toolbar?.length ? `<div class="row">${d.toolbar.map((t) => `<a class="btn" data-f href="${esc(safeUrl(t.href) ?? "/tv")}">${esc(t.label)}</a>`).join("")}</div>` : "") +
    (d.letters?.length ? `<div class="letters">${d.letters.map((l) => `<a class="key" data-f href="${esc(safeUrl(l.href) ?? "/tv")}">${esc(l.label)}</a>`).join("")}</div>` : "") +
    (d.folders?.length ? `<div class="row">${d.folders.map((f, i) => `<a class="tile folder" data-f${i === 0 && !d.actions?.length ? " data-autofocus" : ""} href="${esc(safeUrl(f.href) ?? "/tv")}">${esc(f.name)}<small>${esc(f.note ?? "Folder")}</small></a>`).join("")}</div>` : "") +
    (d.items.length ? `<div class="row" data-cards>${d.items.map((c, i) => card(c, i === 0 && !d.folders?.length && !d.actions?.length)).join("")}</div>` : d.folders?.length || d.actions?.length ? "" : `<p class="sub">Nothing here yet.</p>`) +
    `<div class="row">${d.prevHref ? `<a class="btn" data-f href="${esc(d.prevHref)}">Previous</a>` : ""}${d.nextHref ? `<a class="btn" data-f data-more href="${esc(d.nextHref)}">More</a>` : ""}</div></div>`;
  return tvDocument({ title: d.title, body });
}

export interface DetailData {
  title: string;
  meta: string;
  overview: string | null;
  posterUrl: string | null;
  backHref: string;
  actions: { href: string; label: string; primary?: boolean }[];
  /** Buttons that change something (a POST), shown with the actions: "Mark as watched". */
  posts?: { action: string; label: string; fields: Record<string, string> }[];
  /** Episodes of one season, for a show. */
  episodes?: { href: string; label: string; sub?: string | null }[];
  /** The heading over `episodes` (songs on an album); "Episodes" by default. */
  listHeading?: string;
  /** A square cover, not a tall poster. */
  square?: boolean;
  /** A wide picture behind the page, shown only on browsers new enough to do it well (the basic page never downloads it). */
  backdropUrl?: string | null;
  seasons?: { href: string; label: string; current: boolean }[];
  /** More under the episodes or the actions: the parental guide, chapters, extras, who owns it. */
  sections?: TvSection[];
}

/** A titled block on a detail page: lines (a link when it has an address, so the remote can reach it) and buttons that change something. */
export interface TvSection {
  heading: string;
  lines: { text: string; sub?: string | null; href?: string | null }[];
  posts?: { action: string; label: string; fields: Record<string, string> }[];
  /** Small print under the lines (a credit, a reminder). */
  note?: string | null;
}

function sectionHtml(s: TvSection): string {
  const lines = s.lines.map((l) => (l.href ? `<a class="ep" data-f href="${esc(safeUrl(l.href) ?? "/tv")}">${esc(l.text)}${l.sub ? `<small>${esc(l.sub)}</small>` : ""}</a>` : `<p class="line">${esc(l.text)}${l.sub ? `<small>${esc(l.sub)}</small>` : ""}</p>`)).join("");
  const posts = s.posts?.length ? `<div class="row">${s.posts.map((p) => postButton(p.action, p.label, { fields: p.fields })).join("")}</div>` : "";
  return `<h2>${esc(s.heading)}</h2>${lines}${s.note ? `<p class="line small">${esc(s.note)}</p>` : ""}${posts}`;
}

export function detailPage(d: DetailData): string {
  const img = safeUrl(d.posterUrl);
  const back = safeUrl(d.backdropUrl);
  const backdrop = back ? `<div class="backdrop"><img data-src="${esc(back)}" alt=""></div>` : "";
  const actions = actionRow([
    ...d.actions.map((a, i) => `<a class="btn${a.primary ? " primary" : ""}" data-f${i === 0 ? " data-autofocus" : ""} href="${esc(safeUrl(a.href) ?? "/tv")}">${esc(a.label)}</a>`),
    ...(d.posts ?? []).map((p, i) => postButton(p.action, p.label, { fields: p.fields, autofocus: d.actions.length === 0 && i === 0 })),
  ]);
  const seasons = d.seasons?.length ? `<div class="row">${d.seasons.map((s) => `<a class="btn${s.current ? " primary" : ""}" data-f href="${esc(safeUrl(s.href) ?? "/tv")}">${esc(s.label)}</a>`).join("")}</div>` : "";
  const eps = d.episodes?.length ? `<h2>${esc(d.listHeading ?? "Episodes")}</h2>${d.episodes.map((e) => `<a class="ep" data-f href="${esc(safeUrl(e.href) ?? "/tv")}">${esc(e.label)}${e.sub ? `<small>${esc(e.sub)}</small>` : ""}</a>`).join("")}` : "";
  const more = (d.sections ?? []).map(sectionHtml).join("");
  return tvDocument({
    title: d.title,
    body:
      `${backdrop}<div class="page">${top(`<a data-f data-back href="${esc(d.backHref)}" class="btn" style="margin:0">Back</a>`)}` +
      `<div class="detail"><span class="poster${d.square ? " sq" : ""}">${img ? `<img src="${esc(img)}" alt="">` : ""}</span><div class="text"><h1>${esc(d.title)}</h1><p class="sub">${esc(d.meta)}</p>` +
      (d.overview ? `<p class="overview">${esc(d.overview)}</p>` : "") +
      `<div>${actions}</div>${seasons}</div></div>${eps}${more}</div>`,
  });
}

export interface WatchData {
  title: string;
  subtitle: string | null;
  ownerKind: "title" | "episode" | "extra";
  ownerId: string;
  back: string;
  next: string | null;
  /** Where to start, in seconds (opened at a chapter); otherwise where the viewer left off. */
  start?: number;
}

/** What the player needs to know about one watch page (nothing from the library: names are drawn by the page itself). */
export function watchConfig(d: WatchData) {
  return { ownerKind: d.ownerKind, ownerId: d.ownerId, back: safeUrl(d.back) ?? "/tv", next: d.next ? safeUrl(d.next) : null, ...(d.start !== undefined ? { start: d.start } : {}) };
}

export function watchPage(d: WatchData): string {
  const cfg = JSON.stringify(watchConfig(d)).replace(/</g, "\\u003c");
  return tvDocument({
    title: d.title,
    bodyClass: "watch",
    body:
      `<div class="player"><video id="pv" playsinline></video><div id="status" class="status"></div><div id="upnext" class="upnext" style="display:none"></div><div id="skipbtn" class="skipbtn" style="display:none"></div><div id="speedbox" class="speedbox" style="display:none"></div><div id="subs" class="subs"></div><div id="subpicker" class="speedbox" style="display:none"></div><div id="settingsbox" class="speedbox" style="display:none"></div><div id="qualitybox" class="speedbox" style="display:none"></div>` +
      `<div id="hud" class="hud on"><div class="t"><span id="wtitle">${esc(d.title)}</span><span id="wsub">${d.subtitle ? ` · ${esc(d.subtitle)}` : ""}</span></div><div id="bar" class="track" style="display:none"><b id="fill"></b></div><div id="clock" class="clock"></div><div class="hint" id="vhint">Up: settings</div></div></div>` +
      `<script type="application/json" id="play-config">${cfg}</script>`,
  });
}

/** The PIN pad for a profile protected by a PIN: digits are buttons the remote can reach; four digits send the PIN (the page's script does that, without putting it in the address). */
export function pinPage(args: { profileName: string; viewerId: string; selectUrl: string; error?: string | null; backHref?: string; heading?: string }): string {
  const digit = (d: string, i: number) => `<button type="button" class="btn key" data-f data-pin-digit="${d}"${i === 0 ? " data-autofocus" : ""}>${d}</button>`;
  return tvDocument({
    title: "Enter your PIN",
    body:
      `<div class="page">${top(`<a data-f data-back href="${esc(safeUrl(args.backHref ?? "/tv/profiles") ?? "/tv/profiles")}" class="btn" style="margin:0">Back</a>`)}<h1>${esc(args.profileName)}</h1><p class="msg">${esc(args.heading ?? "Enter your PIN")}</p>` +
      (args.error ? `<p class="msg" role="alert">${esc(args.error)}</p>` : "") +
      `<form method="post" action="${esc(args.selectUrl)}" id="pinform"><input type="hidden" name="viewer" value="${esc(args.viewerId)}"><input type="hidden" name="pin" id="pinvalue" value="">` +
      `<p class="pindots" id="pindots" aria-live="polite">○ ○ ○ ○</p></form>` +
      `<div class="row">${["1", "2", "3", "4", "5"].map(digit).join("")}</div><div class="row">${["6", "7", "8", "9", "0"].map(digit).join("")}</div>` +
      `<div class="row"><button type="button" class="btn" data-f data-pin-delete>Delete</button></div></div>`,
  });
}

export function profilesPage(args: { profiles: { id: string; name: string; locked?: boolean }[]; selectUrl: string }): string {
  return tvDocument({
    title: "Who's watching?",
    body:
      `<div class="page">${top()}<h1>Who's watching?</h1><div class="row">` +
      args.profiles.map((p, i) => postButton(args.selectUrl, p.locked ? `${p.name} (PIN)` : p.name, { autofocus: i === 0, fields: { viewer: p.id }, className: "tile" })).join("") +
      `</div></div>`,
  });
}

export function serversPage(list: { id: string; name: string }[]): string {
  return tvDocument({
    title: "Choose a server",
    body: `<div class="page">${top()}<h1>Choose a server</h1><div class="row">${list.map((s, i) => `<a class="tile" data-f${i === 0 ? " data-autofocus" : ""} href="/tv/s/${esc(s.id)}">${esc(s.name)}</a>`).join("")}</div></div>`,
  });
}


// ── Listening ─────────────────────────────────────────────────────────

export interface ListenData {
  title: string;
  subtitle: string | null;
  coverUrl: string | null;
  ownerId: string;
  /** Whether the profile's place is saved (audiobooks and audio files, not songs). */
  remembers: boolean;
  /** Skip size in seconds for the left and right keys: long for books, short for songs. */
  skip: number;
  back: string;
  next: string | null;
  /** An album's songs in order and which one this is, so newer browsers can move on to the next song without loading a new page. */
  queue?: { items: { id: string; title: string; by: string | null; cover?: string | null }[]; index: number; cover?: string | null } | null;
}

export function listenPage(d: ListenData): string {
  const cfg = JSON.stringify({ ownerKind: "title", ownerId: d.ownerId, remembers: d.remembers, skip: d.skip, back: safeUrl(d.back) ?? "/tv", next: d.next ? safeUrl(d.next) : null, queue: d.queue ?? null }).replace(/</g, "\\u003c");
  const img = safeUrl(d.coverUrl);
  return tvDocument({
    title: d.title,
    bodyClass: "watch",
    body:
      `<div class="player listen"><audio id="pa"></audio>${img || d.queue ? `<div class="bg"><img id="bgimg"${img ? ` data-src="${esc(img)}"` : ""} alt=""></div>` : ""}<div class="cover">${img || d.queue ? `<img id="coverimg"${img ? ` src="${esc(img)}"` : ""} alt="">` : ""}</div>` +
      `<div class="now"><div class="t" id="ttl">${esc(d.title)}</div><div class="by" id="by">${d.subtitle ? esc(d.subtitle) : ""}</div></div><div id="queuelist" class="queuelist"></div><div id="status" class="status"></div><div id="speedbox" class="speedbox" style="display:none"></div>` +
      `<div id="hud" class="hud on"><div id="bar" class="track" style="display:none"><b id="fill"></b></div><div id="clock" class="clock"></div><div class="hint" id="speedhint">Up: playback speed</div></div></div>` +
      `<script type="application/json" id="listen-config">${cfg}</script>`,
  });
}

// ── Pictures ──────────────────────────────────────────────────────────

export interface PhotoViewData {
  title: string;
  /** The picture shown full screen. */
  imageUrl: string;
  /** Where the left and right keys go (the page of the neighbouring item), and Back. */
  prev: string | null;
  next: string | null;
  back: string;
  position: string | null;
  /** The next picture's address, so a newer browser can fetch it before it is needed. */
  nextImage?: string | null;
  /** Shown as a screensaver: the slideshow starts by itself. */
  saver?: boolean;
}

export function photoViewPage(d: PhotoViewData): string {
  const cfg = JSON.stringify({ prev: d.prev ? safeUrl(d.prev) : null, next: d.next ? safeUrl(d.next) : null, back: safeUrl(d.back) ?? "/tv", nextImage: d.nextImage ? safeUrl(d.nextImage) : null, saver: !!d.saver }).replace(/</g, "\\u003c");
  return tvDocument({
    title: d.title,
    bodyClass: "watch",
    body:
      `<div class="player photo"><img id="pimg" src="${esc(safeUrl(d.imageUrl) ?? "")}" alt="${esc(d.title)}"><div id="status" class="status"></div>` +
      `<div id="hud" class="hud on"><div class="t">${esc(d.title)}</div><div class="clock">${d.position ? esc(d.position) + " · " : ""}Left and right for the previous and next picture, OK to start a slideshow</div></div></div>` +
      `<script type="application/json" id="photo-config">${cfg}</script>`,
  });
}

// ── Search ────────────────────────────────────────────────────────────

const KEYS = "abcdefghijklmnopqrstuvwxyz0123456789".split("");

export interface SearchData {
  base: string;
  query: string;
  /** The key that was just pressed, so focus returns to it after the page reloads. */
  focusKey: string | null;
  results: Poster[];
  max: number;
}

/** A search page with an on-screen keyboard: every key is a link that adds a letter, so it works with nothing but the arrows and OK. */
export function searchPage(d: SearchData): string {
  const at = (q: string, k: string) => `${esc(d.base)}/search?q=${encodeURIComponent(q)}&amp;k=${encodeURIComponent(k)}`;
  // Nothing pressed yet: start on the first key, so typing can begin straight away (Back is always on the Back key).
  const start = d.focusKey ?? "a";
  const full = d.query.length >= d.max;
  const letters = KEYS.map((c) => `<a class="key" data-f${start === c ? " data-autofocus" : ""} href="${full ? at(d.query, c) : at(d.query + c, c)}">${esc(c.toUpperCase())}</a>`).join("");
  const space = `<a class="key wide" data-f${start === "space" ? " data-autofocus" : ""} href="${full ? at(d.query, "space") : at(d.query + " ", "space")}">Space</a>`;
  const del = `<a class="key wide" data-f${start === "del" ? " data-autofocus" : ""} href="${at(d.query.slice(0, -1), "del")}">Delete</a>`;
  const clear = `<a class="key wide" data-f${start === "clear" ? " data-autofocus" : ""} href="${at("", "clear")}">Clear</a>`;
  const results = d.results.length
    ? d.results.map((r) => `<a class="hit" data-f href="${esc(safeUrl(r.href) ?? "/tv")}">${esc(r.name)}${r.meta ? `<small>${esc(r.meta)}</small>` : ""}</a>`).join("")
    : `<p class="sub">${d.query.trim() ? "Nothing found." : "Type to search your movies, shows, books and music."}</p>`;
  return tvDocument({
    title: "Search",
    body:
      `<div class="page">${top(`<a data-f data-back href="${esc(d.base)}" class="btn" style="margin:0">Back</a>`)}<h1>Search</h1>` +
      `<div class="query">${d.query ? esc(d.query) : "&nbsp;"}</div>` +
      `<div class="searchbox"><div class="keys">${letters}${space}${del}${clear}</div><div class="hits">${results}</div></div></div>`,
  });
}

// ── Playlists ─────────────────────────────────────────────────────────

export function playlistsPage(d: { base: string; lists: { href: string; name: string; note: string }[] }): string {
  const fresh = `<a class="tile" data-f${d.lists.length === 0 ? " data-autofocus" : ""} href="${esc(d.base)}/playlists/name">New playlist<small>Type a name</small></a>`;
  const body = `<div class="row">${d.lists.map((l, i) => `<a class="tile" data-f${i === 0 ? " data-autofocus" : ""} href="${esc(safeUrl(l.href) ?? "/tv")}">${esc(l.name)}<small>${esc(l.note)}</small></a>`).join("")}${fresh}</div>` + (d.lists.length ? "" : `<p class="sub">No playlists yet.</p>`);
  return tvDocument({
    title: "Playlists",
    body: `<div class="page">${top(`<a data-f data-back href="${esc(d.base)}" class="btn" style="margin:0">Back</a>`)}<h1>Playlists</h1>${body}</div>`,
  });
}

export interface AddToPlaylistData {
  base: string;
  /** What is being added (its name), for the heading. */
  what: string;
  /** The address of the thing being added: "title" or "episode" and its id. */
  target: { field: "title" | "episode" | "album" | "artist"; id: string };
  /** Where to go back to, an address on this server's TV pages. */
  back: string;
  playlists: { id: string; name: string; note: string }[];
  /** Offer "New playlist…" (name it, then it is added there). */
  canCreate?: boolean;
}

/** Choosing which playlist to add something to: each playlist is a button that sends a POST, which works with the remote's OK key. */
export function addToPlaylistPage(d: AddToPlaylistData): string {
  const list = d.playlists.length
    ? `<div class="row">${d.playlists.map((p, i) => postButton(`${d.base}/add`, p.name, { autofocus: i === 0, className: "tile", fields: { playlist: p.id, [d.target.field]: d.target.id, back: d.back } }).replace("</button>", `<small>${esc(p.note)}</small></button>`)).join("")}</div>`
    : "";
  const carry = new URLSearchParams({ [d.target.field]: d.target.id, back: d.back }).toString();
  const fresh = d.canCreate ? `<div class="row"><a class="tile" data-f${d.playlists.length === 0 ? " data-autofocus" : ""} href="${esc(d.base)}/playlists/name?${esc(carry)}">New playlist…<small>Name it, then add this</small></a></div>` : "";
  return tvDocument({
    title: "Add to a playlist",
    body: `<div class="page">${top(`<a data-f data-back href="${esc(safeUrl(d.back) ?? d.base)}" class="btn" style="margin:0">Back</a>`)}<h1>Add to a playlist</h1><p class="sub">${esc(d.what)}</p>${list}${fresh}</div>`,
  });
}

/** A page of lines (links where they lead somewhere): the notifications. */
export function linesPage(d: { title: string; backHref: string; lines: { text: string; sub?: string | null; href?: string | null }[]; empty: string }): string {
  const body = d.lines.length
    ? d.lines.map((l) => (l.href ? `<a class="ep" data-f href="${esc(safeUrl(l.href) ?? "/tv")}">${esc(l.text)}${l.sub ? `<small>${esc(l.sub)}</small>` : ""}</a>` : `<p class="line">${esc(l.text)}${l.sub ? `<small>${esc(l.sub)}</small>` : ""}</p>`)).join("")
    : `<p class="msg">${esc(d.empty)}</p>`;
  return tvDocument({ title: d.title, body: `<div class="page">${top(`<a data-f data-back data-autofocus href="${esc(d.backHref)}" class="btn" style="margin:0">Back</a>`)}<h1>${esc(d.title)}</h1>${body}</div>` });
}

// ── Naming a playlist, arranging it, deleting it ─────────────────────────

const NAME_KEYS = "abcdefghijklmnopqrstuvwxyz0123456789".split("");
const NAME_PUNCT = ["'", "-", "&", ".", ",", "!", "?", ":"];

export interface NameKeyboardData {
  base: string;
  heading: string;
  name: string;
  max: number;
  focusKey: string | null;
  /** What to carry from key to key and into the Save (which playlist is being renamed, what is to be added, where to go back). */
  carry: Record<string, string>;
  saveLabel: string;
  backHref: string;
  /** Said under the name (for instance why it can't be saved yet). */
  note?: string | null;
}

/** A name typed with the remote: every key is a link that adds a letter (the first letter of each word is a capital), Save is a POST. */
export function nameKeyboardPage(d: NameKeyboardData): string {
  const at = (name: string, k: string) => `${esc(d.base)}/playlists/name?${esc(new URLSearchParams({ ...d.carry, name, k }).toString())}`;
  const start = d.focusKey ?? "a";
  const full = d.name.length >= d.max;
  const add = (c: string) => (full ? d.name : d.name + (d.name === "" || d.name.endsWith(" ") ? c.toUpperCase() : c));
  const keys = [...NAME_KEYS, ...NAME_PUNCT].map((c) => `<a class="key" data-f${start === c ? " data-autofocus" : ""} href="${at(add(c), c)}">${esc(c.toUpperCase())}</a>`).join("");
  const wide = (id: string, label: string, name: string) => `<a class="key wide" data-f${start === id ? " data-autofocus" : ""} href="${at(name, id)}">${label}</a>`;
  const save = d.name.trim()
    ? `<form method="post" action="${esc(d.base)}/playlists/save" style="display:inline">${Object.entries({ ...d.carry, name: d.name.trim() }).map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join("")}<button type="submit" class="btn primary" data-f>${esc(d.saveLabel)}</button></form>`
    : "";
  return tvDocument({
    title: d.heading,
    body:
      `<div class="page">${top(`<a data-f data-back href="${esc(safeUrl(d.backHref) ?? d.base)}" class="btn" style="margin:0">Back</a>`)}<h1>${esc(d.heading)}</h1>` +
      `<div class="query">${d.name ? esc(d.name) : "&nbsp;"}</div>${d.note ? `<p class="sub">${esc(d.note)}</p>` : ""}` +
      `<div class="row">${save}</div><div class="keys">${keys}${wide("space", "Space", full ? d.name : d.name + " ")}${wide("del", "Delete", d.name.slice(0, -1))}${wide("clear", "Clear", "")}</div></div>`,
  });
}

export interface ArrangeData {
  base: string;
  title: string;
  backHref: string;
  /** The playlist's address, where moves and removals are sent. */
  changeUrl: string;
  items: { id: string; name: string; meta: string | null }[];
  /** After a move, the button to land on (so the same item can be moved again), as "item:direction". */
  focus: string | null;
  note?: string | null;
}

/** Each item with Up, Down and Remove buttons (POSTs); focus stays with the item just moved so it can keep going. */
export function arrangePage(d: ArrangeData): string {
  const rows = d.items
    .map((it, i) => {
      const btn = (dir: "up" | "down" | "remove", label: string, hide: boolean) =>
        hide ? "" : postButton(d.changeUrl, label, { fields: { action: dir, item: it.id }, autofocus: d.focus === `${it.id}:${dir}` });
      return `<div class="arr"><span class="arrname">${i + 1}. ${esc(it.name)}${it.meta ? `<small>${esc(it.meta)}</small>` : ""}</span>${btn("up", "Move up", i === 0)}${btn("down", "Move down", i === d.items.length - 1)}${btn("remove", "Remove", false)}</div>`;
    })
    .join("");
  return tvDocument({
    title: d.title,
    body:
      `<div class="page">${top(`<a data-f data-back${d.focus ? "" : " data-autofocus"} href="${esc(safeUrl(d.backHref) ?? d.base)}" class="btn" style="margin:0">Done</a>`)}<h1>${esc(d.title)}</h1>` +
      `<p class="sub">Move items up or down, or remove them. Press Done when finished.</p>${d.note ? `<p class="sub">${esc(d.note)}</p>` : ""}` +
      (rows || `<p class="sub">Nothing in this playlist.</p>`) +
      `</div>`,
  });
}

// ── Profile settings ──────────────────────────────────────────────────

export interface SettingsPageData {
  base: string;
  profileName: string;
  autoSkip: { key: string; label: string; on: boolean }[];
  /** Whether lists show a collection as one tile. */
  groupCollections: boolean;
  filters: { key: string; label: string; words: string }[];
  /** The button to land on after a change (so the same one can be pressed again). */
  focus: string | null;
}

/** What this profile skips: each is a button that changes to its next choice; every press is a POST and the page comes back with the same button selected. */
export function settingsPage(d: SettingsPageData): string {
  const action = `${d.base}/settings`;
  const one = (kind: "auto" | "filter" | "group", key: string, label: string, value: string) =>
    postButton(action, `${label}: ${value}`, { fields: { kind, key }, autofocus: d.focus === `${kind}:${key}`, className: "btn" });
  const start = d.focus === null;
  const group = one("group", "collections", "Group collections in lists", d.groupCollections ? "On" : "Off");
  const auto = d.autoSkip.map((a) => one("auto", a.key, a.label, a.on ? "On" : "Off")).join("");
  const filters = d.filters.map((f) => one("filter", f.key, f.label, f.words)).join("");
  return tvDocument({
    title: "Settings",
    body:
      `<div class="page">${top(`<a data-f data-back${start ? " data-autofocus" : ""} href="${esc(d.base)}" class="btn" style="margin:0">Back</a>`)}<h1>Settings for ${esc(d.profileName)}</h1>` +
      `<h2>Lists</h2><p class="sub">A film series, or a collection your admin made, shows as one tile in the Movies and TV Shows lists. Off by default.</p><div class="row">${group}</div>` +
      `<h2>Skip automatically</h2><p class="sub">Each of these is skipped by itself, once per play, when it starts. Off by default.</p><div class="row">${auto}</div>` +
      `<h2>What to skip</h2><p class="sub">Press a button to change it: Off, then Mild and up, Moderate and up, Strong only. Scenes in these categories are skipped or muted when a movie has them marked.</p><div class="row">${filters}</div></div>`,
  });
}
