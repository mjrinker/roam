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
    `<a class="card${p.square ? " sq" : ""}" data-f${autofocus ? " data-autofocus" : ""} href="${esc(safeUrl(p.href) ?? "/tv")}"><span class="poster">${img ? `<img src="${esc(img)}" alt="">` : ""}</span>` +
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
  continueListening?: Poster[];
  libraries: { id: string; name: string; kind: string; count?: number | null }[];
  /** Libraries that exist but have no TV interface yet. */
  unsupported: number;
}

export function homePage(d: HomeData): string {
  const cont = d.continueWatching.length
    ? `<h2>Continue watching</h2><div class="row">${d.continueWatching.map((c, i) => card(c, i === 0)).join("")}</div>`
    : "";
  const listening = d.continueListening?.length
    ? `<h2>Continue listening</h2><div class="row">${d.continueListening.map((c, i) => card(c, i === 0 && !cont)).join("")}</div>`
    : "";
  const first = !cont && !listening;
  const libs = d.libraries.length
    ? `<h2>Libraries</h2><div class="row">${d.libraries.map((l, i) => `<a class="tile" data-f${first && i === 0 ? " data-autofocus" : ""} href="${esc(d.base)}/library/${esc(l.id)}">${esc(l.name)}<small>${esc(l.kind)}</small></a>`).join("")}</div>`
    : `<p class="sub">Nothing to show here yet.</p>`;
  const more = d.unsupported > 0 ? `<p class="note">${d.unsupported} more ${d.unsupported === 1 ? "library isn't" : "libraries aren't"} available on TV yet.</p>` : "";
  return tvDocument({
    title: d.serverName,
    body: `<div class="page">${top(esc(d.profileName))}<h1>${esc(d.serverName)}</h1>${cont}${listening}${libs}${more}<div class="row" style="margin-top:2rem"><a class="btn" data-f href="/tv/profiles">Switch profile</a>${postButton("/tv/signout", "Sign out")}</div></div>`,
  });
}

export interface ListData {
  base: string;
  title: string;
  subtitle?: string | null;
  backHref: string;
  items: Poster[];
  /** Subfolders to open before the items. */
  folders?: { href: string; name: string }[];
  /** Link to the next page, or null. */
  nextHref: string | null;
  prevHref: string | null;
}

export function listPage(d: ListData): string {
  const body =
    `<div class="page">${top(`<a data-f data-back href="${esc(d.backHref)}" class="btn" style="margin:0">Back</a>`)}<h1>${esc(d.title)}</h1>${d.subtitle ? `<p class="sub">${esc(d.subtitle)}</p>` : ""}` +
    (d.folders?.length ? `<div class="row">${d.folders.map((f, i) => `<a class="tile folder" data-f${i === 0 ? " data-autofocus" : ""} href="${esc(safeUrl(f.href) ?? "/tv")}">${esc(f.name)}<small>Folder</small></a>`).join("")}</div>` : "") +
    (d.items.length ? `<div class="row">${d.items.map((c, i) => card(c, i === 0 && !d.folders?.length)).join("")}</div>` : d.folders?.length ? "" : `<p class="sub">Nothing here yet.</p>`) +
    `<div class="row">${d.prevHref ? `<a class="btn" data-f href="${esc(d.prevHref)}">Previous</a>` : ""}${d.nextHref ? `<a class="btn" data-f href="${esc(d.nextHref)}">More</a>` : ""}</div></div>`;
  return tvDocument({ title: d.title, body });
}

export interface DetailData {
  title: string;
  meta: string;
  overview: string | null;
  posterUrl: string | null;
  backHref: string;
  actions: { href: string; label: string; primary?: boolean }[];
  /** Episodes of one season, for a show. */
  episodes?: { href: string; label: string; sub?: string | null }[];
  /** The heading over `episodes` (songs on an album); "Episodes" by default. */
  listHeading?: string;
  /** A square cover, not a tall poster. */
  square?: boolean;
  /** A wide picture behind the page, shown only on browsers new enough to do it well (the basic page never downloads it). */
  backdropUrl?: string | null;
  seasons?: { href: string; label: string; current: boolean }[];
}

export function detailPage(d: DetailData): string {
  const img = safeUrl(d.posterUrl);
  const back = safeUrl(d.backdropUrl);
  const backdrop = back ? `<div class="backdrop"><img data-src="${esc(back)}" alt=""></div>` : "";
  const actions = d.actions.map((a, i) => `<a class="btn${a.primary ? " primary" : ""}" data-f${i === 0 ? " data-autofocus" : ""} href="${esc(safeUrl(a.href) ?? "/tv")}">${esc(a.label)}</a>`).join("");
  const seasons = d.seasons?.length ? `<div class="row">${d.seasons.map((s) => `<a class="btn${s.current ? " primary" : ""}" data-f href="${esc(safeUrl(s.href) ?? "/tv")}">${esc(s.label)}</a>`).join("")}</div>` : "";
  const eps = d.episodes?.length ? `<h2>${esc(d.listHeading ?? "Episodes")}</h2>${d.episodes.map((e) => `<a class="ep" data-f href="${esc(safeUrl(e.href) ?? "/tv")}">${esc(e.label)}${e.sub ? `<small>${esc(e.sub)}</small>` : ""}</a>`).join("")}` : "";
  return tvDocument({
    title: d.title,
    body:
      `${backdrop}<div class="page">${top(`<a data-f data-back href="${esc(d.backHref)}" class="btn" style="margin:0">Back</a>`)}` +
      `<div class="detail"><span class="poster${d.square ? " sq" : ""}">${img ? `<img src="${esc(img)}" alt="">` : ""}</span><div class="text"><h1>${esc(d.title)}</h1><p class="sub">${esc(d.meta)}</p>` +
      (d.overview ? `<p class="overview">${esc(d.overview)}</p>` : "") +
      `<div>${actions}</div>${seasons}</div></div>${eps}</div>`,
  });
}

export interface WatchData {
  title: string;
  subtitle: string | null;
  ownerKind: "title" | "episode";
  ownerId: string;
  back: string;
  next: string | null;
}

export function watchPage(d: WatchData): string {
  const cfg = JSON.stringify({ ownerKind: d.ownerKind, ownerId: d.ownerId, back: safeUrl(d.back) ?? "/tv", next: d.next ? safeUrl(d.next) : null }).replace(/</g, "\\u003c");
  return tvDocument({
    title: d.title,
    bodyClass: "watch",
    body:
      `<div class="player"><video id="pv" playsinline></video><div id="status" class="status"></div>` +
      `<div id="hud" class="hud on"><div class="t">${esc(d.title)}${d.subtitle ? ` · ${esc(d.subtitle)}` : ""}</div><div id="bar" class="track" style="display:none"><b id="fill"></b></div><div id="clock" class="clock"></div></div></div>` +
      `<script type="application/json" id="play-config">${cfg}</script>`,
  });
}

export function profilesPage(args: { profiles: { id: string; name: string }[]; selectUrl: string }): string {
  return tvDocument({
    title: "Who's watching?",
    body:
      `<div class="page">${top()}<h1>Who's watching?</h1><div class="row">` +
      args.profiles.map((p, i) => postButton(args.selectUrl, p.name, { autofocus: i === 0, fields: { viewer: p.id }, className: "tile" })).join("") +
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
  queue?: { items: { id: string; title: string; by: string | null }[]; index: number } | null;
}

export function listenPage(d: ListenData): string {
  const cfg = JSON.stringify({ ownerKind: "title", ownerId: d.ownerId, remembers: d.remembers, skip: d.skip, back: safeUrl(d.back) ?? "/tv", next: d.next ? safeUrl(d.next) : null, queue: d.queue ?? null }).replace(/</g, "\\u003c");
  const img = safeUrl(d.coverUrl);
  return tvDocument({
    title: d.title,
    bodyClass: "watch",
    body:
      `<div class="player listen"><audio id="pa"></audio><div class="cover">${img ? `<img src="${esc(img)}" alt="">` : ""}</div>` +
      `<div class="now"><div class="t" id="ttl">${esc(d.title)}</div><div class="by" id="by">${d.subtitle ? esc(d.subtitle) : ""}</div></div><div id="status" class="status"></div>` +
      `<div id="hud" class="hud on"><div id="bar" class="track" style="display:none"><b id="fill"></b></div><div id="clock" class="clock"></div></div></div>` +
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
}

export function photoViewPage(d: PhotoViewData): string {
  const cfg = JSON.stringify({ prev: d.prev ? safeUrl(d.prev) : null, next: d.next ? safeUrl(d.next) : null, back: safeUrl(d.back) ?? "/tv" }).replace(/</g, "\\u003c");
  return tvDocument({
    title: d.title,
    bodyClass: "watch",
    body:
      `<div class="player photo"><img id="pimg" src="${esc(safeUrl(d.imageUrl) ?? "")}" alt="${esc(d.title)}"><div id="status" class="status"></div>` +
      `<div id="hud" class="hud on"><div class="t">${esc(d.title)}</div><div class="clock">${d.position ? esc(d.position) + " · " : ""}Left and right for the previous and next picture, OK to start a slideshow</div></div></div>` +
      `<script type="application/json" id="photo-config">${cfg}</script>`,
  });
}
