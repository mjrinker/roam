/** The preview ladder and file dates in listings, against a fake Box client (no network). */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BoxApiError } from "box-node-sdk";

type Rep = { status?: { state?: string }; content?: { urlTemplate?: string }; info?: { url?: string } };
const h = vi.hoisted(() => ({
  /** representation entry returned per requested size ("2048"|"1024"), consumed in order per call */
  reps: {} as Record<string, (Rep | "404" | "500")[]>,
  requested: [] as string[],
  requests: [] as { url: string; format?: string }[],
  /** what makeRequest answers for a content URL */
  content: (_url: string): { status: number; bytes?: Uint8Array; chunks?: number } => ({ status: 404 }),
  listing: [] as unknown[],
}));
vi.mock("./box-token-storage", () => ({
  ensureFreshAccessToken: async () => undefined,
  withBoxClient: async (_s: string, fn: (client: unknown) => Promise<unknown>) =>
    fn({
      files: {
        getFileById: async (_id: string, opts: { headers: { xRepHints: string } }) => {
          const size = /dimensions=(\d+)x/.exec(opts.headers.xRepHints)![1];
          h.requested.push(size);
          const queue = h.reps[size] ?? [];
          const next = queue.length > 1 ? queue.shift()! : queue[0];
          if (next === "500") throw new BoxApiError({ message: "boom", timestamp: "", error: undefined, requestInfo: {} as never, responseInfo: { statusCode: 500 } as never });
          if (next === "404") throw new BoxApiError({ message: "nf", timestamp: "", error: undefined, requestInfo: {} as never, responseInfo: { statusCode: 404 } as never });
          return { representations: { entries: next ? [next] : [] } };
        },
      },
      folders: { getFolderItems: async () => ({ totalCount: h.listing.length, entries: h.listing }) },
      makeRequest: async (o: { url: string; responseFormat?: string }) => {
        h.requests.push({ url: o.url, format: o.responseFormat });
        const r = h.content(o.url);
        async function* body() {
          for (let i = 0; i < (r.chunks ?? 1); i++) yield r.bytes!;
        }
        return { status: r.status, headers: {}, content: r.bytes ? body() : undefined };
      },
    }),
}));

import { createBoxProviderForServer } from "./box";

const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const ready = (size: number, host = "dl.boxcloud.com"): Rep => ({
  status: { state: "success" },
  content: { urlTemplate: `https://${host}/reps/jpg_${size}x${size}/content/{+asset_path}` },
  info: { url: `https://api.box.com/reps/jpg_${size}x${size}` },
});
const provider = () => createBoxProviderForServer("s");

beforeEach(() => {
  h.reps = {};
  h.requested = [];
  h.requests = [];
  h.content = () => ({ status: 404 });
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

async function preview(budgetMs?: number) {
  const p = provider().fetchPreview!("file1", { budgetMs });
  await vi.advanceTimersByTimeAsync(60_000);
  return p;
}

describe("fetchPreview", () => {
  it("returns the 2048px JPEG when it is ready, fetched from the content URL with an empty asset path", async () => {
    h.reps["2048"] = [ready(2048)];
    h.content = () => ({ status: 200, bytes: JPEG });
    expect(await preview()).toEqual({ contentType: "image/jpeg", bytes: JPEG, size: 2048 });
    expect(h.requests).toEqual([{ url: "https://dl.boxcloud.com/reps/jpg_2048x2048/content/", format: "binary" }]);
    expect(h.requested).toEqual(["2048"]);
  });

  it("asks Box to generate a representation that doesn't exist yet, then waits for it", async () => {
    h.reps["2048"] = [{ ...ready(2048), status: { state: "none" } }, { ...ready(2048), status: { state: "pending" } }, ready(2048)];
    h.content = (url) => (url.includes("/content/") ? { status: 200, bytes: JPEG } : { status: 200 });
    expect((await preview())?.size).toBe(2048);
    expect(h.requests.map((r) => [r.url, r.format])).toEqual([
      ["https://api.box.com/reps/jpg_2048x2048", "no_content"], // the trigger, once
      ["https://dl.boxcloud.com/reps/jpg_2048x2048/content/", "binary"],
    ]);
  });

  it("retries a 202 from the content URL, and gives up with null when the budget runs out", async () => {
    h.reps["2048"] = [ready(2048)];
    let calls = 0;
    h.content = () => (++calls < 3 ? { status: 202 } : { status: 200, bytes: JPEG });
    expect((await preview())?.size).toBe(2048);
    expect(calls).toBe(3);

    h.reps = { "2048": [{ ...ready(2048), status: { state: "pending" } }], "1024": [{ ...ready(1024), status: { state: "pending" } }] };
    expect(await preview(2000)).toBeNull();
  });

  it("falls back to 1024px when 2048px isn't available, and to null when neither is", async () => {
    h.reps = { "2048": ["404"], "1024": [ready(1024)] };
    h.content = () => ({ status: 200, bytes: JPEG });
    expect((await preview())?.size).toBe(1024);

    h.reps = { "2048": [{ status: { state: "error" } }], "1024": [] };
    expect(await preview()).toBeNull();
  });

  it("never sends Box credentials to a URL that isn't Box's", async () => {
    h.reps = { "2048": [ready(2048, "evil.example")], "1024": [ready(1024, "box.com.evil.example")] };
    h.content = () => ({ status: 200, bytes: JPEG });
    expect(await preview()).toBeNull();
    expect(h.requests).toEqual([]);
  });

  it("refuses bytes that aren't a JPEG, and anything larger than a preview can be", async () => {
    h.reps = { "2048": [ready(2048)], "1024": [] };
    h.content = () => ({ status: 200, bytes: Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0, 0]) });
    expect(await preview()).toBeNull();
    const big = new Uint8Array(1024 * 1024);
    big.set([0xff, 0xd8, 0xff, 0xe0]); // a valid JPEG start, so only the size can refuse it
    h.content = () => ({ status: 200, bytes: big, chunks: 8 }); // 8 MiB
    expect(await preview()).toBeNull();
  });

  it("surfaces a server error instead of calling it 'no preview'", async () => {
    h.reps = { "2048": ["500"] };
    const outcome = expect(provider().fetchPreview!("f")).rejects.toBeInstanceOf(BoxApiError);
    await vi.advanceTimersByTimeAsync(60_000);
    await outcome;
  });
});

describe("file dates in a listing", () => {
  it("carries Box's created and modified dates, keeping only plausible ones", async () => {
    h.listing = [
      { type: "file", id: "1", name: "a.jpg", size: 5, contentCreatedAt: { value: new Date("2022-05-06T07:08:09Z") }, contentModifiedAt: { value: new Date("2023-01-01T00:00:00Z") } },
      { type: "file", id: "2", name: "b.jpg", size: 5, contentCreatedAt: { value: new Date(NaN) }, contentModifiedAt: undefined },
      { type: "folder", id: "3", name: "dir" },
    ];
    vi.useRealTimers();
    const entries = await provider().listFolder("x");
    expect(entries[0]).toMatchObject({ id: "1", createdAt: new Date("2022-05-06T07:08:09Z"), modifiedAt: new Date("2023-01-01T00:00:00Z") });
    expect(entries[1].createdAt).toBeUndefined();
    expect(entries[1].modifiedAt).toBeUndefined();
    expect(entries[2]).toEqual({ id: "3", name: "dir", kind: "folder" });
  });
});
