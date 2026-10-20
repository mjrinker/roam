/** Feedback over HTTP: who may send, see, vote, comment and triage, and the GitHub issue that follows. */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

const h = vi.hoisted(() => ({ testDb: null as unknown as { db: import("@/lib/playlists/test-db").TestDb }, resolution: null as unknown, limited: false }));
vi.mock("@/lib/db/client", async () => {
  const { createTestDb } = await import("@/lib/playlists/test-db");
  h.testDb = await createTestDb();
  return { db: h.testDb.db };
});
vi.mock("@/lib/auth/viewer", () => ({ getCurrentViewer: async () => h.resolution }));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: async () => !h.limited }));

import { feedbackItems, profiles, viewers } from "@/lib/db/schema";
import { makeAccount, makeServer, type TestDb } from "@/lib/playlists/test-db";
import { GET as list, POST as submit } from "./route";
import { GET as getOne, PATCH as triage, DELETE as remove } from "./[id]/route";
import { PUT as vote, DELETE as unvote } from "./[id]/vote/route";
import { POST as comment } from "./[id]/comments/route";
import { DELETE as removeComment } from "./[id]/comments/[commentId]/route";
import { POST as resync } from "./[id]/github/route";
import { GET as configRoute } from "./config/route";
import { GET as similar } from "./similar/route";

let db: TestDb;
beforeAll(() => {
  db = h.testDb.db;
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  h.limited = false;
});

async function signInAs(accountId: string, opts: { operator?: boolean; role?: "limited" } = {}) {
  if (opts.operator) await db.update(profiles).set({ isPlatformAdmin: true }).where(eq(profiles.id, accountId));
  if (opts.role) await db.update(viewers).set({ role: opts.role }).where(eq(viewers.accountId, accountId));
  const [account] = await db.select().from(profiles).where(eq(profiles.id, accountId));
  const all = await db.select().from(viewers).where(eq(viewers.accountId, accountId));
  h.resolution = { account, viewer: all[0], viewers: all };
}
const post = (body: unknown, method = "POST") => new Request("http://x", { method, body: JSON.stringify(body), headers: { "content-type": "application/json" } });
const ctx = (params: Record<string, string>) => ({ params: Promise.resolve(params) }) as never;
const make = async (name: string) => (await makeAccount(db, name)).accountId;
const report = { kind: "feature", title: "Dark mode please", body: "I would love a darker theme for the player." };

describe("sending", () => {
  it("answers 401 signed out, 403 for a limited profile, and 429 over the daily limit", async () => {
    h.resolution = null;
    expect((await submit(post(report))).status).toBe(401);
    expect((await list(new Request("http://x"))).status).toBe(401);
    const kid = await make("kid");
    await signInAs(kid, { role: "limited" });
    expect((await submit(post(report))).status).toBe(403);
    expect((await list(new Request("http://x"))).status).toBe(200); // the board can be read
    const a = await make("a");
    await signInAs(a);
    h.limited = true;
    expect((await submit(post(report))).status).toBe(429);
  });

  it("files a feature request as public and a bug as private, with only the details it knows and the server it was sent from", async () => {
    const a = await make("a1");
    const server = await makeServer(db, a);
    const outsider = await makeServer(db, await make("owner2"));
    await signInAs(a);
    const feature = await (await submit(post({ ...report, serverId: server.id, diagnostics: { path: "/s/6f1c2d3e-aaaa-4bbb-8ccc-1234567890ab/x", evil: "no" } }))).json();
    expect(feature.visibility).toBe("public");
    const bug = await submit(post({ kind: "bug", title: "It stops", body: "It stops at the next part.", serverId: outsider.id }));
    expect(bug.status).toBe(201);
    const bugId = (await bug.json()).id;
    const [fRow] = await db.select().from(feedbackItems).where(eq(feedbackItems.id, feature.id));
    expect(fRow).toMatchObject({ serverId: server.id, diagnostics: { path: "/s/:id/x" } });
    // A server the account isn't in is not recorded.
    expect((await db.select().from(feedbackItems).where(eq(feedbackItems.id, bugId)))[0]).toMatchObject({ serverId: null, visibility: "private" });
    expect((await submit(post({ kind: "bug", title: "x", body: "y" }))).status).toBe(400);
    expect((await submit(new Request("http://x", { method: "POST", body: "nope" }))).status).toBe(400);
  });
});

describe("seeing, voting and commenting", () => {
  it("the board shows public items, your own list shows everything of yours, and a private item is a plain 404 to others", async () => {
    const a = await make("a2");
    const b = await make("b2");
    await signInAs(a);
    const pub = (await (await submit(post({ ...report, title: "Public idea here" }))).json()).id;
    const priv = (await (await submit(post({ kind: "bug", title: "Private bug here", body: "Something private happened." }))).json()).id;
    await signInAs(b);
    const board = (await (await list(new Request("http://x/api/feedback?view=board"))).json()).items as { id: string }[];
    expect(board.map((i) => i.id)).toContain(pub);
    expect(board.map((i) => i.id)).not.toContain(priv);
    expect((await getOne(new Request("http://x"), ctx({ id: priv }))).status).toBe(404);
    expect((await getOne(new Request("http://x"), ctx({ id: "nope" }))).status).toBe(404);
    expect((await comment(post({ body: "hi" }), ctx({ id: priv }))).status).toBe(404);
    expect((await vote(new Request("http://x", { method: "PUT" }), ctx({ id: priv }))).status).toBe(404);
    await signInAs(a);
    const mine = (await (await list(new Request("http://x/api/feedback?view=mine"))).json()).items as { id: string }[];
    expect(mine.map((i) => i.id)).toEqual(expect.arrayContaining([pub, priv]));
  });

  it("votes once and takes it back, comments on a public item, and the author is not named", async () => {
    const a = await make("a3");
    const b = await make("b3");
    await signInAs(a);
    const id = (await (await submit(post({ ...report, title: "Votable idea here" }))).json()).id;
    await signInAs(b);
    expect(await (await vote(new Request("http://x", { method: "PUT" }), ctx({ id }))).json()).toEqual({ votes: 2 });
    expect(await (await vote(new Request("http://x", { method: "PUT" }), ctx({ id }))).json()).toEqual({ votes: 2 });
    expect(await (await unvote(new Request("http://x", { method: "DELETE" }), ctx({ id }))).json()).toEqual({ votes: 1 });
    const c = await comment(post({ body: "Me too" }), ctx({ id }));
    expect(c.status).toBe(201);
    const thread = await (await getOne(new Request("http://x"), ctx({ id }))).json();
    expect(thread.comments).toHaveLength(1);
    expect(JSON.stringify(thread)).not.toContain(a);
    expect(JSON.stringify(thread)).not.toContain("@");
    expect((await comment(post({ body: "   " }), ctx({ id }))).status).toBe(400);
  });
});

describe("the platform admin", () => {
  it("is the only one who can triage, delete, reply officially or see who sent it, and everyone else gets a plain 404", async () => {
    const a = await make("a4");
    const op = await make("op4");
    await signInAs(a);
    const id = (await (await submit(post({ kind: "bug", title: "Triage this bug", body: "Something broke for me.", diagnostics: { userAgent: "Safari" } }))).json()).id;
    expect((await triage(post({ status: "planned" }, "PATCH"), ctx({ id }))).status).toBe(404);
    expect((await remove(new Request("http://x", { method: "DELETE" }), ctx({ id }))).status).toBe(404);
    expect((await resync(new Request("http://x", { method: "POST" }), ctx({ id }))).status).toBe(404);
    await signInAs(op, { operator: true });
    const seen = await (await getOne(new Request("http://x"), ctx({ id }))).json();
    expect(seen.item.operator).toMatchObject({ diagnostics: { userAgent: "Safari" } });
    expect(seen.item.operator.authorEmail).toMatch(/@/);
    expect((await triage(post({ status: "bogus" }, "PATCH"), ctx({ id }))).status).toBe(400);
    expect((await triage(post({ status: "in_progress", visibility: "public", extra: 1 }, "PATCH"), ctx({ id }))).status).toBe(400); // only what is allowed
    expect(await (await triage(post({ status: "in_progress", visibility: "public" }, "PATCH"), ctx({ id }))).json()).toEqual({ ok: true, status: "in_progress" });
    const reply = await (await comment(post({ body: "We're on it" }), ctx({ id }))).json();
    expect(reply.official).toBe(true);
    await signInAs(a);
    expect((await (await getOne(new Request("http://x"), ctx({ id }))).json()).comments[0].official).toBe(true);
    await signInAs(op, { operator: true });
    expect((await removeComment(new Request("http://x", { method: "DELETE" }), ctx({ id, commentId: reply.id }))).status).toBe(200);
    expect((await remove(new Request("http://x", { method: "DELETE" }), ctx({ id }))).status).toBe(200);
    expect((await getOne(new Request("http://x"), ctx({ id }))).status).toBe(404);
  });
});

describe("GitHub", () => {
  it("is off without a token, says what the form must say when it is on, and files an issue with nothing that names the author", async () => {
    const a = await make("a5");
    await signInAs(a);
    expect(await (await configRoute()).json()).toEqual({ github: { enabled: false, public: false } });
    const calls: { url: string; method: string; body: string }[] = [];
    vi.stubEnv("GITHUB_FEEDBACK_TOKEN", "tok");
    vi.stubEnv("GITHUB_FEEDBACK_REPO", "me/roam");
    vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
      calls.push({ url, method: init.method ?? "GET", body: String(init.body ?? "") });
      return new Response(JSON.stringify(init.method === "POST" ? { number: 3, html_url: "https://github.com/me/roam/issues/3" } : { private: true }), { status: 200 });
    });
    const { forgetRepoVisibility } = await import("@/lib/feedback/github");
    forgetRepoVisibility();
    expect(await (await configRoute()).json()).toEqual({ github: { enabled: true, public: false } });
    const sent = await (await submit(post({ kind: "feature", title: "Needs github please", body: "Please file this on GitHub." }))).json();
    await vi.waitFor(async () => expect((await db.select().from(feedbackItems).where(eq(feedbackItems.id, sent.id)))[0].githubIssueNumber).toBe(3));
    const issue = calls.find((c) => c.method === "POST")!;
    expect(issue.url).toBe("https://api.github.com/repos/me/roam/issues");
    expect(issue.body).toContain("Please file this on GitHub.");
    expect(issue.body).not.toContain(a);
    expect(issue.body).not.toMatch(/@\w/);
    forgetRepoVisibility();
  });

  it("the admin's retry says plainly when GitHub isn't set up", async () => {
    const a = await make("a6");
    const op = await make("op6");
    await signInAs(a);
    const id = (await (await submit(post(report))).json()).id;
    await signInAs(op, { operator: true });
    expect((await resync(new Request("http://x", { method: "POST" }), ctx({ id }))).status).toBe(409);
  });
});

describe("finding what was already asked", () => {
  it("lists public requests with words in common", async () => {
    const a = await make("a7");
    await signInAs(a);
    await submit(post({ kind: "feature", title: "Sleep timer for audiobooks", body: "Stop the book after a while." }));
    await submit(post({ kind: "feature", title: "Sleep timer that is private", body: "Only for me.", keepPrivate: true }));
    const items = (await (await similar(new Request("http://x/api/feedback/similar?q=sleep+timer&kind=feature"))).json()).items as { title: string }[];
    expect(items.map((i) => i.title)).toContain("Sleep timer for audiobooks");
    expect(items.map((i) => i.title)).not.toContain("Sleep timer that is private");
  });
});
