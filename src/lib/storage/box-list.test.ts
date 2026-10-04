import { describe, expect, it, vi } from "vitest";
import { BoxApiError } from "box-node-sdk";
import { ListingTruncatedError } from "./provider";

// A fake Box client serving `total` files, a page at a time.
const h = vi.hoisted(() => ({ total: 0, pages: [] as number[] }));
vi.mock("./box-token-storage", () => ({
  ensureFreshAccessToken: async () => undefined,
  withBoxClient: async (_serverId: string, fn: (client: unknown) => Promise<unknown>) =>
    fn({
      files: {
        getFileById: async (id: string) => {
          if (id === "missing") throw new BoxApiError({ message: "not found", timestamp: "", error: undefined, requestInfo: {} as never, responseInfo: { statusCode: 404 } as never });
          if (id === "boom") throw new BoxApiError({ message: "server error", timestamp: "", error: undefined, requestInfo: {} as never, responseInfo: { statusCode: 500 } as never });
          return { id, itemStatus: id === "trashed" ? "trashed" : id === "nostatus" ? undefined : "active" };
        },
      },
      folders: {
        getFolderItems: async (_id: string, { queryParams }: { queryParams: { offset: number; limit: number } }) => {
          h.pages.push(queryParams.offset);
          const count = Math.max(0, Math.min(queryParams.limit, h.total - queryParams.offset));
          return {
            totalCount: h.total,
            entries: Array.from({ length: count }, (_, i) => ({ type: "file", id: `f${queryParams.offset + i}`, name: `n${queryParams.offset + i}`, size: 1 })),
          };
        },
      },
    }),
}));

import { createBoxProviderForServer } from "./box";

describe("Box file existence", () => {
  it("is true for an active file and false only for a definite 'gone' (404 or trashed); anything else is an error", async () => {
    const provider = createBoxProviderForServer("s");
    expect(await provider.fileExists!("active-file")).toBe(true);
    expect(await provider.fileExists!("nostatus")).toBe(true); // no status reported: don't call it gone
    expect(await provider.fileExists!("trashed")).toBe(false);
    expect(await provider.fileExists!("missing")).toBe(false);
    await expect(provider.fileExists!("boom")).rejects.toBeInstanceOf(BoxApiError); // a server error is not "gone"
  });
});

describe("Box folder listing", () => {
  it("returns everything for a normal folder, strict or not", async () => {
    h.total = 2500;
    h.pages = [];
    const provider = createBoxProviderForServer("s");
    expect(await provider.listFolder("x")).toHaveLength(2500);
    expect(await provider.listFolder("x", { strict: true })).toHaveLength(2500);
  });

  it("cuts a runaway folder off silently by default, but a strict listing refuses to pretend it's complete", async () => {
    h.total = 25_000;
    const provider = createBoxProviderForServer("s");
    expect((await provider.listFolder("x")).length).toBe(20_000);
    await expect(provider.listFolder("x", { strict: true })).rejects.toBeInstanceOf(ListingTruncatedError);
  });

  it("refuses a byte-range read larger than any probe legitimately needs, before touching the network", async () => {
    const provider = createBoxProviderForServer("s");
    await expect(provider.fetchByteRange("file", 0, 5 * 1024 * 1024)).rejects.toThrow(/refusing/);
    await expect(provider.fetchByteRange("file", 100, 100 + 50_000_000)).rejects.toThrow(/refusing/);
  });

  it("a folder of exactly the cap is complete, not truncated", async () => {
    h.total = 20_000;
    const provider = createBoxProviderForServer("s");
    expect(await provider.listFolder("x", { strict: true })).toHaveLength(20_000);
  });
});
