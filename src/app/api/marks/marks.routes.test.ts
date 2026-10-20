/** Only a server's admin can read or change a film's hand-marked scenes; everyone else gets "not found". */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  auth: { ok: true, serverId: "s1" } as { ok: boolean; serverId?: string; status?: number },
  admin: true,
  marks: { writesFiles: true, durationSeconds: 100, editable: [], readOnly: [] } as unknown,
  saveResult: { ok: true, marks: { writesFiles: true, durationSeconds: 100, editable: [], readOnly: [] }, filesWritten: 1 } as unknown,
  saveThrows: false,
  saved: [] as unknown[],
}));
vi.mock("@/lib/db/client", () => ({ db: {} }));
vi.mock("@/lib/auth/resolve-server", () => ({ authorizeOwner: async () => h.auth }));
vi.mock("@/lib/auth/guards", () => ({ getCurrentServerAdmin: async () => (h.admin ? { role: "admin" } : null) }));
vi.mock("@/lib/content-filter/save-marks", () => ({
  storageMarkWriter: () => ({}),
  loadMarks: async () => h.marks,
  saveMarks: async (_db: unknown, opts: unknown) => {
    if (h.saveThrows) throw new Error("boom");
    h.saved.push(opts);
    return h.saveResult;
  },
}));

import { GET, PUT } from "./[ownerKind]/[ownerId]/route";

const ctx = (ownerKind: string, ownerId = "o1") => ({ params: Promise.resolve({ ownerKind, ownerId }) }) as never;
const put = (body: unknown, kind = "title") => PUT(new Request("http://x/api/marks/title/o1", { method: "PUT", body: JSON.stringify(body) }), ctx(kind));

beforeEach(() => {
  h.auth = { ok: true, serverId: "s1" };
  h.admin = true;
  h.marks = { writesFiles: true, durationSeconds: 100, editable: [], readOnly: [] };
  h.saveThrows = false;
  h.saved = [];
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("GET /api/marks", () => {
  it("is the marks for an admin", async () => {
    const res = await GET(new Request("http://x/api/marks/title/o1?version=1080P"), ctx("title"));
    expect(res.status).toBe(200);
    expect((await res.json()).writesFiles).toBe(true);
  });
  it("looks like nothing is there to a member who isn't an admin, to someone who can't see the title, and for other kinds", async () => {
    h.admin = false;
    expect((await GET(new Request("http://x"), ctx("title"))).status).toBe(404);
    h.admin = true;
    h.auth = { ok: false, status: 404 };
    expect((await GET(new Request("http://x"), ctx("title"))).status).toBe(404);
    h.auth = { ok: true, serverId: "s1" };
    expect((await GET(new Request("http://x"), ctx("extra"))).status).toBe(404);
  });
  it("says it isn't ready when a file's length isn't known", async () => {
    h.marks = null;
    expect((await GET(new Request("http://x"), ctx("episode"))).status).toBe(409);
  });
});

describe("PUT /api/marks", () => {
  it("saves for an admin, passing the cleaned version name through", async () => {
    const res = await put({ version: " 1080P ", cues: [{ startSeconds: 1, endSeconds: 2, category: "sex", severity: "low" }] });
    expect(res.status).toBe(200);
    expect((await res.json()).filesWritten).toBe(1);
    expect(h.saved[0]).toMatchObject({ serverId: "s1", ownerKind: "title", ownerId: "o1", version: "1080p" });
  });
  it("changes nothing for anyone but an admin", async () => {
    h.admin = false;
    expect((await put({ cues: [] })).status).toBe(404);
    expect(h.saved).toEqual([]);
  });
  it("refuses a body without a list of scenes", async () => {
    expect((await put({ cues: "nope" })).status).toBe(400);
    expect((await put(null)).status).toBe(400);
  });
  it("says so, without detail, when the file can't be written, and when the film isn't ready", async () => {
    h.saveThrows = true;
    const failed = await put({ cues: [] });
    expect(failed.status).toBe(502);
    expect(JSON.stringify(await failed.json())).not.toMatch(/boom/);
    h.saveThrows = false;
    h.saveResult = { ok: false, error: "not_ready" };
    expect((await put({ cues: [] })).status).toBe(409);
  });
});
