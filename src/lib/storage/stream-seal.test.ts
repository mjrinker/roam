/** Roam seals a Drive file and token; the Cloudflare Worker opens it and relays the file. Both halves, against each other. */
import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { handle, open } from "../../../cloudflare/stream-worker/src/index";
import { sealedStreamUrl, streamWorkerConfig } from "./stream-seal";

const SECRET = randomBytes(32).toString("base64");
const config = { url: "https://roam-stream.me.workers.dev", secret: SECRET };
const later = () => new Date(Date.now() + 30 * 60_000);
const sealed = (fileId = "file-1", token = "ya29.google-token", at = later(), cfg = config) => sealedStreamUrl(cfg, fileId, token, at).split("/s/")[1];
const ask = (path: string, init: RequestInit = {}, method = "GET") => new Request(`https://roam-stream.me.workers.dev${path}`, { method, ...init });
const env = { STREAM_SECRET: SECRET };

describe("the settings", () => {
  it("are used only when both are present and usable", () => {
    expect(streamWorkerConfig({})).toBeNull();
    expect(streamWorkerConfig({ STREAM_WORKER_URL: "https://w.example.workers.dev/" })).toBeNull();
    expect(streamWorkerConfig({ STREAM_SECRET: SECRET })).toBeNull();
    expect(streamWorkerConfig({ STREAM_WORKER_URL: "http://w.example.workers.dev", STREAM_SECRET: SECRET })).toBeNull(); // https only
    expect(streamWorkerConfig({ STREAM_WORKER_URL: "https://w.example.workers.dev", STREAM_SECRET: "too-short" })).toBeNull();
    expect(streamWorkerConfig({ STREAM_WORKER_URL: "https://w.example.workers.dev/", STREAM_SECRET: SECRET })).toEqual({ url: "https://w.example.workers.dev", secret: SECRET });
  });
});

describe("a sealed link", () => {
  it("is opened by the Worker, and says the file, the token and when it ends", async () => {
    const at = later();
    const opened = await open(sealed("file/1:odd", "tok", at), SECRET);
    expect(opened).toEqual({ f: "file/1:odd", t: "tok", e: at.getTime() });
  });
  it("hides the token from anyone without the secret, and is refused when altered, expired or sealed with another secret", async () => {
    const link = sealedStreamUrl(config, "f", "ya29.visible-if-not-sealed", later());
    expect(link.startsWith("https://roam-stream.me.workers.dev/s/")).toBe(true);
    expect(link).not.toContain("ya29");
    const blob = link.split("/s/")[1];
    expect(Buffer.from(blob, "base64url").toString("utf8")).not.toContain("ya29");
    expect(await open(blob.slice(0, -3) + "AAA", SECRET)).toBeNull();
    expect(await open(sealed("f", "t", new Date(Date.now() - 1000)), SECRET)).toBeNull();
    expect(await open(blob, randomBytes(32).toString("base64"))).toBeNull();
    for (const bad of ["", "x", "////", "AAAA", "a".repeat(80)]) expect(await open(bad, SECRET), bad).toBeNull();
    expect(await open(blob, "not-base64-32-bytes")).toBeNull();
  });
});

describe("the Worker", () => {
  const google = (assert: (url: string, init: RequestInit) => void, res: () => Response) => (async (url: string | URL | Request, init?: RequestInit) => (assert(String(url), init ?? {}), res())) as typeof fetch;

  it("asks Google for the sealed file with the sealed token and the player's Range, and passes the bytes back", async () => {
    let seen: { url: string; headers: Record<string, string> } | null = null;
    const upstream = google(
      (url, init) => (seen = { url, headers: init.headers as Record<string, string> }),
      () => new Response(new Uint8Array(100), { status: 206, headers: { "content-type": "video/mp4", "content-range": "bytes 100-199/5000", "content-length": "100", "set-cookie": "leak=1" } })
    );
    const res = await handle(ask(`/s/${sealed("film one", "the-token")}`, { headers: { Range: "bytes=100-199" } }), env, upstream);
    expect(seen).toEqual({ url: "https://www.googleapis.com/drive/v3/files/film%20one?alt=media&supportsAllDrives=true", headers: { Authorization: "Bearer the-token", Range: "bytes=100-199" } });
    expect(res.status).toBe(206);
    expect([res.headers.get("content-type"), res.headers.get("content-range"), res.headers.get("accept-ranges"), res.headers.get("access-control-allow-origin")]).toEqual(["video/mp4", "bytes 100-199/5000", "bytes", "*"]);
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect((await res.arrayBuffer()).byteLength).toBe(100);
  });
  it("answers HEAD without a body, calls an unknown type video/mp4, and answers the browser's preflight", async () => {
    const upstream = google(() => undefined, () => new Response(new Uint8Array(10), { status: 200, headers: { "content-type": "application/octet-stream", "content-length": "10" } }));
    const head = await handle(ask(`/s/${sealed()}`, {}, "HEAD"), env, upstream);
    expect([head.status, head.headers.get("content-type"), (await head.arrayBuffer()).byteLength]).toEqual([200, "video/mp4", 0]);
    const pre = await handle(ask("/s/anything", { headers: { "Access-Control-Request-Method": "GET" } }, "OPTIONS"), env, upstream);
    expect([pre.status, pre.headers.get("access-control-allow-headers"), pre.headers.get("access-control-allow-origin")]).toEqual([204, "Range", "*"]);
    expect((await handle(ask(`/s/${sealed()}`, {}, "POST"), env, upstream)).status).toBe(405);
  });
  it("is a 404 for anything not sealed with its secret, or expired, or at another path", async () => {
    const upstream = google(() => { throw new Error("must not call Google"); }, () => new Response("x"));
    for (const path of ["/", "/s/", "/s/garbage", `/s/${sealed("f", "t", new Date(Date.now() - 1000))}`, `/s/${sealed("f", "t", later(), { ...config, secret: randomBytes(32).toString("base64") })}`, `/other/${sealed()}`, `/s/${sealed()}/extra`]) {
      expect((await handle(ask(path), env, upstream)).status, path).toBe(404);
    }
  });
  it("never repeats Google's errors: a refused or missing file is a 404, a bad range a 416, anything else a 502", async () => {
    const answer = async (status: number) => handle(ask(`/s/${sealed()}`), env, google(() => undefined, () => new Response("secret google detail", { status })));
    const missing = await answer(404);
    expect([missing.status, await missing.text()]).toEqual([404, ""]);
    expect([(await answer(403)).status, (await answer(401)).status, (await answer(416)).status, (await answer(500)).status]).toEqual([404, 404, 416, 502]);
    const down = await handle(ask(`/s/${sealed()}`), env, (async () => { throw new Error("network"); }) as unknown as typeof fetch);
    expect(down.status).toBe(502);
  });
});
