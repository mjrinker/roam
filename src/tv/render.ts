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
  if (/^\/(?!\/)/.test(u) || /^https:\/\//i.test(u)) return u;
  return null;
}

/** Changes whenever the deployed build does, so a TV that cached the script or stylesheet fetches the new one. */
export const ASSET_VERSION = (process.env.VERCEL_GIT_COMMIT_SHA ?? "dev").slice(0, 8);

export function tvDocument(opts: { title: string; body: string; script?: boolean; bodyClass?: string }): string {
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(opts.title)} · Roam</title>` +
    `<meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/tv/tv.css?v=${ASSET_VERSION}"></head>` +
    `<body${opts.bodyClass ? ` class="${esc(opts.bodyClass)}"` : ""}>${opts.body}` +
    (opts.script === false ? "" : `<script src="/tv/tv.js?v=${ASSET_VERSION}"></script>`) +
    `</body></html>`
  );
}

const top = (right = "") => `<div class="top"><span class="brand">ROAM</span><span class="sub" style="margin:0">${right}</span></div>`;

// ── Pairing ──────────────────────────────────────────────────────────────

export function pairPage(args: { userCode: string; linkUrl: string; pollUrl: string; expiredUrl: string }): string {
  return tvDocument({
    title: "Sign in",
    body:
      `<div class="page" data-poll="${esc(args.pollUrl)}" data-done="/tv" data-expired="${esc(args.expiredUrl)}">${top()}` +
      `<h1>Sign in to Roam</h1><p class="sub">On your phone or computer, open</p><p class="sub" style="color:#ececf1;font-size:1.8rem">${esc(args.linkUrl)}</p>` +
      `<p class="sub">and enter this code:</p><div class="code">${esc(args.userCode)}</div>` +
      `<p class="note">This screen continues by itself once you approve it. The code works for ten minutes.</p></div>`,
  });
}

export function messagePage(title: string, message: string, link?: { href: string; label: string }): string {
  return tvDocument({
    title,
    body: `<div class="page">${top()}<h1>${esc(title)}</h1><p class="msg">${esc(message)}</p>${link ? `<a class="btn primary" data-f data-autofocus href="${esc(safeUrl(link.href) ?? "/tv")}">${esc(link.label)}</a>` : ""}</div>`,
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
}

export const card = (p: Poster, autofocus = false): string => {
  const img = safeUrl(p.posterUrl);
  return (
    `<a class="card" data-f${autofocus ? " data-autofocus" : ""} href="${esc(safeUrl(p.href) ?? "/tv")}"><span class="poster">${img ? `<img src="${esc(img)}" alt="">` : ""}</span>` +
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
  libraries: { id: string; name: string; kind: string; count?: number | null }[];
  /** Libraries that exist but have no TV interface yet. */
  unsupported: number;
}

export function homePage(d: HomeData): string {
  const cont = d.continueWatching.length
    ? `<h2>Continue watching</h2><div class="row">${d.continueWatching.map((c, i) => card(c, i === 0)).join("")}</div>`
    : "";
  const libs = d.libraries.length
    ? `<h2>Libraries</h2><div class="row">${d.libraries.map((l, i) => `<a class="tile" data-f${!cont && i === 0 ? " data-autofocus" : ""} href="${esc(d.base)}/library/${esc(l.id)}">${esc(l.name)}<small>${esc(l.kind)}</small></a>`).join("")}</div>`
    : `<p class="sub">Nothing to show here yet.</p>`;
  const more = d.unsupported > 0 ? `<p class="note">${d.unsupported} more ${d.unsupported === 1 ? "library isn't" : "libraries aren't"} available on TV yet.</p>` : "";
  return tvDocument({
    title: d.serverName,
    body: `<div class="page">${top(esc(d.profileName))}<h1>${esc(d.serverName)}</h1>${cont}${libs}${more}<div class="row" style="margin-top:2rem"><a class="btn" data-f href="/tv/profiles">Switch profile</a></div></div>`,
  });
}

export interface ListData {
  base: string;
  title: string;
  subtitle?: string | null;
  backHref: string;
  items: Poster[];
  /** Link to the next page, or null. */
  nextHref: string | null;
  prevHref: string | null;
}

export function listPage(d: ListData): string {
  const body =
    `<div class="page">${top(`<a data-f data-back href="${esc(d.backHref)}" class="btn" style="margin:0">Back</a>`)}<h1>${esc(d.title)}</h1>${d.subtitle ? `<p class="sub">${esc(d.subtitle)}</p>` : ""}` +
    (d.items.length ? `<div class="row">${d.items.map((c, i) => card(c, i === 0)).join("")}</div>` : `<p class="sub">Nothing here yet.</p>`) +
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
  seasons?: { href: string; label: string; current: boolean }[];
}

export function detailPage(d: DetailData): string {
  const img = safeUrl(d.posterUrl);
  const actions = d.actions.map((a, i) => `<a class="btn${a.primary ? " primary" : ""}" data-f${i === 0 ? " data-autofocus" : ""} href="${esc(safeUrl(a.href) ?? "/tv")}">${esc(a.label)}</a>`).join("");
  const seasons = d.seasons?.length ? `<div class="row">${d.seasons.map((s) => `<a class="btn${s.current ? " primary" : ""}" data-f href="${esc(safeUrl(s.href) ?? "/tv")}">${esc(s.label)}</a>`).join("")}</div>` : "";
  const eps = d.episodes?.length ? `<h2>Episodes</h2>${d.episodes.map((e) => `<a class="ep" data-f href="${esc(safeUrl(e.href) ?? "/tv")}">${esc(e.label)}${e.sub ? `<small>${esc(e.sub)}</small>` : ""}</a>`).join("")}` : "";
  return tvDocument({
    title: d.title,
    body:
      `<div class="page">${top(`<a data-f data-back href="${esc(d.backHref)}" class="btn" style="margin:0">Back</a>`)}` +
      `<div class="detail"><span class="poster">${img ? `<img src="${esc(img)}" alt="">` : ""}</span><div class="text"><h1>${esc(d.title)}</h1><p class="sub">${esc(d.meta)}</p>` +
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
      `<div class="player"><video id="video" playsinline></video><div id="status" class="status"></div>` +
      `<div id="hud" class="hud on"><div class="t">${esc(d.title)}${d.subtitle ? ` · ${esc(d.subtitle)}` : ""}</div><div id="bar" class="track" style="display:none"><b id="fill"></b></div><div id="clock" class="clock"></div></div></div>` +
      `<script type="application/json" id="play-config">${cfg}</script>`,
  });
}

export function profilesPage(args: { profiles: { id: string; name: string }[]; selectUrl: string }): string {
  return tvDocument({
    title: "Who's watching?",
    body:
      `<div class="page">${top()}<h1>Who's watching?</h1><div class="row">` +
      args.profiles.map((p, i) => `<a class="tile" data-f${i === 0 ? " data-autofocus" : ""} href="${esc(args.selectUrl)}?viewer=${esc(p.id)}">${esc(p.name)}</a>`).join("") +
      `</div></div>`,
  });
}
