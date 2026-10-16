/** Shuffling a playlist: a random order that is the same all the way through, and that visits every item once. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { nextAfter, queueNext, validShuffle } from "./next";
import { addItem, addEpisodeFile, createTestDb, makeAccount, makeLibrary, makePlaylist, makeServer, makeShow, makeTitle, type TestDb } from "./test-db";

let db: TestDb;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ db, close } = await createTestDb());
}, 60_000);
afterAll(async () => {
  await close();
});

async function world(count = 8) {
  const owner = await makeAccount(db, "shuffler");
  const server = await makeServer(db, owner.accountId);
  const library = await makeLibrary(db, server.id);
  const playlist = await makePlaylist(db, { serverId: server.id, ownerViewerId: owner.viewer.id });
  const items: { id: string; name: string }[] = [];
  for (let i = 0; i < count; i++) {
    const t = await makeTitle(db, library.id, { name: `Film ${i}` });
    items.push({ id: (await addItem(db, playlist.id, { titleId: t.id }, (i + 1) * 1024)).id, name: t.name });
  }
  const walk = async (seed?: string) => {
    const order: string[] = [];
    let after: string | undefined;
    for (let guard = 0; guard < 50; guard++) {
      const r = await nextAfter(db, { playlistId: playlist.id, viewerId: owner.viewer.id, afterItemId: after, shuffle: seed });
      if (!r.ok || !r.value) break;
      order.push(r.value.itemId);
      after = r.value.itemId;
    }
    return order;
  };
  return { owner, server, playlist, items, walk };
}

describe("a shuffled queue", () => {
  it("visits every item exactly once, in an order that is not the playlist's, and the same order every time for the same seed", async () => {
    const w = await world();
    const inOrder = await w.walk();
    expect(inOrder).toEqual(w.items.map((i) => i.id));
    const a = await w.walk("seedaaaa1");
    expect([...a].sort()).toEqual([...inOrder].sort());
    expect(a).not.toEqual(inOrder);
    expect(await w.walk("seedaaaa1")).toEqual(a);
    expect(await w.walk("seedbbbb2")).not.toEqual(a);
  });

  it("starts at the first of the shuffled order, and carries its seed on in every address", async () => {
    const w = await world(3);
    const first = await nextAfter(db, { playlistId: w.playlist.id, viewerId: w.owner.viewer.id, shuffle: "abcdef123456" });
    expect(first.ok && first.value?.href).toContain("&shuffle=abcdef123456");
    const second = await nextAfter(db, { playlistId: w.playlist.id, viewerId: w.owner.viewer.id, afterItemId: first.ok && first.value ? first.value.itemId : undefined, shuffle: "abcdef123456" });
    expect(second.ok && second.value?.href).toContain("&shuffle=abcdef123456");
    const plain = await nextAfter(db, { playlistId: w.playlist.id, viewerId: w.owner.viewer.id });
    expect(plain.ok && plain.value?.href).not.toContain("shuffle");
  });

  it("is followed by the page being played: the queue is valid and the next one is the next in the shuffle", async () => {
    const w = await world(4);
    const seed = "page00seed9";
    const order = await w.walk(seed);
    const titleOf = async (itemId: string) => {
      const { playlistItems } = await import("@/lib/db/schema");
      const { eq } = await import("drizzle-orm");
      return (await db.select().from(playlistItems).where(eq(playlistItems.id, itemId)))[0].titleId as string;
    };
    const q = await queueNext(db, { playlistId: w.playlist.id, itemId: order[1], viewerId: w.owner.viewer.id, titleId: await titleOf(order[1]), shuffle: seed });
    expect(q.valid && q.next?.href).toContain(order[2]);
    const last = await queueNext(db, { playlistId: w.playlist.id, itemId: order[3], viewerId: w.owner.viewer.id, titleId: await titleOf(order[3]), shuffle: seed });
    expect(last).toEqual({ valid: true, next: null });
  });

  it("steps through a show's episodes before the next stop, and ignores a seed that isn't one", async () => {
    const w = await world(0);
    const shows = await makeLibrary(db, w.server.id, "shows", "everyone");
    const s = await makeShow(db, shows.id, 2, { name: "Show" });
    for (const e of s.episodes) await addEpisodeFile(db, e.id);
    const item = await addItem(db, w.playlist.id, { titleId: s.show.id }, 1024);
    const first = await nextAfter(db, { playlistId: w.playlist.id, viewerId: w.owner.viewer.id, shuffle: "showseed123" });
    expect(first.ok && first.value?.itemId).toBe(item.id);
    expect(first.ok && first.value?.href).toContain("shuffle=showseed123");
    expect(validShuffle("short")).toBe(false);
    expect(validShuffle("has space 123")).toBe(false);
    expect(validShuffle("a".repeat(33))).toBe(false);
    expect(validShuffle("Ab12Cd34")).toBe(true);
    expect(validShuffle(null)).toBe(false);
    const plain = await nextAfter(db, { playlistId: w.playlist.id, viewerId: w.owner.viewer.id, shuffle: "bad seed!" });
    expect(plain.ok && plain.value?.href).not.toContain("shuffle");
  });
});
