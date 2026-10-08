/** A guest stays invisible to other visitors, whatever profiles it adds or edits; a normal account keeps its own choice. */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

const h = vi.hoisted(() => ({ testDb: null as unknown as { db: import("@/lib/playlists/test-db").TestDb }, resolution: null as unknown }));
vi.mock("@/lib/db/client", async () => {
  const { createTestDb } = await import("@/lib/playlists/test-db");
  h.testDb = await createTestDb();
  return { db: h.testDb.db };
});
vi.mock("@/lib/auth/viewer", () => ({ getCurrentViewer: async () => h.resolution }));
vi.mock("next/headers", () => ({ cookies: async () => ({ delete: () => undefined, get: () => undefined }) }));

import { profiles, viewers } from "@/lib/db/schema";
import { makeAccount, type TestDb } from "@/lib/playlists/test-db";
import { POST } from "./route";
import { PATCH } from "./[id]/route";

let db: TestDb;
beforeAll(() => {
  db = h.testDb.db;
});

async function signInAs(accountId: string, guest: boolean) {
  if (guest) await db.update(profiles).set({ isGuest: true }).where(eq(profiles.id, accountId));
  const [account] = await db.select().from(profiles).where(eq(profiles.id, accountId));
  const all = await db.select().from(viewers).where(eq(viewers.accountId, accountId));
  h.resolution = { account, viewer: all[0], viewers: all };
}
const post = (body: unknown) => POST(new Request("http://x", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
const patch = (id: string, body: unknown) => PATCH(new Request("http://x", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), { params: Promise.resolve({ id }) } as never);
const visibleOf = async (id: string) => (await db.select().from(viewers).where(eq(viewers.id, id)))[0].visibleOnServer;

describe("profiles added or edited by a guest", () => {
  it("a profile a guest adds is hidden even when it asks to be visible, and can't be made visible later", async () => {
    const guest = await makeAccount(db, "g");
    await signInAs(guest.accountId, true);
    const { id } = await (await post({ name: "Hire me", avatarKey: "teal-user", visibleOnServer: true })).json();
    expect(await visibleOf(id)).toBe(false);
    await signInAs(guest.accountId, true); // reload the account's profiles, now including the new one
    expect((await patch(id, { visibleOnServer: true })).status).toBe(200);
    expect(await visibleOf(id)).toBe(false);
  });

  it("a normal account chooses for itself", async () => {
    const person = await makeAccount(db, "p");
    await signInAs(person.accountId, false);
    const { id } = await (await post({ name: "Kid", avatarKey: "teal-user", visibleOnServer: true })).json();
    expect(await visibleOf(id)).toBe(true);
    await signInAs(person.accountId, false);
    await patch(id, { visibleOnServer: false });
    expect(await visibleOf(id)).toBe(false);
    await patch(id, { visibleOnServer: true });
    expect(await visibleOf(id)).toBe(true);
  });
});
