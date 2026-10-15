/** Ownership, claims, playing at once and the waiting list, against a real database. */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";

const h = vi.hoisted(() => ({ testDb: null as unknown as { db: import("@/lib/playlists/test-db").TestDb } }));
vi.mock("@/lib/db/client", async () => {
  const { createTestDb } = await import("@/lib/playlists/test-db");
  h.testDb = await createTestDb();
  return { db: h.testDb.db };
});

import { episodes, notifications, ownershipEvidence, playbackSessions, seasons, serverMembers, titleOwners } from "@/lib/db/schema";
import { makeAccount, makeLibrary, makeServer, makeTitle, type TestDb } from "@/lib/playlists/test-db";
import { addEvidence, assignOwners, decideClaim, openClaims, ownersOf, saveSettings, setShared, submitClaim, unitsOfTitles } from "./owners";
import { listNotifications, markRead, unreadCount } from "./notify";
import { announceFreed, availabilityFor, beat, endPlay, playUnitFor, purgeStale, stopWatching, sweepForWatcher, watchForAvailability } from "./sessions";

let db: TestDb;
beforeAll(async () => {
  await import("@/lib/db/client"); // creates the test database
  db = h.testDb.db;
});

let n = 0;
async function world() {
  const admin = await makeAccount(db, "admin");
  const server = await makeServer(db, admin.accountId);
  const movies = await makeLibrary(db, server.id, "movies", "everyone");
  const shows = await makeLibrary(db, server.id, "shows", "everyone");
  const members: Awaited<ReturnType<typeof makeAccount>>[] = [];
  for (const name of ["ann", "bo", "cy"]) {
    const m = await makeAccount(db, `${name}${++n}`);
    await db.insert(serverMembers).values({ serverId: server.id, profileId: m.accountId, role: "viewer" });
    members.push(m);
  }
  const movie = await makeTitle(db, movies.id, { kind: "movie", boxFolderId: `file:own${++n}` });
  const show = await makeTitle(db, shows.id, { kind: "show", boxFolderId: `file:own${++n}` });
  const [s1] = await db.insert(seasons).values({ titleId: show.id, number: 1, boxFolderId: `own-s1-${n}` }).returning();
  const [s2] = await db.insert(seasons).values({ titleId: show.id, number: 2, boxFolderId: `own-s2-${n}` }).returning();
  const [ep] = await db.insert(episodes).values({ seasonId: s1.id, number: 1, boxFolderId: `own-e-${n}` }).returning();
  return { admin, server, movies, movie, show, s1, s2, ep, ann: members[0], bo: members[1], cy: members[2] };
}
const whole = (titleId: string) => ({ titleId, seasonId: null });
const who = (m: { accountId: string; viewer: { id: string } }) => ({ viewerId: m.viewer.id, accountId: m.accountId });

describe("settings", () => {
  it("start switched off, so nothing changes until the admin turns it on", async () => {
    const w = await world();
    const unit = (await playUnitFor(db, "title", w.movie.id))!;
    expect(await availabilityFor(db, unit, who(w.ann))).toEqual({ ok: true });
    await assignOwners(db, { serverId: w.server.id, units: [whole(w.movie.id)], accountId: w.ann.accountId, via: "assigned" });
    await setShared(db, whole(w.movie.id), w.ann.accountId, false);
    expect(await availabilityFor(db, unit, who(w.bo))).toEqual({ ok: true }); // still off: the withdrawal is ignored
  });
});

describe("assigning owners", () => {
  it("turns a show into its seasons and ignores members of other servers", async () => {
    const w = await world();
    const stranger = await makeAccount(db, `str${++n}`);
    const units = await unitsOfTitles(db, [w.movie.id, w.show.id]);
    expect(units).toHaveLength(3);
    expect(await assignOwners(db, { serverId: w.server.id, units, accountId: stranger.accountId, via: "assigned" })).toEqual([]);
    expect(await assignOwners(db, { serverId: w.server.id, units, accountId: w.ann.accountId, via: "assigned" })).toHaveLength(3);
    expect(await assignOwners(db, { serverId: w.server.id, units, accountId: w.ann.accountId, via: "assigned" })).toHaveLength(0); // twice is once
    expect(await ownersOf(db, { titleId: w.show.id, seasonId: w.s2.id })).toEqual([{ accountId: w.ann.accountId, shared: true }]);
  });
  it("refuses a season given with the wrong show", async () => {
    const w = await world();
    const other = await world();
    expect(await assignOwners(db, { serverId: w.server.id, units: [{ titleId: w.show.id, seasonId: other.s1.id }], accountId: w.ann.accountId, via: "assigned" })).toEqual([]);
  });
});

describe("claiming", () => {
  it("is settled at once when the server says so", async () => {
    const w = await world();
    await saveSettings(db, w.server.id, { enabled: true, claimMode: "instant" });
    expect(await submitClaim(db, { titleId: w.movie.id, accountId: w.ann.accountId })).toEqual({ status: "owned" });
    expect(await ownersOf(db, whole(w.movie.id))).toHaveLength(1);
    expect(await submitClaim(db, { titleId: w.movie.id, accountId: w.ann.accountId })).toEqual({ status: "already_owner" });
  });
  it("needs a season for a show, and the season has to be the show's", async () => {
    const w = await world();
    await saveSettings(db, w.server.id, { enabled: true, claimMode: "instant" });
    expect(await submitClaim(db, { titleId: w.show.id, accountId: w.ann.accountId })).toEqual({ status: "not_found" });
    const other = await world();
    expect(await submitClaim(db, { titleId: w.show.id, seasonId: other.s1.id, accountId: w.ann.accountId })).toEqual({ status: "not_found" });
    expect(await submitClaim(db, { titleId: w.show.id, seasonId: w.s2.id, accountId: w.ann.accountId })).toEqual({ status: "owned" });
    // Owning season 2 says nothing about season 1.
    expect(await ownersOf(db, { titleId: w.show.id, seasonId: w.s1.id })).toEqual([]);
    expect(await submitClaim(db, { titleId: w.show.id, seasonId: w.s1.id, accountId: w.bo.accountId })).toEqual({ status: "owned" });
  });
  it("does nothing while ownership is off, and for strangers", async () => {
    const w = await world();
    expect(await submitClaim(db, { titleId: w.movie.id, accountId: w.ann.accountId })).toEqual({ status: "disabled" });
    await saveSettings(db, w.server.id, { enabled: true });
    const stranger = await makeAccount(db, `str${++n}`);
    expect(await submitClaim(db, { titleId: w.movie.id, accountId: stranger.accountId })).toEqual({ status: "not_found" });
  });
  it("waits for the admin, who is told, and the claimant hears the answer", async () => {
    const w = await world();
    await saveSettings(db, w.server.id, { enabled: true, claimMode: "review" });
    expect(await submitClaim(db, { titleId: w.show.id, seasonId: w.s2.id, accountId: w.ann.accountId })).toEqual({ status: "pending" });
    expect(await submitClaim(db, { titleId: w.show.id, seasonId: w.s2.id, accountId: w.ann.accountId })).toEqual({ status: "already_pending" });
    expect(await ownersOf(db, { titleId: w.show.id, seasonId: w.s2.id })).toEqual([]);
    const adminNotes = await listNotifications(db, w.admin.accountId);
    expect(adminNotes.map((x) => x.message)).toEqual([expect.stringContaining("season 2")]);
    const [claim] = await openClaims(db, w.server.id);
    expect(claim).toMatchObject({ seasonNumber: 2, household: expect.any(String), status: "pending" });
    expect(await decideClaim(db, { serverId: w.server.id, claimId: claim.id, decision: { kind: "approve" } })).toBe(true);
    expect(await ownersOf(db, { titleId: w.show.id, seasonId: w.s2.id })).toHaveLength(1);
    expect((await listNotifications(db, w.ann.accountId))[0].message).toMatch(/You now own .*season 2/);
    expect(await openClaims(db, w.server.id)).toEqual([]);
    expect(await decideClaim(db, { serverId: w.server.id, claimId: claim.id, decision: { kind: "approve" } })).toBe(false); // already decided
  });
  it("can be turned down with a reason, and tried again later", async () => {
    const w = await world();
    await saveSettings(db, w.server.id, { enabled: true, claimMode: "review" });
    await submitClaim(db, { titleId: w.movie.id, accountId: w.bo.accountId });
    const [claim] = await openClaims(db, w.server.id);
    await decideClaim(db, { serverId: w.server.id, claimId: claim.id, decision: { kind: "reject", note: "Not on the shelf" } });
    expect((await listNotifications(db, w.bo.accountId))[0].message).toContain("Not on the shelf");
    expect(await ownersOf(db, whole(w.movie.id))).toEqual([]);
    expect(await submitClaim(db, { titleId: w.movie.id, accountId: w.bo.accountId })).toEqual({ status: "pending" });
  });
  it("only the admin of that server can decide a claim", async () => {
    const w = await world();
    const other = await world();
    await saveSettings(db, w.server.id, { enabled: true, claimMode: "review" });
    await submitClaim(db, { titleId: w.movie.id, accountId: w.ann.accountId });
    const [claim] = await openClaims(db, w.server.id);
    expect(await decideClaim(db, { serverId: other.server.id, claimId: claim.id, decision: { kind: "approve" } })).toBe(false);
  });
  it("asks for evidence, takes pictures only then, and drops them once decided", async () => {
    const w = await world();
    await saveSettings(db, w.server.id, { enabled: true, claimMode: "review" });
    await submitClaim(db, { titleId: w.movie.id, accountId: w.ann.accountId });
    const [claim] = await openClaims(db, w.server.id);
    const pic = { claimId: claim.id, accountId: w.ann.accountId, contentType: "image/jpeg", dataBase64: "AAAA" };
    expect(await addEvidence(db, pic)).toBe("not_requested");
    await decideClaim(db, { serverId: w.server.id, claimId: claim.id, decision: { kind: "evidence", note: "A photo of the case, please" } });
    expect((await listNotifications(db, w.ann.accountId))[0]).toMatchObject({ kind: "evidence_requested" });
    expect(await addEvidence(db, { ...pic, contentType: "text/html" })).toBe("bad_picture");
    expect(await addEvidence(db, { ...pic, dataBase64: "not base64!" })).toBe("bad_picture");
    expect(await addEvidence(db, { ...pic, accountId: w.bo.accountId })).toBe("not_requested"); // someone else's claim
    expect(await addEvidence(db, pic)).toBe("ok");
    expect(await addEvidence(db, pic)).toBe("ok");
    expect(await addEvidence(db, pic)).toBe("ok");
    expect(await addEvidence(db, pic)).toBe("too_many");
    const [waiting] = await openClaims(db, w.server.id);
    expect(waiting.status).toBe("evidence_submitted");
    expect(waiting.pictures).toHaveLength(3);
    expect((await listNotifications(db, w.admin.accountId)).some((x) => x.message.startsWith("Evidence arrived"))).toBe(true);
    await decideClaim(db, { serverId: w.server.id, claimId: claim.id, decision: { kind: "approve" } });
    expect(await db.select().from(ownershipEvidence)).toEqual([]);
  });
});

describe("withdrawing and sharing", () => {
  it("blocks others once every copy is withdrawn, until shared again; the owner still plays", async () => {
    const w = await world();
    await saveSettings(db, w.server.id, { enabled: true });
    await assignOwners(db, { serverId: w.server.id, units: [whole(w.movie.id)], accountId: w.ann.accountId, via: "assigned" });
    const unit = (await playUnitFor(db, "title", w.movie.id))!;
    expect(await setShared(db, whole(w.movie.id), w.bo.accountId, false)).toBe(false); // bo owns nothing
    await setShared(db, whole(w.movie.id), w.ann.accountId, false);
    expect(await availabilityFor(db, unit, who(w.bo))).toEqual({ ok: false, code: "withdrawn" });
    expect(await availabilityFor(db, unit, who(w.ann))).toEqual({ ok: true });
    await setShared(db, whole(w.movie.id), w.ann.accountId, true);
    expect(await availabilityFor(db, unit, who(w.bo))).toEqual({ ok: true });
  });
  it("withdrawing one season leaves the others", async () => {
    const w = await world();
    await saveSettings(db, w.server.id, { enabled: true });
    await assignOwners(db, { serverId: w.server.id, units: await unitsOfTitles(db, [w.show.id]), accountId: w.ann.accountId, via: "assigned" });
    await setShared(db, { titleId: w.show.id, seasonId: w.s2.id }, w.ann.accountId, false);
    const epUnit = (await playUnitFor(db, "episode", w.ep.id))!;
    expect(epUnit.seasonId).toBe(w.s1.id);
    expect(await availabilityFor(db, epUnit, who(w.bo))).toEqual({ ok: true });
  });
});

describe("playing at once", () => {
  async function limitedMovie(copies: number) {
    const w = await world();
    await saveSettings(db, w.server.id, { enabled: true, limitConcurrent: true, limitKinds: ["movies", "shows"] });
    const owners = [w.ann, w.bo].slice(0, copies);
    for (const o of owners) await assignOwners(db, { serverId: w.server.id, units: [whole(w.movie.id)], accountId: o.accountId, via: "assigned" });
    return { w, unit: (await playUnitFor(db, "title", w.movie.id))! };
  }
  it("lets as many play as there are copies, and tells the next to wait", async () => {
    const { w, unit } = await limitedMovie(2);
    expect(await beat(db, unit, who(w.admin), false)).toEqual({ ok: true });
    expect(await beat(db, unit, who(w.ann), false)).toEqual({ ok: true });
    expect(await beat(db, unit, who(w.cy), false)).toEqual({ ok: false, code: "busy", copies: 2, inUse: 2 });
    expect(await beat(db, unit, who(w.admin), false)).toEqual({ ok: true }); // a heartbeat from someone playing never locks them out
  });
  it("counts a viewer once however many devices, and one thing at a time", async () => {
    const { w, unit } = await limitedMovie(1);
    await beat(db, unit, who(w.admin), false);
    await beat(db, unit, who(w.admin), false);
    expect(await db.select().from(playbackSessions).where(eq(playbackSessions.viewerId, w.admin.viewer.id))).toHaveLength(1);
    const other = (await playUnitFor(db, "title", (await makeTitle(db, w.movies.id, { kind: "movie", boxFolderId: `file:own${++n}` })).id))!;
    await beat(db, other, who(w.admin), false);
    expect(await db.select().from(playbackSessions).where(eq(playbackSessions.viewerId, w.admin.viewer.id))).toHaveLength(1);
    expect(await beat(db, unit, who(w.cy), false)).toEqual({ ok: true }); // the copy was let go when they moved on
  });
  it("frees the copy when the player stops, goes quiet, or has been paused too long", async () => {
    const { w, unit } = await limitedMovie(1);
    const t0 = new Date("2026-10-20T12:00:00Z");
    await beat(db, unit, who(w.admin), false, t0);
    expect((await beat(db, unit, who(w.cy), false, new Date(t0.getTime() + 30_000))).ok).toBe(false);
    expect((await beat(db, unit, who(w.cy), false, new Date(t0.getTime() + 100_000))).ok).toBe(true); // admin went quiet
    await endPlay(db, w.cy.viewer.id);
    await beat(db, unit, who(w.admin), true, t0); // paused
    expect((await beat(db, unit, who(w.cy), false, new Date(t0.getTime() + 5 * 60_000))).ok).toBe(false);
    expect((await beat(db, unit, who(w.cy), false, new Date(t0.getTime() + 11 * 60_000))).ok).toBe(true);
  });
  it("is per season for a show: other seasons play at the same time", async () => {
    const w = await world();
    await saveSettings(db, w.server.id, { enabled: true, limitConcurrent: true });
    await assignOwners(db, { serverId: w.server.id, units: await unitsOfTitles(db, [w.show.id]), accountId: w.ann.accountId, via: "assigned" });
    const s1 = (await playUnitFor(db, "episode", w.ep.id))!;
    const [ep2] = await db.insert(episodes).values({ seasonId: w.s2.id, number: 1, boxFolderId: `own-e2-${++n}` }).returning();
    const s2 = (await playUnitFor(db, "episode", ep2.id))!;
    expect(await beat(db, s1, who(w.bo), false)).toEqual({ ok: true });
    expect((await beat(db, s1, who(w.cy), false)).ok).toBe(false);
    expect((await beat(db, s2, who(w.cy), false)).ok).toBe(true);
  });
  it("doesn't count an owner playing their own withdrawn copy", async () => {
    const { w, unit } = await limitedMovie(2);
    await setShared(db, whole(w.movie.id), w.ann.accountId, false);
    await beat(db, unit, who(w.ann), false); // ann's own copy: takes no shared place (the limit is now one)
    expect(await beat(db, unit, who(w.bo), false)).toEqual({ ok: true });
    expect((await beat(db, unit, who(w.cy), false)).ok).toBe(false);
  });
  it("leaves kinds the server didn't choose, and unowned titles, unlimited", async () => {
    const w = await world();
    await saveSettings(db, w.server.id, { enabled: true, limitConcurrent: true, limitKinds: ["shows"] });
    await assignOwners(db, { serverId: w.server.id, units: [whole(w.movie.id)], accountId: w.ann.accountId, via: "assigned" });
    const unit = (await playUnitFor(db, "title", w.movie.id))!;
    for (const m of [w.admin, w.ann, w.bo, w.cy]) expect(await beat(db, unit, who(m), false)).toEqual({ ok: true });
    expect(await db.select().from(playbackSessions)).toEqual(expect.not.arrayContaining([expect.objectContaining({ titleId: w.movie.id })]));
  });
  it("tells those waiting when a copy frees up, once, and the bell counts and clears", async () => {
    const { w, unit } = await limitedMovie(1);
    await beat(db, unit, who(w.admin), false);
    expect((await beat(db, unit, who(w.cy), false)).ok).toBe(false);
    await watchForAvailability(db, unit, who(w.cy));
    await watchForAvailability(db, unit, who(w.cy)); // twice is once
    expect(await announceFreed(db, unit)).toBe(0); // still taken
    await endPlay(db, w.admin.viewer.id);
    expect(await unreadCount(db, w.cy.accountId)).toBe(1);
    expect((await listNotifications(db, w.cy.accountId))[0]).toMatchObject({ kind: "available", href: `/s/${w.server.id}/title/${w.movie.id}` });
    await endPlay(db, w.admin.viewer.id);
    expect(await unreadCount(db, w.cy.accountId)).toBe(1); // not told again
    await markRead(db, w.cy.accountId);
    expect(await unreadCount(db, w.cy.accountId)).toBe(0);
  });
  it("can stop waiting", async () => {
    const { w, unit } = await limitedMovie(1);
    await beat(db, unit, who(w.admin), false);
    await watchForAvailability(db, unit, who(w.cy));
    await stopWatching(db, unit, w.cy.viewer.id);
    await endPlay(db, w.admin.viewer.id);
    expect(await unreadCount(db, w.cy.accountId)).toBe(0);
  });
  it("lets go of quiet players, and tells the waiting, when swept", async () => {
    const { w, unit } = await limitedMovie(1);
    const t0 = new Date("2026-10-20T12:00:00Z");
    await beat(db, unit, who(w.admin), false, t0);
    await watchForAvailability(db, unit, who(w.cy));
    await purgeStale(db, new Date(t0.getTime() + 30_000));
    expect(await unreadCount(db, w.cy.accountId)).toBe(0); // still playing
    expect(await purgeStale(db, new Date(t0.getTime() + 120_000))).toBeGreaterThanOrEqual(1);
    expect(await unreadCount(db, w.cy.accountId)).toBe(1);
  });
  it("tells a waiting viewer when the player they wait on went quiet, with no one else's page open", async () => {
    const { w, unit } = await limitedMovie(1);
    const t0 = new Date("2026-10-20T12:00:00Z");
    await beat(db, unit, who(w.admin), false, t0);
    await watchForAvailability(db, unit, who(w.cy));
    await sweepForWatcher(db, w.cy.accountId, new Date(t0.getTime() + 30_000));
    expect(await unreadCount(db, w.cy.accountId)).toBe(0);
    await sweepForWatcher(db, w.cy.accountId, new Date(t0.getTime() + 200_000));
    expect(await unreadCount(db, w.cy.accountId)).toBe(1);
    // Someone else's quiet player is left for their own turn.
    expect(await purgeStale(db, new Date(t0.getTime() + 200_000), [])).toBe(0);
  });
  it("keeps notifications private to their account", async () => {
    const w = await world();
    await saveSettings(db, w.server.id, { enabled: true, claimMode: "review" });
    await submitClaim(db, { titleId: w.movie.id, accountId: w.ann.accountId });
    expect(await listNotifications(db, w.bo.accountId)).toEqual([]);
    await markRead(db, w.bo.accountId);
    expect(await unreadCount(db, w.admin.accountId)).toBe(1);
    expect(await db.select().from(notifications).where(and(eq(notifications.accountId, w.admin.accountId)))).toHaveLength(1);
  });
});

describe("deleting what is owned", () => {
  it("removes owners and claims with the title", async () => {
    const w = await world();
    await assignOwners(db, { serverId: w.server.id, units: [whole(w.movie.id)], accountId: w.ann.accountId, via: "assigned" });
    await db.delete((await import("@/lib/db/schema")).titles).where(eq((await import("@/lib/db/schema")).titles.id, w.movie.id));
    expect(await db.select().from(titleOwners).where(eq(titleOwners.titleId, w.movie.id))).toEqual([]);
  });
});
