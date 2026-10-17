import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { startRangeProxy, type RangeProxy } from "./proxy";

const closers: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

/** A stand-in storage service holding 1000 bytes (byte i is i % 256), which answers ranges and counts what it was asked. */
async function storage() {
  const asked: { method: string; range: string | undefined }[] = [];
  const server: Server = createServer((req, res) => {
    asked.push({ method: req.method ?? "", range: req.headers.range });
    const data = Uint8Array.from({ length: 1000 }, (_, i) => i % 256);
    const m = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? "");
    if (!m) return void res.writeHead(200, { "content-type": "video/mp4", "content-length": "1000" }).end(Buffer.from(data));
    const from = Number(m[1]);
    const to = m[2] ? Math.min(Number(m[2]), 999) : 999;
    res.writeHead(206, { "content-type": "video/mp4", "content-range": `bytes ${from}-${to}/1000`, "content-length": String(to - from + 1) }).end(Buffer.from(data.slice(from, to + 1)));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  closers.push(() => new Promise<void>((r) => (server.closeAllConnections(), server.close(() => r()))));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/file`, asked };
}
async function proxy(getUrl: (id: string) => Promise<string>): Promise<RangeProxy> {
  const p = await startRangeProxy(getUrl);
  closers.push(() => p.close());
  return p;
}

describe("the range proxy", () => {
  it("passes a byte range through and answers with the same range, status and length", async () => {
    const s = await storage();
    const p = await proxy(async () => s.url);
    const res = await fetch(p.urlFor("abc"), { headers: { range: "bytes=100-199" } });
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 100-199/1000");
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(bytes).toHaveLength(100);
    expect(bytes[0]).toBe(100);
    expect(s.asked.at(-1)?.range).toBe("bytes=100-199");
  });

  it("serves the whole file when no range is asked, and gets the address for the id each time", async () => {
    const s = await storage();
    const ids: string[] = [];
    const p = await proxy(async (id) => (ids.push(id), s.url));
    const res = await fetch(p.urlFor("file/with space"));
    expect(res.status).toBe(200);
    expect((await res.arrayBuffer()).byteLength).toBe(1000);
    expect(ids).toEqual(["file/with space"]);
  });

  it("answers a HEAD with the file's size without asking for the file", async () => {
    const s = await storage();
    const p = await proxy(async () => s.url);
    const res = await fetch(p.urlFor("x"), { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-length")).toBe("1000");
    expect(s.asked.at(-1)).toEqual({ method: "GET", range: "bytes=0-0" });
  });

  it("refuses other methods and says so when the storage cannot be reached", async () => {
    const p = await proxy(async () => {
      throw new Error("expired");
    });
    expect((await fetch(p.urlFor("x"), { method: "POST" })).status).toBe(405);
    expect((await fetch(p.urlFor("x"))).status).toBe(502);
  });

  it("listens on this machine only", async () => {
    const p = await proxy(async () => "http://127.0.0.1:1");
    expect(p.urlFor("a")).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/a$/);
  });
});
