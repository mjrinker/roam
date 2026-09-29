import { describe, expect, it, vi, beforeEach } from "vitest";
import { mediaFiles } from "@/lib/db/schema";

// Recording fake db (no test database in this repo) — see media-files.test.ts.

type Call =
  | { op: "insert"; values: Record<string, unknown>; target: unknown; setWhere: unknown }
  | { op: "update"; set: Record<string, unknown> }
  | { op: "delete" };

let calls: Call[] = [];
let selectResults: unknown[][] = [];

function makeSelect() {
  return {
    from() {
      return {
        where() {
          return Promise.resolve(selectResults.shift() ?? []);
        },
      };
    },
  };
}

function makeWriter() {
  return {
    select: makeSelect,
    insert() {
      return {
        values(values: Record<string, unknown>) {
          return {
            onConflictDoUpdate(opts: { target: unknown; setWhere: unknown }) {
              calls.push({ op: "insert", values, target: opts.target, setWhere: opts.setWhere });
              return Promise.resolve();
            },
          };
        },
      };
    },
    update() {
      return {
        set(set: Record<string, unknown>) {
          return {
            where() {
              calls.push({ op: "update", set });
              return Promise.resolve();
            },
          };
        },
      };
    },
    delete() {
      return {
        where() {
          calls.push({ op: "delete" });
          return { returning: () => Promise.resolve(selectResults.shift() ?? []) };
        },
      };
    },
  };
}

vi.mock("@/lib/db/client", () => ({
  db: {
    ...makeWriter(),
    transaction: (fn: (tx: ReturnType<typeof makeWriter>) => Promise<unknown>) => fn(makeWriter()),
  },
}));
vi.mock("@/lib/storage/box-token-storage", () => ({
  BoxReauthRequiredError: class BoxReauthRequiredError extends Error {},
}));

import { linkVariantFiles, upsertVariant } from "./media-files";

const entry = (id: string, name: string) => ({ id, name, kind: "file" as const, sizeBytes: 100 });

beforeEach(() => {
  calls = [];
  selectResults = [];
});

describe("upsertVariant", () => {
  it("creates one owner-less variant row per primary row, targeting the variant_of unique index", async () => {
    selectResults = [[{ id: "p1" }, { id: "p2" }]];
    const ok = await upsertVariant(["p1", "p2"], { id: "v1", name: "S.aac.mp4", sizeBytes: 5 });
    expect(ok).toBe(true);
    const inserts = calls.filter((c) => c.op === "insert");
    expect(inserts).toHaveLength(2);
    for (const [i, c] of inserts.entries()) {
      if (c.op !== "insert") continue;
      expect(c.target).toBe(mediaFiles.variantOfMediaFileId);
      expect(c.values).toMatchObject({
        ownerKind: null,
        ownerId: null,
        boxFileId: "v1",
        variantOfMediaFileId: `p${i + 1}`,
      });
      expect(c.values).not.toHaveProperty("trimStartSeconds");
    }
    const done = calls.find((c) => c.op === "update");
    expect(done).toMatchObject({ set: { remuxStatus: "done" } });
  });

  it("is a no-op returning false when the job token no longer matches any primary", async () => {
    selectResults = [[]];
    const ok = await upsertVariant(["p1"], { id: "v1", name: "S.aac.mp4" }, "stale-token");
    expect(ok).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe("linkVariantFiles", () => {
  it("links a variant to every primary row sharing the original's box file id (combined episode file)", async () => {
    // primaryRows select, then upsertVariant's guard select, then (no orphans) delete.returning
    selectResults = [
      [
        { id: "a", boxFileId: "orig" },
        { id: "b", boxFileId: "orig" },
        { id: "c", boxFileId: "other" },
      ],
      [{ id: "a" }, { id: "b" }],
      [],
    ];
    await linkVariantFiles(
      "episode",
      ["e1", "e2", "e3"],
      [entry("orig", "Show - s01e01-e02.mp4"), entry("other", "Show - s01e03.mp4")],
      [entry("v", "Show - s01e01-e02.aac.mp4")]
    );
    const inserts = calls.filter((c) => c.op === "insert");
    expect(inserts.map((c) => (c.op === "insert" ? c.values.variantOfMediaFileId : null))).toEqual(["a", "b"]);
  });

  it("ignores a variant whose original isn't in this folder", async () => {
    selectResults = [[{ id: "a", boxFileId: "orig" }], []];
    await linkVariantFiles("title", ["t"], [entry("orig", "M.mp4")], [entry("v", "Other.aac.mp4")]);
    expect(calls.filter((c) => c.op === "insert")).toHaveLength(0);
  });

  it("deletes links whose variant file vanished and resets those primaries' remux state", async () => {
    selectResults = [[{ id: "a", boxFileId: "orig" }], [{ primaryId: "a" }]];
    await linkVariantFiles("title", ["t"], [entry("orig", "M.mp4")], []);
    expect(calls.some((c) => c.op === "delete")).toBe(true);
    expect(calls.find((c) => c.op === "update")).toMatchObject({ set: { remuxStatus: null } });
  });
});
