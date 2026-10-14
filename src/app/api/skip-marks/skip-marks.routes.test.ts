/** Only a server's admin can read or change hand-marked skip times. */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ auth: { ok: true } as { ok: boolean }, admin: true, loaded: { durationSeconds: 100, marks: [] } as unknown, saved: [] as unknown[] }));
vi.mock("@/lib/db/client", () => ({ db: {} }));
vi.mock("@/lib/auth/resolve-server", () => ({ authorizeOwner: async () => h.auth }));
vi.mock("@/lib/auth/guards", () => ({ getCurrentServerAdmin: async () => (h.admin ? { role: "admin" } : null) }));
vi.mock("@/lib/skipdb/save-skip-marks", () => ({
  loadSkipMarks: async () => h.loaded,
  saveSkipMarks: async (_db: unknown, opts: unknown) => (h.saved.push(opts), h.loaded),
}));

import { GET, PUT } from "./[ownerKind]/[ownerId]/route";

const ctx = (kind: string) => ({ params: Promise.resolve({ ownerKind: kind, ownerId: "o1" }) }) as never;
const put = (body: unknown, kind = "episode") => PUT(new Request("http://x", { method: "PUT", body: JSON.stringify(body) }), ctx(kind));
beforeEach(() => {
  h.auth = { ok: true };
  h.admin = true;
  h.loaded = { durationSeconds: 100, marks: [] };
  h.saved = [];
});

describe("/api/skip-marks", () => {
  it("reads and saves for an admin", async () => {
    expect((await GET(new Request("http://x?version=1080P"), ctx("episode"))).status).toBe(200);
    expect((await put({ version: " 1080P ", marks: [{ kind: "intro", startSeconds: 1, endSeconds: 9 }] })).status).toBe(200);
    expect(h.saved[0]).toMatchObject({ ownerKind: "episode", ownerId: "o1", version: "1080p" });
  });
  it("is not found for anyone else, for other kinds, and when the film can't be seen", async () => {
    h.admin = false;
    expect((await GET(new Request("http://x"), ctx("episode"))).status).toBe(404);
    expect((await put({ marks: [] })).status).toBe(404);
    expect(h.saved).toEqual([]);
    h.admin = true;
    expect((await GET(new Request("http://x"), ctx("extra"))).status).toBe(404);
    h.auth = { ok: false };
    expect((await GET(new Request("http://x"), ctx("episode"))).status).toBe(404);
  });
  it("refuses a body without a list, and says when it isn't ready", async () => {
    expect((await put({ marks: "x" })).status).toBe(400);
    h.loaded = null;
    expect((await put({ marks: [] })).status).toBe(409);
    expect((await GET(new Request("http://x"), ctx("title"))).status).toBe(409);
  });
});
