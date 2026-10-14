/**
 * The marking panel in a real Chromium at a phone's width and a desktop's: nothing spills out of it or the page, marking a scene sends the
 * right request, and deleting one sends the list without it.
 *
 *   MARK_BROWSER=/path/to/chrome npx tsx scripts/mark-panel-browser-check.ts   (run `next build` first, for the real stylesheet)
 */
import fs from "node:fs";
import http from "node:http";
import { build } from "esbuild";
import { launch } from "./lib-cdp";

const exe = process.env.MARK_BROWSER;
if (!exe) throw new Error("Set MARK_BROWSER=/path/to/a recent chrome");
const dir = fs.mkdtempSync("/tmp/mark-panel-check-");
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

const initialMarks = {
  writesFiles: true,
  durationSeconds: 7200,
  editable: [
    { startSeconds: 120, endSeconds: 140, category: "violence", severity: "high", channel: "both", note: "a very long note that goes on and on and on and on" },
    { startSeconds: 3725.5, endSeconds: 3730, category: "language", severity: "low", channel: "sound" },
  ],
  readOnly: [{ startSeconds: 10, endSeconds: 12, category: "fear", severity: "medium", channel: "both" }],
};
let marks = structuredClone(initialMarks);
const requests: string[] = [];
const server = http.createServer((req, res) => {
  const url = new URL(req.url!, "http://x");
  if (url.pathname === "/app.css") return void res.writeHead(200, { "content-type": "text/css" }).end(appCss);
  if (url.pathname === "/bundle.js") return void res.writeHead(200, { "content-type": "text/javascript" }).end(fs.readFileSync(`${dir}/bundle.js`));
  if (url.pathname.startsWith("/api/marks/")) {
    if (req.method === "PUT") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        requests.push(`PUT ${body}`);
        const sent = JSON.parse(body) as { cues: typeof marks.editable };
        marks = { ...marks, editable: sent.cues };
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(marks));
      });
      return;
    }
    requests.push(`GET ${url.search}`);
    return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(marks));
  }
  res.writeHead(200, { "content-type": "text/html" }).end(`<!doctype html><html class="dark"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css"></head><body class="bg-black text-foreground"><div id="root" class="relative h-dvh overflow-hidden"></div><script src="/bundle.js"></script></body></html>`);
});

const overflowScript = `(() => {
  const bad = [];
  const pop = document.querySelector('[role="dialog"]');
  if (!pop) return ["no panel"];
  const box = pop.getBoundingClientRect();
  for (const el of pop.querySelectorAll("*")) {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && (r.right > box.right + 1 || r.left < box.left - 1)) bad.push(el.tagName + ":" + (el.textContent || "").trim().slice(0, 30));
  }
  if (box.left < -1 || box.right > window.innerWidth + 1) bad.push("PANEL off screen: " + Math.round(box.left) + ".." + Math.round(box.right) + " of " + window.innerWidth);
  if (box.top < -1) bad.push("PANEL above the screen");
  if (document.documentElement.scrollWidth > window.innerWidth + 1) bad.push("PAGE scrolls sideways");
  return bad;
})()`;

async function main() {
  await build({
    stdin: {
      contents: `
        import { createRoot } from "react-dom/client";
        import { MarkPanel } from "@/components/player/mark-panel";
        window.__time = 100;
        window.__log = [];
        createRoot(document.getElementById("root")).render(
          <MarkPanel ownerKind="title" ownerId="m1" version="1080p" getTime={() => window.__time} seekTo={(t) => window.__log.push("seek " + t)} pause={() => window.__log.push("pause")} onClose={() => window.__log.push("close")} />
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
  const browser = await launch(exe!, 9343);
  const page = browser.page;
  const click = (label: string) => page.evaluate(`[...document.querySelectorAll("button")].find(b => b.textContent.trim() === ${JSON.stringify(label)}).click()`);
  try {
    for (const [label, width, mobile] of [["phone", 375, true], ["small phone", 320, true], ["desktop", 1100, false]] as const) {
      await page.send("Emulation.setDeviceMetricsOverride", { width, height: 700, deviceScaleFactor: 1, mobile });
      marks = structuredClone(initialMarks);
      await page.goto(`${base}/`);
      await page.waitFor(`document.body.innerText.includes("Marked scenes (2)")`, 5000);
      check(`${label}: the panel lists the marked scenes and the read-only ones`, await page.evaluate<boolean>(`["Violence · Strong", "Language · Mild · sound only", "02:00".replace("02:00","2:00"), "From a scene file"].every(t => document.body.innerText.includes(t))`));
      check(`${label}: nothing in the panel or the page sticks out`, (await page.evaluate<string[]>(overflowScript)).length === 0, await page.evaluate(overflowScript));
      if (label === "phone") {
        if (process.env.SHOT) {
          const shot = await page.send("Page.captureScreenshot", { format: "png" });
          fs.writeFileSync(`${process.env.SHOT}-mark.png`, Buffer.from(shot.data as string, "base64"));
        }
        // Mark a scene: starts at 100 s, ends at 112 s (paused), sound-only language.
        await click("Scene starts here");
        await page.evaluate(`window.__time = 112`);
        await click("Scene ends here");
        check("ending a scene pauses the video", (await page.evaluate<string[]>(`window.__log`)).includes("pause"));
        check("the times are shown", await page.evaluate<boolean>(`document.body.innerText.includes("From 1:40") && document.body.innerText.includes("To 1:52")`));
        await page.evaluate(`(() => { const s = [...document.querySelectorAll("select")][0]; const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set; set.call(s, "sex"); s.dispatchEvent(new Event("change", { bubbles: true })); })()`);
        await page.evaluate(`(() => { const c = document.querySelector('input[type="checkbox"]'); c.click(); })()`);
        await click("Save this scene");
        await page.waitFor(`document.body.innerText.includes("Marked scenes (3)")`, 4000);
        const put = requests.filter((r) => r.startsWith("PUT")).pop()!;
        const sent = JSON.parse(put.slice(4)) as { version: string; cues: { startSeconds: number; endSeconds: number; category: string; channel: string }[] };
        check("saving sends the whole list with the new scene, for this version", sent.version === "1080p" && sent.cues.length === 3 && sent.cues.some((c) => c.category === "sex" && c.startSeconds === 100 && c.endSeconds === 112 && c.channel === "sound"), sent);
        // Delete the first one.
        await page.evaluate(`document.querySelector('[aria-label="Delete this scene"]').click()`);
        await page.waitFor(`document.body.innerText.includes("Marked scenes (2)")`, 4000);
        const del = JSON.parse(requests.filter((r) => r.startsWith("PUT")).pop()!.slice(4)) as { cues: unknown[] };
        check("deleting sends the list without it", del.cues.length === 2);
        // Jump to a scene.
        await page.evaluate(`[...document.querySelectorAll("button")].find(b => b.title === "Jump to just before this scene").click()`);
        check("a scene can be jumped to, a few seconds before it", (await page.evaluate<string[]>(`window.__log`)).some((l) => l.startsWith("seek ")));
      }
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
