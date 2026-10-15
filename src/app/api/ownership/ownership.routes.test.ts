/** The ownership routes: who may do what, and what a blocked play looks like. Real database, faked sign-in. */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  testDb: null as unknown as { db: import("@/lib/playlists/test-db").TestDb },
  who: null as null | { accountId: string; viewerId: string; viewerRole: "owner" | "admin" | "limited"; role: "admin" | "viewer"; serverId: string },
}));
vi.mock("@/lib/db/client", async () => {
  const { createTestDb } = await import("@/lib/playlists/test-db");
  h.testDb = await createTestDb();
  return { db: h.testDb.db };
});
vi.mock("@/lib/auth/viewer", () => ({
  getCurrentViewer: async () => (h.who ? { account: { id: h.who.accountId }, viewer: { id: h.who.viewerId, role: h.who.viewerRole } } : null),
}));
vi.mock("@/lib/auth/guards", () => ({
  getCurrentProfile: async () => (h.who ? { id: h.who.accountId } : null),
  getCurrentServerAdmin: async (serverId: string) =>
    h.who && h.who.role === "admin" && h.who.viewerRole !== "limited" && h.who.serverId === serverId ? { profile: { id: h.who.accountId }, viewer: { id: h.who.viewerId, role: h.who.viewerRole }, role: "admin" } : null,
}));
vi.mock("@/lib/auth/resolve-server", async () => {
  const { playUnitFor } = await import("@/lib/ownership/sessions");
  return {
    authorizeOwner: async (kind: "title" | "episode" | "extra", id: string) => {
      const unit = await playUnitFor(h.testDb.db, kind, id);
      if (!unit || !h.who || unit.serverId !== h.who.serverId) return { ok: false, status: 404 };
      return {
        ok: true,
        serverId: unit.serverId,
        libraryId: "l",
        libraryKind: unit.libraryKind,
        member: { profile: { id: h.who.accountId }, viewer: { id: h.who.viewerId, role: h.who.viewerRole }, role: h.who.role },
      };
    },
  };
});
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: async () => true }));

import { eq } from "drizzle-orm";
import { episodes, ownershipEvidence, seasons, serverMembers, viewers } from "@/lib/db/schema";
import { makeAccount, makeLibrary, makeServer, makeTitle, type TestDb } from "@/lib/playlists/test-db";
import { addEvidence, assignOwners, openClaims, saveSettings, setShared, submitClaim } from "@/lib/ownership/owners";
import { ownershipGate } from "@/lib/ownership/gate";
import { POST as claimPost } from "./claims/route";
import { POST as decisionPost } from "./claims/[claimId]/decision/route";
import { GET as pictureGet } from "./claims/[claimId]/pictures/[pictureId]/route";
import { PUT as ownersPut } from "./owners/route";
import { PUT as minePut } from "./mine/route";
import { PUT as settingsPut } from "../servers/[serverId]/ownership/route";
import { POST as beatPost } from "../playback/beat/route";
import { PUT as watchPut } from "../playback/watch/route";
import { GET as notificationsGet } from "../notifications/route";

let db: TestDb;
beforeAll(async () => {
  await import("@/lib/db/client");
  db = h.testDb.db;
});
beforeEach(() => {
  h.who = null;
});

const req = (url: string, method: string, body?: unknown) => new Request(`http://x${url}`, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
let n = 0;
async function world() {
  const admin = await makeAccount(db, `adm${++n}`);
  const server = await makeServer(db, admin.accountId);
  const movies = await makeLibrary(db, server.id, "movies", "everyone");
  const shows = await makeLibrary(db, server.id, "shows", "everyone");
  const ann = await makeAccount(db, `ann${++n}`);
  const bo = await makeAccount(db, `bo${++n}`);
  for (const m of [ann, bo]) await db.insert(serverMembers).values({ serverId: server.id, profileId: m.accountId, role: "viewer" });
  const movie = await makeTitle(db, movies.id, { kind: "movie", boxFolderId: `file:r${++n}` });
  const show = await makeTitle(db, shows.id, { kind: "show", boxFolderId: `file:r${++n}` });
  const [s1] = await db.insert(seasons).values({ titleId: show.id, number: 1, boxFolderId: `rs1-${n}` }).returning();
  const [ep] = await db.insert(episodes).values({ seasonId: s1.id, number: 1, boxFolderId: `re-${n}` }).returning();
  const as = (m: typeof admin, role: "admin" | "viewer" = "viewer", viewerRole: "owner" | "admin" | "limited" = "owner") => {
    h.who = { accountId: m.accountId, viewerId: m.viewer.id, viewerRole, role, serverId: server.id };
  };
  return { admin, server, movies, movie, show, s1, ep, ann, bo, as };
}

describe("claiming", () => {
  it("works for a member, once the server tracks ownership", async () => {
    const w = await world();
    w.as(w.ann);
    expect((await claimPost(req("/", "POST", { titleId: w.movie.id }))).status).toBe(409); // not switched on yet
    await saveSettings(db, w.server.id, { enabled: true, claimMode: "instant" });
    const res = await claimPost(req("/", "POST", { titleId: w.movie.id }));
    expect(await res.json()).toEqual({ status: "owned" });
  });
  it("needs a season for a show, and is refused for strangers, signed-out visitors and limited profiles", async () => {
    const w = await world();
    await saveSettings(db, w.server.id, { enabled: true, claimMode: "instant" });
    w.as(w.ann);
    expect((await claimPost(req("/", "POST", { titleId: w.show.id }))).status).toBe(404);
    expect((await claimPost(req("/", "POST", { titleId: w.show.id, seasonId: w.s1.id }))).status).toBe(200);
    w.as(w.bo, "viewer", "limited");
    expect((await claimPost(req("/", "POST", { titleId: w.movie.id }))).status).toBe(403);
    h.who = null;
    expect((await claimPost(req("/", "POST", { titleId: w.movie.id }))).status).toBe(404);
    const other = await world();
    w.as(w.ann);
    expect((await claimPost(req("/", "POST", { titleId: other.movie.id }))).status).toBe(404); // someone else's server
  });
  it("rejects a body it doesn't understand, and a non-JSON body", async () => {
    const w = await world();
    await saveSettings(db, w.server.id, { enabled: true });
    w.as(w.ann);
    expect((await claimPost(req("/", "POST", { titleId: w.movie.id, extra: 1 }))).status).toBe(400);
    expect((await claimPost(new Request("http://x/", { method: "POST", headers: { "Content-Type": "text/plain" }, body: "x" }))).status).toBe(415);
  });
});

describe("deciding a claim", () => {
  it("is for the server's admin only, and says nothing to anyone else", async () => {
    const w = await world();
    await saveSettings(db, w.server.id, { enabled: true, claimMode: "review" });
    await submitClaim(db, { titleId: w.movie.id, accountId: w.ann.accountId });
    const [claim] = await openClaims(db, w.server.id);
    const ctx = { params: Promise.resolve({ claimId: claim.id }) } as never;
    w.as(w.ann); // the claimant can't approve their own
    expect((await decisionPost(req("/", "POST", { kind: "approve" }), ctx)).status).toBe(404);
    w.as(w.bo);
    expect((await decisionPost(req("/", "POST", { kind: "approve" }), ctx)).status).toBe(404);
    const other = await world();
    other.as(other.admin, "admin"); // an admin of another server
    expect((await decisionPost(req("/", "POST", { kind: "approve" }), ctx)).status).toBe(404);
    w.as(w.admin, "admin");
    expect((await decisionPost(req("/", "POST", { kind: "evidence" }), ctx)).status).toBe(400); // asking needs a note
    expect((await decisionPost(req("/", "POST", { kind: "approve" }), ctx)).status).toBe(200);
    expect((await decisionPost(req("/", "POST", { kind: "approve" }), ctx)).status).toBe(409);
  });
});

describe("evidence pictures", () => {
  it("can be seen only by the server's admin, and are served as an inert image", async () => {
    const w = await world();
    await saveSettings(db, w.server.id, { enabled: true, claimMode: "review" });
    await submitClaim(db, { titleId: w.movie.id, accountId: w.ann.accountId });
    const [claim] = await openClaims(db, w.server.id);
    const { decideClaim } = await import("@/lib/ownership/owners");
    await decideClaim(db, { serverId: w.server.id, claimId: claim.id, decision: { kind: "evidence", note: "photo please" } });
    expect(await addEvidence(db, { claimId: claim.id, accountId: w.ann.accountId, contentType: "image/jpeg", dataBase64: Buffer.from("fake").toString("base64") })).toBe("ok");
    const [pic] = await db.select().from(ownershipEvidence).where(eq(ownershipEvidence.claimId, claim.id));
    const ctx = { params: Promise.resolve({ claimId: claim.id, pictureId: pic.id }) } as never;
    w.as(w.ann);
    expect((await pictureGet(req("/", "GET"), ctx)).status).toBe(404);
    w.as(w.admin, "admin");
    const res = await pictureGet(req("/", "GET"), ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/jpeg");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toContain("sandbox");
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe("fake");
  });
});

describe("assigning owners", () => {
  it("is for the server's admin, takes titles, and never reaches into another server", async () => {
    const w = await world();
    const body = { serverId: w.server.id, accountId: w.ann.accountId, action: "assign", titleIds: [w.movie.id] };
    w.as(w.bo);
    expect((await ownersPut(req("/", "PUT", body))).status).toBe(404);
    w.as(w.admin, "admin");
    expect(await (await ownersPut(req("/", "PUT", body))).json()).toEqual({ added: 1 });
    const other = await world();
    expect(await (await ownersPut(req("/", "PUT", { serverId: w.server.id, accountId: w.ann.accountId, action: "assign", titleIds: [other.movie.id] }))).json()).toEqual({ added: 0 });
    expect(await (await ownersPut(req("/", "PUT", { ...body, action: "remove" }))).json()).toEqual({ removed: 1 });
  });
  it("expands a show to its seasons", async () => {
    const w = await world();
    w.as(w.admin, "admin");
    expect(await (await ownersPut(req("/", "PUT", { serverId: w.server.id, accountId: w.bo.accountId, action: "assign", titleIds: [w.show.id] }))).json()).toEqual({ added: 1 });
  });
});

describe("settings", () => {
  it("can be changed only by the admin", async () => {
    const w = await world();
    const ctx = { params: Promise.resolve({ serverId: w.server.id }) } as never;
    w.as(w.ann);
    expect((await settingsPut(req("/", "PUT", { enabled: true }), ctx)).status).toBe(404);
    w.as(w.admin, "admin");
    expect(await (await settingsPut(req("/", "PUT", { enabled: true, limitConcurrent: true, limitKinds: ["movies", "movies"] }), ctx)).json()).toMatchObject({ enabled: true, limitConcurrent: true, limitKinds: ["movies"] });
    expect((await settingsPut(req("/", "PUT", { limitKinds: ["music"] }), ctx)).status).toBe(400);
  });
});

describe("withdrawing and what a blocked play looks like", () => {
  it("says so (423), and lets the owner and the waiting list through", async () => {
    const w = await world();
    await saveSettings(db, w.server.id, { enabled: true, limitConcurrent: true });
    await assignOwners(db, { serverId: w.server.id, units: [{ titleId: w.movie.id, seasonId: null }], accountId: w.ann.accountId, via: "assigned" });
    w.as(w.ann);
    expect((await minePut(req("/", "PUT", { titleId: w.movie.id, shared: false }))).status).toBe(200);
    w.as(w.bo);
    expect((await minePut(req("/", "PUT", { titleId: w.movie.id, shared: false }))).status).toBe(409); // owns nothing
    const blocked = await ownershipGate({ viewerId: w.bo.viewer.id, accountId: w.bo.accountId }, "title", w.movie.id, { take: true });
    expect(blocked?.status).toBe(423);
    expect(await blocked?.json()).toMatchObject({ code: "withdrawn", unit: { titleId: w.movie.id, seasonId: null } });
    expect((await beatPost(req("/", "POST", { ownerKind: "title", ownerId: w.movie.id }))).status).toBe(423);
    w.as(w.ann);
    expect(await ownershipGate({ viewerId: w.ann.viewer.id, accountId: w.ann.accountId }, "title", w.movie.id, { take: true })).toBeNull();
    w.as(w.ann);
    await minePut(req("/", "PUT", { titleId: w.movie.id, shared: true }));
    // Ann is still watching it, and now that copy is shared she takes the only place: Bo has to wait until she is done.
    w.as(w.bo);
    expect((await beatPost(req("/", "POST", { ownerKind: "title", ownerId: w.movie.id }))).status).toBe(423);
    const { endPlay } = await import("@/lib/ownership/sessions");
    await endPlay(db, w.ann.viewer.id);
    expect((await beatPost(req("/", "POST", { ownerKind: "title", ownerId: w.movie.id }))).status).toBe(200);
  });
  it("tells the second viewer to wait when the only copy is in use, and lets them ask to be told", async () => {
    const w = await world();
    await saveSettings(db, w.server.id, { enabled: true, limitConcurrent: true });
    await assignOwners(db, { serverId: w.server.id, units: [{ titleId: w.show.id, seasonId: w.s1.id }], accountId: w.ann.accountId, via: "assigned" });
    w.as(w.ann);
    expect((await beatPost(req("/", "POST", { ownerKind: "episode", ownerId: w.ep.id }))).status).toBe(200);
    w.as(w.bo);
    const busy = await beatPost(req("/", "POST", { ownerKind: "episode", ownerId: w.ep.id }));
    expect(busy.status).toBe(423);
    const info = (await busy.json()) as { code: string; unit: { titleId: string; seasonId: string }; error: string };
    expect(info).toMatchObject({ code: "busy", unit: { titleId: w.show.id, seasonId: w.s1.id } });
    expect(info.error).toMatch(/only copy/);
    expect((await watchPut(req("/", "PUT", info.unit))).status).toBe(200);
    expect((await watchPut(req("/", "PUT", { titleId: w.show.id }))).status).toBe(404); // a show needs its season
    expect((await beatPost(req("/", "POST", { ownerKind: "episode", ownerId: w.ep.id, junk: 1 }))).status).toBe(400);
  });
  it("keeps a viewer's notifications to themselves", async () => {
    const w = await world();
    await saveSettings(db, w.server.id, { enabled: true, claimMode: "review" });
    await submitClaim(db, { titleId: w.movie.id, accountId: w.ann.accountId });
    w.as(w.bo);
    expect((await (await notificationsGet()).json()) as { unread: number }).toMatchObject({ unread: 0, items: [] });
    w.as(w.admin, "admin");
    expect(((await (await notificationsGet()).json()) as { unread: number }).unread).toBe(1);
    h.who = null;
    expect((await notificationsGet()).status).toBe(401);
  });
  it("leaves everything alone while ownership is off", async () => {
    const w = await world();
    await assignOwners(db, { serverId: w.server.id, units: [{ titleId: w.movie.id, seasonId: null }], accountId: w.ann.accountId, via: "assigned" });
    await setShared(db, { titleId: w.movie.id, seasonId: null }, w.ann.accountId, false);
    expect(await ownershipGate({ viewerId: w.bo.viewer.id, accountId: w.bo.accountId }, "title", w.movie.id, { take: true })).toBeNull();
  });
});

describe("profiles", () => {
  it("keeps the fixtures honest", async () => {
    const w = await world();
    expect((await db.select().from(viewers).where(eq(viewers.accountId, w.ann.accountId))).length).toBeGreaterThan(0);
  });
});
