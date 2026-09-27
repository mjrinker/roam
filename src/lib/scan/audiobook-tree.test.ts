import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/storage/box-token-storage", () => ({
  BoxReauthRequiredError: class BoxReauthRequiredError extends Error {},
}));

import { BoxReauthRequiredError } from "@/lib/storage/box-token-storage";
import type { StorageEntry } from "@/lib/storage/provider";
import { collectBookFiles, discoverAuthorUnits, type DiscoveredUnit } from "./audiobook-tree";

// ── A tiny in-memory Box ─────────────────────────────────────────────────

type Node = string | { [folderName: string]: Node[] };

/** Builds a provider from a nested description: strings are files, objects are folders. */
function fakeBox(root: Node[], opts: { failOn?: string; failWith?: Error } = {}) {
  const folders = new Map<string, StorageEntry[]>();
  function build(path: string, nodes: Node[]): StorageEntry[] {
    const entries = nodes.map((n): StorageEntry => {
      if (typeof n === "string") return { id: `${path}/${n}`, name: n, kind: "file", sizeBytes: 1000 };
      const [name] = Object.keys(n);
      const id = `${path}/${name}`;
      folders.set(id, build(id, n[name]));
      return { id, name, kind: "folder" };
    });
    return entries;
  }
  folders.set("root", build("root", root));
  const listFolder = vi.fn(async (id: string) => {
    if (opts.failOn && id.endsWith(opts.failOn)) throw opts.failWith ?? new Error("Box exploded");
    return folders.get(id) ?? [];
  });
  return { provider: { listFolder }, root: folders.get("root")!, listFolder };
}

async function collect(gen: AsyncGenerator<DiscoveredUnit>) {
  const units: DiscoveredUnit[] = [];
  for await (const u of gen) units.push(u);
  return units;
}

const bookSummary = (u: DiscoveredUnit) =>
  u.books.map((b) => ({ name: b.folder.name, files: b.files.map((f) => f.name), author: b.folderAuthor, series: b.seriesName }));

describe("discoverAuthorUnits", () => {
  it("finds books directly under an author, in scan order", async () => {
    const { provider, root } = fakeBox([
      { "Andy Weir": [{ "Project Hail Mary (2021)": ["Project Hail Mary.m4b", "cover.jpg"] }, { "Artemis (2017)": ["01.mp3", "02.mp3"] }] },
    ]);
    const units = await collect(discoverAuthorUnits(provider, root[0], null));
    expect(units.map((u) => u.childName)).toEqual(["Artemis (2017)", "Project Hail Mary (2021)"]);
    expect(bookSummary(units[1])).toEqual([
      { name: "Project Hail Mary (2021)", files: ["Project Hail Mary.m4b"], author: "Andy Weir", series: null },
    ]);
  });

  it("treats a folder of book folders under an author as a series", async () => {
    const { provider, root } = fakeBox([
      {
        "Brandon Sanderson": [
          {
            "The Stormlight Archive": [
              { "Book 1 - The Way of Kings": ["a.m4b"] },
              { "Book 2 - Words of Radiance": ["b.m4b"] },
              { "Notes": ["readme.txt"] },
            ],
          },
          { "Elantris (2005)": ["e.m4b"] },
        ],
      },
    ]);
    const units = await collect(discoverAuthorUnits(provider, root[0], null));
    expect(units.map((u) => u.childName)).toEqual(["Elantris (2005)", "The Stormlight Archive"]);
    expect(bookSummary(units[1])).toEqual([
      { name: "Book 1 - The Way of Kings", files: ["a.m4b"], author: "Brandon Sanderson", series: "The Stormlight Archive" },
      { name: "Book 2 - Words of Radiance", files: ["b.m4b"], author: "Brandon Sanderson", series: "The Stormlight Archive" },
    ]);
  });

  it("flattens CD/Disc subfolders into one book, disc-ordered, without treating them as a series", async () => {
    const { provider, root } = fakeBox([
      {
        "Author": [
          { "Big Book": [{ "Disc 10": ["1.mp3"] }, { "Disc 2": ["b.mp3", "a.mp3"] }, { "CD1": ["x.mp3"] }, { "Extras": ["bonus.mp3"] }] },
        ],
      },
    ]);
    const units = await collect(discoverAuthorUnits(provider, root[0], null));
    expect(units).toHaveLength(1);
    expect(units[0].books).toHaveLength(1);
    expect(units[0].books[0].files.map((f) => f.name)).toEqual(["x.mp3", "a.mp3", "b.mp3", "1.mp3"]);
    expect(units[0].books[0].seriesName).toBeNull();
  });

  it("treats a top-level folder that itself holds audio as a book with no author", async () => {
    const { provider, root } = fakeBox([{ "Standalone Book (2019)": ["book.m4b"] }]);
    const units = await collect(discoverAuthorUnits(provider, root[0], null));
    expect(units).toHaveLength(1);
    expect(units[0].childName).toBeNull();
    expect(bookSummary(units[0])).toEqual([
      { name: "Standalone Book (2019)", files: ["book.m4b"], author: null, series: null },
    ]);
  });

  it("resumes after a sub-cursor using the shared collation", async () => {
    const { provider, root } = fakeBox([
      { Author: [{ "Book 2": ["2.mp3"] }, { "Book 10": ["10.mp3"] }, { "Book 1": ["1.mp3"] }] },
    ]);
    const units = await collect(discoverAuthorUnits(provider, root[0], "Book 2"));
    expect(units.map((u) => u.childName)).toEqual(["Book 10"]);
  });

  it("ignores extras and non-audio files", async () => {
    const { provider, root } = fakeBox([
      { Author: [{ Book: ["Book.m4b", "Sample-trailer.mp3", "cover.jpg", "notes.txt"] }] },
    ]);
    const units = await collect(discoverAuthorUnits(provider, root[0], null));
    expect(units[0].books[0].files.map((f) => f.name)).toEqual(["Book.m4b"]);
  });

  it("yields empty units for folders without audio", async () => {
    const { provider, root } = fakeBox([{ Author: [{ "Empty Folder": ["readme.txt"] }, { Real: ["r.mp3"] }] }]);
    const units = await collect(discoverAuthorUnits(provider, root[0], null));
    expect(units.map((u) => [u.childName, u.books.length])).toEqual([["Empty Folder", 0], ["Real", 1]]);
  });

  it("reports an unreadable unit and carries on with the next", async () => {
    const { provider, root } = fakeBox([{ Author: [{ Bad: ["b.mp3"] }, { Good: ["g.mp3"] }] }], { failOn: "/Bad" });
    const units = await collect(discoverAuthorUnits(provider, root[0], null));
    expect(units[0]).toMatchObject({ childName: "Bad", books: [], error: "Box exploded" });
    expect(units[1].books[0].folder.name).toBe("Good");
  });

  it("aborts the whole walk when the Box connection needs reauth", async () => {
    const { provider, root } = fakeBox([{ Author: [{ Bad: ["b.mp3"] }, { Good: ["g.mp3"] }] }], {
      failOn: "/Bad",
      failWith: new BoxReauthRequiredError("reauth"),
    });
    await expect(collect(discoverAuthorUnits(provider, root[0], null))).rejects.toThrow("reauth");
  });

  it("lists Box lazily so a caller can stop between units", async () => {
    const { provider, root, listFolder } = fakeBox([
      { Author: [{ A: ["a.mp3"] }, { B: ["b.mp3"] }, { C: ["c.mp3"] }] },
    ]);
    const gen = discoverAuthorUnits(provider, root[0], null);
    await gen.next(); // A
    const callsAfterFirst = listFolder.mock.calls.length;
    await gen.return(undefined);
    expect(listFolder.mock.calls.length).toBe(callsAfterFirst);
    expect(callsAfterFirst).toBeLessThan(6);
  });
});

describe("collectBookFiles", () => {
  it("returns null for a folder with only subfolders that aren't discs", async () => {
    const { provider, root } = fakeBox([{ Series: [{ "Book 1": ["a.mp3"] }] }]);
    const children = await provider.listFolder(root[0].id);
    expect(await collectBookFiles(provider, children)).toBeNull();
  });
});
