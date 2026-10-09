import { describe, expect, it, vi, beforeEach } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { mediaFiles } from "@/lib/db/schema";
import { estimateAudioDurationMs } from "./containers";

describe("estimateAudioDurationMs", () => {
  it("assumes 128 kbps for mp3 and 64 kbps for m4b/m4a", () => {
    expect(estimateAudioDurationMs("mp3", 16_000_000)).toBe(1_000_000); // 16MB * 8 / 128k = 1000s
    expect(estimateAudioDurationMs("m4b", 8_000_000)).toBe(1_000_000); // 8MB * 8 / 64k = 1000s
    expect(estimateAudioDurationMs("m4a", 8_000_000)).toBe(1_000_000);
  });

  it("does not guess for video or unknown containers, or missing sizes", () => {
    expect(estimateAudioDurationMs("mp4", 1_000_000)).toBeNull();
    expect(estimateAudioDurationMs("mp3", 0)).toBeNull();
  });
});

// ── upsertMediaSegments: recording fake db ─────────────────────────────────
// There's no test database in this repo, so `db.transaction` is faked with
// an object that records exactly what each chained call was given, instead
// of executing anything. This is enough to pin down (a) the conflict
// target and (b) the owner-scoping of every delete/update, without a real
// Postgres connection.

type RecordedCall =
  | { op: "delete"; table: unknown; where: unknown }
  | { op: "update"; table: unknown; set: unknown; where: unknown }
  | { op: "insert"; table: unknown; values: unknown; target: unknown; set: unknown };

let recordedCalls: RecordedCall[] = [];

function makeTx() {
  return {
    delete(table: unknown) {
      return {
        where(where: unknown) {
          recordedCalls.push({ op: "delete", table, where });
          return Promise.resolve();
        },
      };
    },
    update(table: unknown) {
      return {
        set(set: unknown) {
          return {
            where(where: unknown) {
              recordedCalls.push({ op: "update", table, set, where });
              return Promise.resolve();
            },
          };
        },
      };
    },
    insert(table: unknown) {
      return {
        values(values: unknown) {
          return {
            onConflictDoUpdate(opts: { target: unknown; set: unknown }) {
              recordedCalls.push({ op: "insert", table, values, target: opts.target, set: opts.set });
              return Promise.resolve();
            },
          };
        },
      };
    },
  };
}

vi.mock("@/lib/db/client", () => ({
  db: {
    transaction: (fn: (tx: ReturnType<typeof makeTx>) => Promise<unknown>) => fn(makeTx()),
  },
}));

vi.mock("@/lib/storage/box-token-storage", () => ({
  BoxReauthRequiredError: class BoxReauthRequiredError extends Error {},
}));

// Renders a drizzle SQL condition (as passed to .where(...)) to raw SQL +
// params, so a test can assert an owner id is actually among the params
// without needing a live connection.
function renderWhere(where: unknown) {
  return new PgDialect().sqlToQuery(where as Parameters<PgDialect["sqlToQuery"]>[0]);
}

import type { StorageEntry } from "@/lib/storage/provider";
import { upsertMediaSegments } from "./media-files";

const file = (id: string, name: string): StorageEntry => ({
  id,
  name,
  kind: "file",
  sizeBytes: 1000,
});

describe("upsertMediaSegments", () => {
  beforeEach(() => {
    recordedCalls = [];
  });

  it("scopes the upsert conflict target to (owner_kind, owner_id, box_file_id), not just box_file_id", async () => {
    await upsertMediaSegments("episode", "ep-5", [file("box-1", "Show - S01E05-E06.mp4")]);
    const insert = recordedCalls.find((c) => c.op === "insert");
    expect(insert).toBeDefined();
    expect(insert!.target).toEqual([mediaFiles.ownerKind, mediaFiles.ownerId, mediaFiles.boxFileId]);
  });

  it("gives a multi-episode file's second owner its own insert, not a steal of the first owner's row", async () => {
    await upsertMediaSegments("episode", "ep-5", [file("box-1", "Show - S01E05-E06.mp4")]);
    recordedCalls = [];
    await upsertMediaSegments("episode", "ep-6", [file("box-1", "Show - S01E05-E06.mp4")]);

    const insert = recordedCalls.find((c) => c.op === "insert")!;
    expect((insert.values as { ownerId: string }).ownerId).toBe("ep-6");
    expect((insert.values as { boxFileId: string }).boxFileId).toBe("box-1");

    // The stale-file delete and the negative-index park are scoped to THIS
    // owner (ep-6) only — they must never be able to touch ep-5's row for
    // the same underlying Box file.
    const scopedCalls = recordedCalls.filter((c) => c.op === "delete" || c.op === "update");
    expect(scopedCalls.length).toBeGreaterThan(0);
    for (const call of scopedCalls) {
      const { params } = renderWhere(call.where);
      expect(params).toContain("ep-6");
      expect(params).not.toContain("ep-5");
    }
  });

  it("keeps today's operation order and set payload for an ordinary re-upsert", async () => {
    await upsertMediaSegments("title", "movie-1", [file("A", "Movie - pt1.mp4"), file("B", "Movie - pt2.mp4")]);
    recordedCalls = [];
    // Files swap order on rescan (B first, then A).
    await upsertMediaSegments("title", "movie-1", [file("B", "Movie - pt1.mp4"), file("A", "Movie - pt2.mp4")]);

    expect(recordedCalls.map((c) => c.op)).toEqual(["delete", "update", "insert", "insert"]);

    const inserts = recordedCalls.filter((c) => c.op === "insert");
    expect(inserts.map((c) => (c.values as { boxFileId: string }).boxFileId)).toEqual(["B", "A"]);
    expect(inserts[0].set).toEqual({ partIndex: 0, versionLabel: "", filename: "Movie - pt1.mp4", sizeBytes: 1000 });
    expect(inserts[1].set).toEqual({ partIndex: 1, versionLabel: "", filename: "Movie - pt2.mp4", sizeBytes: 1000 });
  });
});
