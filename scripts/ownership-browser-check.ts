/**
 * The ownership screens in a real Chromium at a phone's width and a desktop's: the title page's panel, the admin's card with a claim to
 * review, the waiting screen and the notification bell. Nothing sticks out of the page, and pressing the buttons sends the right requests.
 *
 *   OWN_BROWSER=/path/to/chrome npx tsx scripts/ownership-browser-check.ts   (run `next build` first, for the real stylesheet)
 */
import fs from "node:fs";
import http from "node:http";
import { build } from "esbuild";
import { launch } from "./lib-cdp";

const exe = process.env.OWN_BROWSER;
if (!exe) throw new Error("Set OWN_BROWSER=/path/to/a recent chrome");
const dir = fs.mkdtempSync("/tmp/ownership-check-");
let failures = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || detail === undefined ? "" : "  " + JSON.stringify(detail)}`);
  if (!ok) failures++;
};
function builtCss(): string {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = `${d}/${e.name}`;
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".css")) out.push(fs.readFileSync(p, "utf8"));
    }
  };
  walk(".next/static");
  if (out.length === 0) throw new Error("No built CSS under .next/static: run `next build` first.");
  return out.join("\n");
}
const appCss = builtCss();

const requests: string[] = [];
const notifications = {
  unread: 2,
  items: [
    { id: "n1", kind: "claim_waiting", message: "A claim to own “The Lord of the Rings: The Fellowship of the Ring (Extended Edition)”, season 2, is waiting for review.", href: "/s/x/admin#claims", createdAt: "2026-10-20T10:00:00Z", read: false },
    { id: "n2", kind: "available", message: "“Toy Story” is free to watch now.", href: "/s/x/title/t", createdAt: "2026-10-19T10:00:00Z", read: false },
  ],
};
const server = http.createServer((req, res) => {
  const url = new URL(req.url!, "http://x");
  if (url.pathname === "/app.css") return void res.writeHead(200, { "content-type": "text/css" }).end(appCss);
  if (url.pathname === "/bundle.js") return void res.writeHead(200, { "content-type": "text/javascript" }).end(fs.readFileSync(`${dir}/bundle.js`));
  if (url.pathname === "/api/notifications") return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(notifications));
  if (url.pathname.startsWith("/api/")) {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      requests.push(`${req.method} ${url.pathname} ${body}`);
      res.writeHead(200, { "content-type": "application/json" }).end("{}");
    });
    return;
  }
  const which = url.pathname.slice(1) || "panel";
  res.writeHead(200, { "content-type": "text/html" }).end(`<!doctype html><html class="dark"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css"></head><body class="bg-background text-foreground"><div id="root" data-which="${which}"></div><script src="/bundle.js"></script></body></html>`);
});

const overflowScript = `(() => {
  const bad = [];
  const w = window.innerWidth;
  for (const el of document.querySelectorAll("#root *")) {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && (r.right > w + 1 || r.left < -1)) bad.push(el.tagName + ":" + (el.textContent || "").trim().slice(0, 30) + " " + Math.round(r.left) + ".." + Math.round(r.right));
  }
  if (document.documentElement.scrollWidth > w + 1) bad.push("PAGE scrolls sideways");
  return bad;
})()`;

async function main() {
  await build({
    stdin: {
      contents: `
        import { createRoot } from "react-dom/client";
        import { OwnershipPanel } from "@/components/ownership/ownership-panel";
        import { OwnershipManager } from "@/components/admin/ownership-manager";
        import { UnavailableScreen } from "@/components/player/unavailable-screen";
        import { NotificationBell } from "@/components/shell/notification-bell";
        const root = document.getElementById("root");
        const which = root.dataset.which;
        const households = [{ accountId: "a", name: "The Anderson household", isAdmin: false }, { accountId: "b", name: "Bo", isAdmin: true }];
        const unit = (o) => ({ seasonId: null, label: null, owners: [], iOwn: false, myShared: false, myClaim: null, playable: true, blockedBy: null, watching: false, ...o });
        const settings = { enabled: true, claimMode: "review", limitConcurrent: true, limitKinds: ["movies", "shows"] };
        const view = (units) => ({ serverId: "s1", settings, units, households });
        const owners = [{ accountId: "a", name: "The Anderson household with a very long name indeed", shared: true, mine: false }, { accountId: "b", name: "Bo", shared: false, mine: true }];
        const claim = { id: "c1", titleId: "t", titleName: "The Lord of the Rings: The Fellowship of the Ring (Extended Edition)", seasonNumber: 2, accountId: "a", household: "The Anderson household", status: "evidence_submitted", adminNote: null, createdAt: "2026-10-20T00:00:00Z", pictures: [{ id: "p1", contentType: "image/jpeg" }] };
        const el = {
          panel: <div className="mx-auto max-w-5xl px-4 py-8 sm:px-8"><OwnershipPanel titleId="t1" canClaim isAdmin view={view([unit({ label: "Season 1", seasonId: "s1" }), unit({ label: "Season 2", seasonId: "s2", owners, iOwn: true, myShared: false, playable: true })])} /></div>,
          evidence: <div className="mx-auto max-w-5xl px-4 py-8 sm:px-8"><OwnershipPanel titleId="t1" canClaim isAdmin={false} view={view([unit({ myClaim: { id: "c9", status: "evidence_requested", note: "A photo of the case with today's newspaper next to it, please" } })])} /></div>,
          admin: <div className="mx-auto max-w-4xl px-4 py-8"><OwnershipManager serverId="s1" initial={settings} claims={[claim]} households={households} libraries={[{ id: "l1", name: "Family movies library with a long name", kind: "movies" }]} /></div>,
          waiting: <UnavailableScreen info={{ code: "busy", error: "All 2 copies are being played right now. You can wait until one is free.", unit: { titleId: "t", seasonId: null }, watching: false }} backHref="/x" onRetry={() => undefined} />,
          bell: <div className="flex h-16 items-center justify-end gap-3 px-4"><NotificationBell /></div>,
        }[which];
        createRoot(root).render(el);`,
      resolveDir: process.cwd(),
      loader: "tsx",
    },
    bundle: true,
    platform: "browser",
    format: "iife",
    jsx: "automatic",
    alias: { "@": "./src", "next/link": "./scripts/stubs/next-link.tsx", "next/image": "./scripts/stubs/next-image.tsx", "next/navigation": "./scripts/stubs/next-navigation.tsx" },
    define: { "process.env.NODE_ENV": '"development"' },
    outfile: `${dir}/bundle.js`,
    logLevel: "error",
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const browser = await launch(exe!, 9344);
  const page = browser.page;
  const click = (label: string) => page.evaluate(`[...document.querySelectorAll("button")].find(b => b.textContent.trim() === ${JSON.stringify(label)}).click()`);
  const setSelect = (n: number, value: string) => page.evaluate(`(() => { const s = [...document.querySelectorAll("select")][${n}]; Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(s, ${JSON.stringify(value)}); s.dispatchEvent(new Event("change", { bubbles: true })); })()`);
  const typeInto = (selector: string, text: string) => page.evaluate(`(() => { const i = document.querySelector(${JSON.stringify(selector)}); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(i, ${JSON.stringify(text)}); i.dispatchEvent(new Event("input", { bubbles: true })); })()`);
  try {
    for (const [label, width, mobile] of [["phone", 375, true], ["small phone", 320, true], ["desktop", 1100, false]] as const) {
      await page.send("Emulation.setDeviceMetricsOverride", { width, height: 800, deviceScaleFactor: 1, mobile });
      const fits = async (what: string) => check(`${label}: ${what} fits the screen`, (await page.evaluate<string[]>(overflowScript)).length === 0, await page.evaluate(overflowScript));

      await page.goto(`${base}/panel`);
      await page.waitFor(`document.body.innerText.includes("Who owns it")`, 5000);
      await fits("the title's ownership panel");
      check(`${label}: a show is owned season by season`, await page.evaluate<boolean>(`document.querySelectorAll('[data-testid="ownership-unit"]').length === 2 && document.body.innerText.includes("Season 2")`));

      await page.goto(`${base}/evidence`);
      await page.waitFor(`document.body.innerText.includes("Choose a picture")`, 5000);
      await fits("the evidence request");

      await page.goto(`${base}/admin`);
      await page.waitFor(`document.body.innerText.includes("Claims waiting for you")`, 5000);
      await fits("the admin's card with a claim");
      check(`${label}: the claim names the season, the household and shows the picture`, await page.evaluate<boolean>(`document.body.innerText.includes("season 2") && document.body.innerText.includes("The Anderson household") && !!document.querySelector('img[src="/api/ownership/claims/c1/pictures/p1"]')`));

      await page.goto(`${base}/waiting`);
      await page.waitFor(`document.body.innerText.includes("Tell me when it's free")`, 5000);
      await fits("the waiting screen");

      await page.goto(`${base}/bell`);
      await page.waitFor(`!!document.querySelector('[aria-label^="Notifications"]')`, 5000);
      await page.evaluate(`document.querySelector('[aria-label^="Notifications"]').click()`);
      await page.waitFor(`!!document.querySelector('[role="dialog"]')`, 3000);
      const inside = await page.evaluate<boolean>(`(() => { const r = document.querySelector('[role="dialog"]').getBoundingClientRect(); return r.left >= -1 && r.right <= window.innerWidth + 1 && r.top >= 0; })()`);
      check(`${label}: the notification list stays on the screen`, inside, await page.evaluate(`JSON.stringify(document.querySelector('[role="dialog"]').getBoundingClientRect())`));
      check(`${label}: the bell counts what is unread`, await page.evaluate<boolean>(`document.querySelector('[aria-label="Notifications, 2 new"]') !== null`));
      if (label === "phone") await page.send("Page.captureScreenshot", { format: "png" }).then((s) => process.env.SHOT && fs.writeFileSync(`${process.env.SHOT}-bell.png`, Buffer.from(s.data as string, "base64")));
    }

    // Pressing things sends the right requests.
    await page.send("Emulation.setDeviceMetricsOverride", { width: 375, height: 800, deviceScaleFactor: 1, mobile: true });
    await page.goto(`${base}/panel`);
    await page.waitFor(`document.body.innerText.includes("Who owns it")`, 5000);
    requests.length = 0;
    await click("I own a copy");
    await page.waitFor(`true`, 1);
    await new Promise((r) => setTimeout(r, 300));
    check("claiming sends the season", requests.some((r) => r.startsWith("POST /api/ownership/claims ") && r.includes('"seasonId":"s1"') && r.includes('"titleId":"t1"')), requests);
    await click("Share my copy again");
    await new Promise((r) => setTimeout(r, 300));
    check("sharing a withdrawn copy again sends shared:true for that season", requests.some((r) => r.startsWith("PUT /api/ownership/mine") && r.includes('"shared":true') && r.includes('"seasonId":"s2"')), requests);
    await setSelect(0, "a");
    await page.evaluate(`[...document.querySelectorAll("button")].filter(b => b.textContent.trim() === "Add owner")[0].click()`);
    await new Promise((r) => setTimeout(r, 300));
    check("the admin adding an owner names the household and the season", requests.some((r) => r.startsWith("PUT /api/ownership/owners") && r.includes('"action":"assign"') && r.includes('"accountId":"a"') && r.includes('"seasonId":"s1"')), requests);

    await page.goto(`${base}/admin`);
    await page.waitFor(`document.body.innerText.includes("Claims waiting for you")`, 5000);
    requests.length = 0;
    check("asking for evidence needs a note", await page.evaluate<boolean>(`[...document.querySelectorAll("button")].find(b => b.textContent.trim() === "Ask for evidence").disabled`));
    await typeInto('input[type="text"]', "A photo of the case, please");
    await click("Ask for evidence");
    await new Promise((r) => setTimeout(r, 300));
    check("asking for evidence sends the note to that claim", requests.some((r) => r.startsWith("POST /api/ownership/claims/c1/decision") && r.includes('"kind":"evidence"') && r.includes("A photo of the case, please")), requests);
    await click("Accept");
    await new Promise((r) => setTimeout(r, 300));
    check("accepting sends the decision", requests.some((r) => r.startsWith("POST /api/ownership/claims/c1/decision") && r.includes('"kind":"approve"')), requests);

    await page.goto(`${base}/waiting`);
    await page.waitFor(`document.body.innerText.includes("Tell me when it's free")`, 5000);
    requests.length = 0;
    await click("Tell me when it's free");
    await new Promise((r) => setTimeout(r, 300));
    check("asking to be told sends the title", requests.some((r) => r.startsWith("PUT /api/playback/watch") && r.includes('"titleId":"t"')), requests);
  } finally {
    await browser.close();
    server.close();
  }
  console.log(failures === 0 ? "\nall passed" : `\n${failures} failed`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
