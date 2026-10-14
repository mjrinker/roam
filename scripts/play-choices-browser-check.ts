/**
 * The before-you-watch dialog and the profile editor's "What to skip" section in a real Chromium, at a phone's width and a desktop's:
 * nothing spills out of the dialog or the page, and picking something sends the choice with the play.
 *
 *   PLAY_BROWSER=/path/to/chrome npx tsx scripts/play-choices-browser-check.ts   (run `next build` first, for the real stylesheet)
 */
import fs from "node:fs";
import http from "node:http";
import { build } from "esbuild";
import { launch } from "./lib-cdp";

const exe = process.env.PLAY_BROWSER;
if (!exe) throw new Error("Set PLAY_BROWSER=/path/to/a recent chrome");
const dir = fs.mkdtempSync("/tmp/play-choices-check-");
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

const server = http.createServer((req, res) => {
  const url = new URL(req.url!, "http://x");
  if (url.pathname === "/app.css") return void res.writeHead(200, { "content-type": "text/css" }).end(appCss);
  if (url.pathname === "/bundle.js") return void res.writeHead(200, { "content-type": "text/javascript" }).end(fs.readFileSync(`${dir}/bundle.js`));
  res.writeHead(200, { "content-type": "text/html" }).end(`<!doctype html><html class="dark"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css"></head><body class="bg-background text-foreground"><div id="root"></div><script src="/bundle.js"></script></body></html>`);
});

/** Every element inside the open dialog (and the page itself) that sticks out sideways. */
const overflowScript = `(() => {
  const bad = [];
  if (window.__detail) { const pop0 = document.querySelector('[data-slot="dialog-content"]'); const b0 = pop0.getBoundingClientRect(); const out = []; for (const el of pop0.querySelectorAll("*")) { const r = el.getBoundingClientRect(); if (r.width > 0 && r.right > b0.right + 1 && !out.some(o => o.contains(el))) out.push(el); } return out.map(el => el.tagName + "." + String(el.className).slice(0, 60) + " right=" + Math.round(el.getBoundingClientRect().right) + " box=" + Math.round(b0.right) + " w=" + Math.round(el.getBoundingClientRect().width)); }
  const pop = document.querySelector('[data-slot="dialog-content"]');
  if (!pop) return ["no dialog"];
  const box = pop.getBoundingClientRect();
  for (const el of pop.querySelectorAll("*")) {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && (r.right > box.right + 1 || r.left < box.left - 1)) bad.push(el.tagName + ":" + (el.textContent || "").trim().slice(0, 30));
  }
  if (box.left < -1 || box.right > window.innerWidth + 1) bad.push("DIALOG off screen: " + Math.round(box.left) + ".." + Math.round(box.right) + " of " + window.innerWidth);
  if (document.documentElement.scrollWidth > window.innerWidth + 1) bad.push("PAGE scrolls sideways");
  return bad;
})()`;

async function main() {
  await build({
    stdin: {
      contents: `
        import { createRoot } from "react-dom/client";
        import { PlayChoicesButton } from "@/components/library/play-choices";
        import { ProfileEditorDialog } from "@/components/profiles/profile-editor-dialog";
        const lines = [
          { category: "violence", severity: "high", scenes: 12, seconds: 400 },
          { category: "language", severity: "medium", scenes: 30, seconds: 90 },
          { category: "fear", severity: "low", scenes: 4, seconds: 60 },
          { category: "discrimination", severity: "medium", scenes: 2, seconds: 20 },
          { category: "drugs", severity: "high", scenes: 1, seconds: 30 },
        ];
        const profile = { id: "p1", name: "Matt", avatarKey: "teal-user", role: "owner", locale: "en-US", maxAge: null, allowUnrated: false, visibleOnServer: true, contentFilter: { violence: "medium", language: "high" }, hasPin: false };
        window.__show = (which) => createRoot(document.getElementById("root")).render(
          which === "play"
            ? <PlayChoicesButton href="/s/1/watch/title/2" lines={lines} prefs={{ violence: "medium", language: "high" }} className="m-4 h-12 px-8">Play</PlayChoicesButton>
            : <ProfileEditorDialog profile={profile} actor={{ id: "p1", role: "owner", hasPin: false }} canDelete={false} open={true} onOpenChange={() => {}} onSaved={() => {}} />
        );`,
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
  const browser = await launch(exe!, 9341);
  const page = browser.page;
  try {
    for (const [label, width, mobile] of [["phone", 375, true], ["small phone", 320, true], ["desktop", 1100, false]] as const) {
      await page.send("Emulation.setDeviceMetricsOverride", { width, height: 800, deviceScaleFactor: 1, mobile });
      await page.goto(`${base}/`);
      await page.evaluate(`window.__show("play")`);
      await page.waitFor(`[...document.querySelectorAll("a")].some(a => a.textContent.trim() === "Play")`, 4000);
      await page.evaluate(`[...document.querySelectorAll("a")].find(a => a.textContent.trim() === "Play").click()`);
      await page.waitFor(`!!document.querySelector('[data-slot="dialog-content"]')`, 4000);
      check(`${label}: the before-you-watch dialog lists each category`, await page.evaluate<boolean>(`["Violence","Language","Fear","Discrimination","Drugs"].every(c => document.body.innerText.includes(c))`));
      check(`${label}: nothing in the before-you-watch dialog sticks out`, (await page.evaluate<string[]>(overflowScript)).length === 0, await page.evaluate(overflowScript));
      if (process.env.SHOT && label === "phone") {
        const shot = await page.send("Page.captureScreenshot", { format: "png" });
        fs.writeFileSync(`${process.env.SHOT}-play.png`, Buffer.from(shot.data as string, "base64"));
      }
      if (label === "phone") {
        // Skip all violence, then play: the choice goes with the play, and the profile's own are not repeated.
        await page.evaluate(`(() => { const s = document.getElementById("play-violence"); const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set; set.call(s, "low"); s.dispatchEvent(new Event("change", { bubbles: true })); })()`);
        await page.evaluate(`[...document.querySelectorAll("button")].find(b => b.textContent.trim() === "Play").click()`);
        await new Promise((r) => setTimeout(r, 300));
        const nav = await page.evaluate<string[]>(`window.__nav ?? []`);
        check("playing sends the extra choice in the address", nav.includes("/s/1/watch/title/2?skip=violence:low"), nav);
        const options = await page.evaluate<string>(`[...document.getElementById("play-language").options].map(o => o.textContent).join("|")`).catch(() => "");
        void options;
      }

      await page.goto(`${base}/`);
      await page.evaluate(`window.__show("editor")`);
      await page.waitFor(`document.body.innerText.includes("What to skip")`, 4000);
      check(`${label}: the profile editor's What to skip section lists the categories`, await page.evaluate<boolean>(`["Violence","Language","Fear and frightening scenes","Drugs and alcohol"].every(c => document.body.innerText.includes(c))`));
      if (process.env.SHOT && label === "phone") {
        await page.evaluate(`document.querySelector('[data-slot="dialog-content"]').scrollTo(0, 99999)`);
        const shot = await page.send("Page.captureScreenshot", { format: "png" });
        fs.writeFileSync(`${process.env.SHOT}-editor.png`, Buffer.from(shot.data as string, "base64"));
      }
      if (process.env.DETAIL) { await page.evaluate("window.__detail = true"); console.log("   detail:", await page.evaluate(overflowScript)); await page.evaluate("window.__detail = false"); }
      check(`${label}: nothing in the profile editor sticks out`, (await page.evaluate<string[]>(overflowScript)).length === 0, await page.evaluate(overflowScript));
    }
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
