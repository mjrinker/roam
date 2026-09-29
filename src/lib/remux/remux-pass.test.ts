import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

// Recording fake db: every chained builder call returns the same thenable,
// which resolves to the next queued result; `where` conditions are captured.
type Op = { kind: "select" | "selectDistinct" | "update"; where?: SQL; set?: Record<string, unknown> };
let ops: Op[] = [];
let results: unknown[] = [];

function builder(op: Op) {
  const b: Record<string, unknown> = {};
  for (const m of ["from", "innerJoin", "limit", "orderBy", "returning"]) b[m] = () => b;
  b.set = (set: Record<string, unknown>) => {
    op.set = set;
    return b;
  };
  b.where = (w: SQL) => {
    op.where = w;
    return b;
  };
  b.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
    Promise.resolve(results.shift() ?? []).then(resolve, reject);
  return b;
}
const start = (kind: Op["kind"]) => {
  const op: Op = { kind };
  ops.push(op);
  return builder(op);
};

vi.mock("@/lib/db/client", () => ({
  db: {
    select: () => start("select"),
    selectDistinct: () => start("selectDistinct"),
    update: () => start("update"),
  },
}));
vi.mock("@/lib/storage/box-token-storage", () => ({
  BoxReauthRequiredError: class BoxReauthRequiredError extends Error {},
}));
vi.mock("@/lib/storage/box", () => ({ createBoxProviderForServer: vi.fn(), getBoxFileEntry: vi.fn() }));

import { queueRemux } from "./remux-pass";

const dialect = new PgDialect();
const sqlText = (w: SQL) => dialect.sqlToQuery(w);

beforeEach(() => {
  ops = [];
  results = [];
  delete process.env.NEXT_PUBLIC_APP_URL;
  delete process.env.CRON_SECRET;
});

describe("queueRemux", () => {
  it("does nothing for an audiobook / unknown title", async () => {
    results = [[]];
    expect(await queueRemux("t1")).toEqual({ queued: 0, alreadyDone: 0, exhausted: 0, flagged: 0 });
    expect(ops.some((o) => o.kind === "update")).toBe(false);
  });

  it("requeues eligible files, repeating the eligibility test in each UPDATE's WHERE", async () => {
    results = [
      [{ kind: "movie", serverId: "s1" }], // resolveRemuxScope
      [
        { boxFileId: "b1", remuxStatus: null },
        { boxFileId: "b2", remuxStatus: "done" },
      ], // flagged rows
      [{ boxFileId: "b1" }], // eligible ids
      [{ id: "row1" }], // update b1 → claimed by us
      [], // exhausted
    ];
    const res = await queueRemux("t1", new Date("2026-01-01T00:00:00Z"));
    expect(res).toEqual({ queued: 1, alreadyDone: 1, exhausted: 0, flagged: 2 });

    const update = ops.find((o) => o.kind === "update")!;
    expect(update.set).toMatchObject({ remuxStatus: "pending" });
    expect(typeof update.set!.remuxCallbackToken).toBe("string");

    // Compare-and-set: the same status/attempt-cap/codec conditions guard the write.
    const { sql: text } = sqlText(update.where!);
    expect(text).toContain('"remux_status" is null');
    expect(text).toContain('"remux_attempts" <');
    expect(text).toContain('"codec_probed"');
    expect(text).toContain('"audio_codec" in');
    expect(text).toContain('"box_file_id" =');
  });

  it("doesn't count a row a concurrent claim already took", async () => {
    results = [
      [{ kind: "movie", serverId: "s1" }],
      [{ boxFileId: "b1", remuxStatus: "pending" }],
      [{ boxFileId: "b1" }],
      [], // CAS matched nothing
      [],
    ];
    expect((await queueRemux("t1")).queued).toBe(0);
  });

  it("reports files that used up their attempts", async () => {
    results = [
      [{ kind: "movie", serverId: "s1" }],
      [{ boxFileId: "b1", remuxStatus: "failed" }],
      [], // nothing eligible
      [{ boxFileId: "b1" }], // exhausted
    ];
    const res = await queueRemux("t1");
    expect(res).toMatchObject({ queued: 0, exhausted: 1, flagged: 1 });
  });

  it("scopes a show to its episodes", async () => {
    results = [
      [{ kind: "show", serverId: "s1" }],
      [{ id: "e1" }, { id: "e2" }], // episodes
      [],
      [],
      [],
    ];
    await queueRemux("show1");
    const flaggedQuery = ops.filter((o) => o.kind === "select")[2];
    const { params } = sqlText(flaggedQuery.where!);
    expect(params).toEqual(expect.arrayContaining(["episode", "e1", "e2"]));
  });
});
