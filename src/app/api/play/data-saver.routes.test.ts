/** Data saver: what the play and download routes do differently for a profile that has it on. */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

const h = vi.hoisted(() => ({ testDb: null as unknown as { db: import("@/lib/playlists/test-db").TestDb }, resolution: null as unknown, choices: [] as unknown[] }));
vi.mock("@/lib/db/client", async () => {
  const { createTestDb } = await import("@/lib/playlists/test-db");
  h.testDb = await createTestDb();
  return { db: h.testDb.db };
});
vi.mock("@/lib/auth/viewer", () => ({ getCurrentViewer: async () => h.resolution }));
vi.mock("@/lib/player/manifest", () => ({ buildPlayManifest: async (...args: unknown[]) => (h.choices.push(args[6]), { ok: true, manifest: { segments: [], durationSeconds: 10 } }) }));

import { mediaFiles, profiles, viewers } from "@/lib/db/schema";
import { joinServer, makeAccount, makeLibrary, makeServer, makeTitle, type TestDb } from "@/lib/playlists/test-db";
import { GET as play } from "./[ownerKind]/[ownerId]/route";
import { GET as downloadOptions } from "../download/[ownerKind]/[ownerId]/options/route";

let db: TestDb;
beforeAll(() => {
  db = h.testDb.db;
});

async function world(dataSaver: boolean) {
  const owner = await makeAccount(db, "o");
  const server = await makeServer(db, owner.accountId);
  const me = await makeAccount(db, "me");
  await joinServer(db, server.id, me.accountId);
  await db.update(viewers).set({ dataSaver }).where(eq(viewers.id, me.viewer.id));
  const [account] = await db.select().from(profiles).where(eq(profiles.id, me.accountId));
  const all = await db.select().from(viewers).where(eq(viewers.accountId, me.accountId));
  h.resolution = { account, viewer: all[0], viewers: all };
  const movies = await makeLibrary(db, server.id, "movies", "everyone");
  const film = await makeTitle(db, movies.id, { kind: "movie", name: "Film" });
  for (const [label, w, hgt] of [["1080p", 1920, 1080], ["720p", 1280, 720], ["480p", 854, 480], ["360p", 640, 360]] as const) {
    await db.insert(mediaFiles).values({ ownerKind: "title", ownerId: film.id, boxFileId: `ds${Math.random()}`, filename: `f-${label}.mp4`, versionLabel: label, width: w, height: hgt, durationSeconds: 100, sizeBytes: hgt * 1000, container: "mp4", probeStatus: "ok" });
  }
  return { film };
}
const ctx = (id: string) => ({ params: Promise.resolve({ ownerKind: "title", ownerId: id }) }) as never;
const lastChoice = () => h.choices[h.choices.length - 1] as { version: string | null; preferredHeight: number | null };

describe("playing with data saver", () => {
  it("aims at 480p when no height is asked for, caps a higher one, keeps a lower one, and an explicit version is passed untouched", async () => {
    const w = await world(true);
    await play(new Request("http://x"), ctx(w.film.id));
    expect(lastChoice().preferredHeight).toBe(480);
    await play(new Request("http://x?height=1080"), ctx(w.film.id));
    expect(lastChoice().preferredHeight).toBe(480);
    await play(new Request("http://x?height=360"), ctx(w.film.id));
    expect(lastChoice().preferredHeight).toBe(360);
    await play(new Request("http://x?version=1080p"), ctx(w.film.id));
    expect(lastChoice()).toMatchObject({ version: "1080p", preferredHeight: 480 }); // the named version wins when the manifest picks
  });

  it("leaves the choice alone when it is off", async () => {
    const w = await world(false);
    await play(new Request("http://x"), ctx(w.film.id));
    expect(lastChoice().preferredHeight).toBeNull();
    await play(new Request("http://x?height=1080"), ctx(w.film.id));
    expect(lastChoice().preferredHeight).toBe(1080);
  });
});

describe("asking for the original quality", () => {
  it("aims at no height, even with data saver on, and a height asked for with it is ignored", async () => {
    const on = await world(true);
    await play(new Request("http://x?quality=original"), ctx(on.film.id));
    expect(lastChoice().preferredHeight).toBeNull();
    await play(new Request("http://x?quality=original&height=360"), ctx(on.film.id));
    expect(lastChoice().preferredHeight).toBeNull();
    await play(new Request("http://x?quality=other"), ctx(on.film.id));
    expect(lastChoice().preferredHeight).toBe(480); // only "original" is special
  });
});

describe("a device's own data saver choice", () => {
  it("wins over the profile's setting in both directions, and anything else leaves the profile's alone", async () => {
    const on = await world(true);
    await play(new Request("http://x?dataSaver=0"), ctx(on.film.id));
    expect(lastChoice().preferredHeight).toBeNull();
    await play(new Request("http://x?dataSaver=banana"), ctx(on.film.id));
    expect(lastChoice().preferredHeight).toBe(480);
    const off = await world(false);
    await play(new Request("http://x?dataSaver=1"), ctx(off.film.id));
    expect(lastChoice().preferredHeight).toBe(480);
    const suggested = await (await downloadOptions(new Request("http://x?dataSaver=1"), ctx(off.film.id))).json();
    expect(suggested.suggestedLabel).toBe("480p");
  });
});

describe("downloading with data saver", () => {
  it("suggests the version nearest 480p, and suggests nothing when it is off", async () => {
    const on = await world(true);
    const a = await (await downloadOptions(new Request("http://x"), ctx(on.film.id))).json();
    expect(a.suggestedLabel).toBe("480p");
    expect(a.options).toHaveLength(4); // all still offered
    const off = await world(false);
    const b = await (await downloadOptions(new Request("http://x"), ctx(off.film.id))).json();
    expect(b.suggestedLabel).toBeUndefined();
  });
});
