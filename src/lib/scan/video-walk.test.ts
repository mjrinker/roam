import { describe, expect, it, vi } from "vitest";
import type { StorageEntry } from "@/lib/storage/provider";
import { ListingTruncatedError } from "@/lib/storage/provider";
import { decodeSub, encodeSub, walkVideoTree, type WalkedDir } from "./video-walk";

type Tree = { [folderId: string]: StorageEntry[] };
const folder = (id: string, name: string): StorageEntry => ({ id, name, kind: "folder" });
const file = (id: string, name: string): StorageEntry => ({ id, name, kind: "file", sizeBytes: 1 });

/**
 * R (top-level folder)
 * ├── 0-early/ └── inner/      (sorts before everything else)
 * ├── A/ ├── B/ └── Deep/ , └── C/
 * └── D/
 */
const tree: Tree = {
  R: [file("f-r", "r.mp4"), folder("early", "0-early"), folder("a", "A"), folder("d", "D")],
  early: [folder("inner", "inner")],
  inner: [file("f-inner", "inner.mp4")],
  a: [file("f-a", "a.mp4"), folder("c", "C"), folder("b", "B")], // listed out of order on purpose
  b: [folder("deep", "Deep")],
  deep: [file("f-deep", "deep.mp4")],
  c: [file("f-c", "c.mp4")],
  d: [file("f-d", "d.mp4")],
};
const top = folder("R", "Top");
const ORDER: string[][] = [[], ["early"], ["early", "inner"], ["a"], ["a", "b"], ["a", "b", "deep"], ["a", "c"], ["d"]];

function fake(over: Tree = tree) {
  return {
    listFolder: vi.fn(async (id: string, opts?: { strict?: boolean }) => {
      void opts; // recorded by the mock for the strictness assertion
      return over[id] ?? [];
    }),
  };
}
async function collect(gen: AsyncGenerator<WalkedDir>) {
  const out: WalkedDir[] = [];
  for await (const d of gen) out.push(d);
  return out;
}

describe("encodeSub / decodeSub", () => {
  it("round-trips id paths, and the encoding is always truthy (so progress counting treats it as mid-folder)", () => {
    for (const ids of [[], ["1"], ["10", "20", "30"]]) {
      const sub = encodeSub(ids);
      expect(sub).toBeTruthy();
      expect(decodeSub(sub)).toEqual(ids);
    }
  });
  it("rejects anything that isn't an encoded path", () => {
    expect(decodeSub(undefined)).toBeNull();
    expect(decodeSub(null)).toBeNull();
    expect(decodeSub("")).toBeNull();
    expect(decodeSub("Season 1")).toBeNull();
  });
});

describe("walkVideoTree", () => {
  it("visits directories in pre-order with siblings sorted, reporting id and name paths", async () => {
    const dirs = await collect(walkVideoTree(fake(), top, null));
    expect(dirs.map((d) => d.idPath)).toEqual(ORDER);
    expect(dirs.map((d) => d.namePath.join("/"))).toEqual(["", "0-early", "0-early/inner", "A", "A/B", "A/B/Deep", "A/C", "D"]);
    expect(dirs[0].entries.map((e) => e.name)).toContain("r.mp4");
  });

  it("resuming after any directory yields exactly the directories that come after it", async () => {
    for (let k = 0; k < ORDER.length; k++) {
      const dirs = await collect(walkVideoTree(fake(), top, ORDER[k]));
      expect(dirs.map((d) => d.idPath), `resume after ${ORDER[k].join("/") || "(top)"}`).toEqual(ORDER.slice(k + 1));
    }
  });

  it("resuming re-lists only the ancestors of the resume point, not the finished subtrees before it", async () => {
    const provider = fake();
    await collect(walkVideoTree(provider, top, ["a", "b", "deep"]));
    const listed = provider.listFolder.mock.calls.map((c) => c[0]);
    expect(listed).not.toContain("early"); // an earlier sibling subtree
    expect(listed).not.toContain("inner");
    expect(listed.slice(0, 4)).toEqual(["R", "a", "b", "deep"]); // the ancestors, down to the resume directory
  });

  it("starts that folder over when the resume point has vanished, and yields nothing twice", async () => {
    const dirs = await collect(walkVideoTree(fake(), top, ["a", "gone", "deeper"]));
    expect(dirs.map((d) => d.idPath)).toEqual(ORDER);
  });

  it("lists strictly, so a truncated listing can never pass for a smaller folder", async () => {
    const provider = fake();
    await collect(walkVideoTree(provider, top, null));
    for (const call of provider.listFolder.mock.calls) expect(call[1]).toEqual({ strict: true });

    const failing = {
      listFolder: vi.fn(async (id: string) => {
        if (id === "b") throw new ListingTruncatedError(id);
        return tree[id] ?? [];
      }),
    };
    const seen: string[] = [];
    await expect(
      (async () => {
        for await (const d of walkVideoTree(failing, top, null)) seen.push(d.namePath.join("/"));
      })()
    ).rejects.toBeInstanceOf(ListingTruncatedError);
    expect(seen).toEqual(["", "0-early", "0-early/inner", "A"]); // everything before the failure, nothing after, no restart
  });

  it("orders siblings the way the scanner does (numbers by value)", async () => {
    const seasons: Tree = {
      R: [folder("s10", "Season 10"), folder("s2", "Season 2"), folder("s1", "Season 1")],
    };
    const dirs = await collect(walkVideoTree(fake(seasons), top, null));
    expect(dirs.map((d) => d.namePath.join("/"))).toEqual(["", "Season 1", "Season 2", "Season 10"]);
  });
});
