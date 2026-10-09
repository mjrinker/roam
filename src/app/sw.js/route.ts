/**
 * The service worker: lets the installed app open with no connection. It keeps a copy of the /offline page (the list of downloads and
 * a player for them) and of the scripts, styles and fonts that page needs; every page request that cannot reach the server is answered
 * with that page. Everything else (the API, other pages while online) goes to the network untouched. Each deployment serves a
 * different worker, so the copy is refreshed whenever the app is.
 */
const VERSION = process.env.VERCEL_GIT_COMMIT_SHA ?? process.env.npm_package_version ?? "dev";

const SCRIPT = `
const CACHE = "roam-offline-" + ${JSON.stringify(VERSION)};
const SHELL = "/offline";

async function precache() {
  const cache = await caches.open(CACHE);
  const res = await fetch(SHELL, { cache: "reload" });
  if (!res.ok) throw new Error("offline page unavailable");
  const html = await res.clone().text();
  await cache.put(SHELL, res);
  const assets = new Set(html.match(/\\/_next\\/static\\/[^"'\\s\\\\)]+/g) || []);
  await Promise.all([...assets].map((a) => cache.add(a).catch(() => undefined)));
  // Fonts and images the styles refer to.
  for (const asset of assets) {
    if (!asset.endsWith(".css")) continue;
    const css = await (await cache.match(asset))?.text();
    const urls = new Set((css || "").match(/\\/_next\\/static\\/media\\/[^)"'\\s]+/g) || []);
    await Promise.all([...urls].map((u) => cache.add(u).catch(() => undefined)));
  }
  await Promise.all(["/icons/icon-192.png", "/icons/icon-512.png", "/icon.svg"].map((u) => cache.add(u).catch(() => undefined)));
}

self.addEventListener("install", (event) => {
  // If the page and its files could not be kept, the install fails and any earlier worker (with its copy) stays in charge.
  event.waitUntil(precache().then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith("roam-offline-") && k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/_next/static/")) {
    // Hashed files never change: the saved copy is always right.
    event.respondWith(
      caches.open(CACHE).then(async (cache) => {
        const hit = await cache.match(req);
        if (hit) return hit;
        const res = await fetch(req);
        if (res.ok) cache.put(req, res.clone());
        return res;
      })
    );
    return;
  }
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req).catch(async () => {
        const cache = await caches.open(CACHE);
        return (await cache.match(SHELL)) || Response.error();
      })
    );
  }
});
`;

export function GET() {
  return new Response(SCRIPT, {
    headers: {
      "Content-Type": "application/javascript; charset=utf-8",
      "Cache-Control": "no-cache, no-store, must-revalidate",
      "Service-Worker-Allowed": "/",
    },
  });
}
