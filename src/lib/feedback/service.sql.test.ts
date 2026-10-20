/** Reports and requests: who can send and see what, voting, comments, triage, and keeping a GitHub issue in step. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { feedbackItems } from "@/lib/db/schema";
import { createTestDb, makeAccount, type TestDb } from "@/lib/playlists/test-db";
import { addComment, deleteComment, deleteItem, getItem, listBoard, listInbox, listMine, setVote, similarRequests, submitFeedback, syncGithub, triage, type Who } from "./service";

let db: TestDb;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ db, close } = await createTestDb());
}, 60_000);
afterAll(async () => {
  await close();
});

const person = async (name: string): Promise<Who> => ({ accountId: (await makeAccount(db, name)).accountId, operator: false });
const operator = async (): Promise<Who> => ({ accountId: (await makeAccount(db, "op")).accountId, operator: true });
const send = async (who: Who, over: Record<string, unknown> = {}) => {
  const r = await submitFeedback(db, { authorId: who.accountId, serverId: null, kind: "feature", title: "Dark mode please", body: "I would love a darker theme for the player.", ...over });
  if (!r.ok) throw new Error(r.error);
  return r.value.id;
};

describe("sending a report", () => {
  it("needs a kind, a title and some words, and cleans what is typed", async () => {
    const a = await person("a");
    const bad = (over: Record<string, unknown>) => submitFeedback(db, { authorId: a.accountId, serverId: null, kind: "bug", title: "A real title", body: "Something happened here.", ...over });
    expect(await bad({ kind: "chore" })).toMatchObject({ ok: false, status: 400 });
    expect(await bad({ title: "ab" })).toMatchObject({ ok: false });
    expect(await bad({ body: "short" })).toMatchObject({ ok: false });
    const ok = await submitFeedback(db, { authorId: a.accountId, serverId: null, kind: "bug", title: "  Player\u0000   stalls  ", body: "Line one\r\n\r\n\r\n\r\nLine two", diagnostics: { path: "/s/6f1c2d3e-aaaa-4bbb-8ccc-1234567890ab/watch", secret: "x" } });
    expect(ok.ok).toBe(true);
    const [row] = await db.select().from(feedbackItems).where(eq(feedbackItems.authorId, a.accountId)).orderBy(feedbackItems.createdAt);
    expect(row).toMatchObject({ title: "Player stalls", body: "Line one\n\nLine two", visibility: "private" });
    expect(row.diagnostics).toEqual({ path: "/s/:id/watch" });
  });
  it("puts a feature request on the board with its author's vote, and keeps it off when asked, and a bug is private", async () => {
    const a = await person("a2");
    const reader = await person("r2");
    const pub = await send(a);
    const hidden = await send(a, { title: "A private idea", keepPrivate: true });
    const bug = await send(a, { kind: "bug", title: "A bug of mine" });
    const board = await listBoard(db, reader);
    expect(board.map((i) => i.id)).toContain(pub);
    expect(board.map((i) => i.id)).not.toContain(hidden);
    expect(board.map((i) => i.id)).not.toContain(bug);
    expect(board.find((i) => i.id === pub)).toMatchObject({ votes: 1, iVoted: false, mine: false, kind: "feature" });
    expect((await listBoard(db, a)).find((i) => i.id === pub)).toMatchObject({ iVoted: true, mine: true });
  });
});

describe("who sees what", () => {
  it("a private report is seen by its author and the platform admin, and nobody else, not even by id", async () => {
    const a = await person("a3");
    const other = await person("o3");
    const op = await operator();
    const id = await send(a, { kind: "bug", title: "My private bug" });
    expect((await getItem(db, a, id))?.item.title).toBe("My private bug");
    expect(await getItem(db, other, id)).toBeNull();
    expect((await getItem(db, op, id))?.item.operator?.authorEmail).toMatch(/@/);
    expect((await listMine(db, a)).map((i) => i.id)).toContain(id);
    expect((await listMine(db, other)).map((i) => i.id)).not.toContain(id);
    expect((await listInbox(db, op)).map((i) => i.id)).toContain(id);
  });
  it("the author's identity and the technical details are only ever shown to the platform admin", async () => {
    const a = await person("a4");
    const reader = await person("r4");
    const id = await send(a, { diagnostics: { path: "/library", userAgent: "Safari" } });
    const seenByReader = await getItem(db, reader, id);
    expect(seenByReader?.item.operator).toBeUndefined();
    expect(JSON.stringify(seenByReader)).not.toContain("Safari");
    expect(JSON.stringify(seenByReader)).not.toContain(a.accountId);
    const seenByAuthor = await getItem(db, a, id);
    expect(seenByAuthor?.item.operator).toBeUndefined();
  });
  it("the admin can publish a bug, and then others can see and vote on it", async () => {
    const a = await person("a5");
    const reader = await person("r5");
    const id = await send(a, { kind: "bug", title: "A bug for all" });
    expect(await setVote(db, reader, id, true)).toMatchObject({ ok: false, status: 404 });
    expect(await triage(db, id, { visibility: "public" })).toMatchObject({ ok: true });
    expect((await listBoard(db, reader, { kind: "bug" })).map((i) => i.id)).toContain(id);
    expect(await setVote(db, reader, id, true)).toEqual({ ok: true, value: { votes: 1 } });
  });
});

describe("voting and comments", () => {
  it("one vote each, taken back again, most voted first, with finished ones after the open ones", async () => {
    const a = await person("a6");
    const b = await person("b6");
    const c = await person("c6");
    const low = await send(a, { title: "Low interest idea" });
    const high = await send(a, { title: "High interest idea" });
    const done = await send(a, { title: "Already done idea" });
    await setVote(db, b, high, true);
    await setVote(db, b, high, true); // again: still one
    await setVote(db, c, high, true);
    await setVote(db, b, done, true);
    await setVote(db, c, done, true);
    await setVote(db, c, done, false);
    await triage(db, done, { status: "done" });
    const order = (await listBoard(db, a)).map((i) => i.id).filter((id) => [low, high, done].includes(id));
    expect(order).toEqual([high, low, done]);
    expect((await listBoard(db, a)).find((i) => i.id === high)?.votes).toBe(3);
    expect((await listBoard(db, a, { status: "open" })).map((i) => i.id)).not.toContain(done);
    expect((await listBoard(db, a, { q: "interest" })).map((i) => i.id).sort()).toEqual([high, low].sort());
    expect(await setVote(db, a, "00000000-0000-4000-8000-000000000000", true)).toMatchObject({ ok: false });
  });
  it("comments go on public items (anyone) and on your own, the admin's are official, and a private item takes no strangers' comments", async () => {
    const a = await person("a7");
    const stranger = await person("s7");
    const op = await operator();
    const open = await send(a);
    const hidden = await send(a, { kind: "bug", title: "Hidden bug" });
    expect(await addComment(db, stranger, open, "  Me too!  ")).toMatchObject({ ok: true, value: { body: "Me too!", official: false, mine: true } });
    expect(await addComment(db, stranger, hidden, "Hi")).toMatchObject({ ok: false, status: 404 });
    expect(await addComment(db, a, hidden, "More detail")).toMatchObject({ ok: true });
    expect(await addComment(db, a, hidden, "   ")).toMatchObject({ ok: false, status: 400 });
    expect(await addComment(db, op, hidden, "We are on it")).toMatchObject({ ok: true, value: { official: true } });
    const thread = await getItem(db, a, hidden);
    expect(thread?.comments.map((c) => [c.body, c.official, c.mine])).toEqual([["More detail", false, true], ["We are on it", true, false]]);
    expect((await getItem(db, stranger, open))?.item.comments).toBe(1);
  });
});

describe("the platform admin's triage", () => {
  it("sets status and visibility, refuses nonsense, marks duplicates, and deletes", async () => {
    const a = await person("a8");
    const op = await operator();
    const first = await send(a, { title: "The original idea" });
    const second = await send(a, { title: "The same idea again" });
    expect(await triage(db, first, { status: "planned" })).toEqual({ ok: true, value: { status: "planned" } });
    expect(await triage(db, first, { status: "bogus" })).toMatchObject({ ok: false, status: 400 });
    expect(await triage(db, first, { visibility: "secret" })).toMatchObject({ ok: false });
    expect(await triage(db, second, { duplicateOf: first })).toEqual({ ok: true, value: { status: "duplicate" } });
    expect(await triage(db, second, { duplicateOf: second })).toMatchObject({ ok: false });
    expect((await getItem(db, op, second))?.item).toMatchObject({ status: "duplicate", duplicateOf: first });
    expect(await triage(db, "00000000-0000-4000-8000-000000000000", { status: "done" })).toMatchObject({ ok: false, status: 404 });
    const comment = await addComment(db, a, first, "A comment");
    if (!comment.ok) throw new Error("no comment");
    expect(await deleteComment(db, first, comment.value.id)).toBe(true);
    expect(await deleteItem(db, second)).toBe(true);
    expect(await getItem(db, op, second)).toBeNull();
  });
});

describe("finding what was already asked", () => {
  it("suggests public requests that share words, and never a private one", async () => {
    const a = await person("a9");
    const reader = await person("r9");
    const found = await send(a, { title: "Sleep timer for audiobooks", body: "Stop playing after a while." });
    await send(a, { title: "Sleep timer secret", keepPrivate: true });
    const r = await similarRequests(db, reader, "a sleep timer would be great", "feature");
    expect(r.map((i) => i.id)).toContain(found);
    expect(r.some((i) => i.title.includes("secret"))).toBe(false);
    expect(await similarRequests(db, reader, "ab cd", "feature")).toEqual([]);
  });
});

describe("keeping a GitHub issue in step", () => {
  const cfg = { token: "t", repo: "me/roam" };
  const fake = () => {
    const calls: { method: string; url: string; body: unknown }[] = [];
    const impl = (async (url: string, init: RequestInit) => {
      calls.push({ method: init.method ?? "GET", url, body: init.body ? JSON.parse(String(init.body)) : null });
      return new Response(JSON.stringify(init.method === "POST" ? { number: 7, html_url: "https://github.com/me/roam/issues/7" } : {}), { status: 200 });
    }) as unknown as typeof fetch;
    return { calls, impl };
  };
  it("files an issue once, then closes and reopens it as the status changes, and keeps a failure for the admin to see", async () => {
    const a = await person("a10");
    const id = await send(a, { diagnostics: { path: "/library" } });
    const g = fake();
    expect(await syncGithub(db, id, cfg, g.impl)).toEqual({ ok: true });
    expect(g.calls).toHaveLength(1);
    expect(JSON.stringify(g.calls[0].body)).not.toContain(a.accountId);
    expect((await db.select().from(feedbackItems).where(eq(feedbackItems.id, id)))[0]).toMatchObject({ githubIssueNumber: 7, githubIssueUrl: "https://github.com/me/roam/issues/7" });
    await triage(db, id, { status: "done" });
    await syncGithub(db, id, cfg, g.impl);
    expect(g.calls[1]).toMatchObject({ method: "PATCH", url: "https://api.github.com/repos/me/roam/issues/7", body: { state: "closed", state_reason: "completed" } });
    await triage(db, id, { status: "planned" });
    await syncGithub(db, id, cfg, g.impl);
    expect(g.calls[2].body).toEqual({ state: "open" });

    const other = await send(a, { title: "Another idea here" });
    const down = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
    expect(await syncGithub(db, other, cfg, down)).toMatchObject({ ok: false });
    expect((await db.select().from(feedbackItems).where(eq(feedbackItems.id, other)))[0].githubError).toContain("500");
    expect((await db.select().from(feedbackItems).where(eq(feedbackItems.id, other)))[0].githubIssueNumber).toBeNull();
  });
});
