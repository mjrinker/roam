/** The /join page: a valid open link shows its server (guest button only on a demo); every other link looks identical and names nothing. */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { eq } from "drizzle-orm";

const h = vi.hoisted(() => ({ testDb: null as unknown as { db: import("@/lib/playlists/test-db").TestDb } }));
vi.mock("@/lib/db/client", async () => {
  const { createTestDb } = await import("@/lib/playlists/test-db");
  h.testDb = await createTestDb();
  return { db: h.testDb.db };
});
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => undefined, refresh: () => undefined }) }));
vi.mock("@/lib/supabase/client", () => ({ createSupabaseBrowserClient: () => ({}) }));

import { profiles, servers } from "@/lib/db/schema";
import { makeAccount, makeServer, type TestDb } from "@/lib/playlists/test-db";
import { setJoinLink } from "@/lib/auth/join";
import JoinPage, { metadata } from "./[token]/page";
import { DemoBanner } from "@/components/shell/demo-banner";
import { TmdbAttribution } from "@/components/shell/tmdb-attribution";

let db: TestDb;
beforeAll(() => {
  db = h.testDb.db;
});

const render = async (token: string) => renderToStaticMarkup(await JoinPage({ params: Promise.resolve({ token }) } as never));
async function open(name: string, demo: boolean) {
  const owner = await makeAccount(db, "o");
  await db.update(profiles).set({ canManageOpenLinks: true }).where(eq(profiles.id, owner.accountId));
  const server = await makeServer(db, owner.accountId);
  await db.update(servers).set({ name }).where(eq(servers.id, server.id));
  const link = (await setJoinLink(server.id, { enabled: true, demo }))!;
  return { server, token: link.joinToken! };
}

describe("/join/[token]", () => {
  it("names the server, offers one-click guest entry and the honesty note on a demo", async () => {
    const { token } = await open("Roam Demo", true);
    const html = await render(token);
    expect(html).toContain("Roam Demo");
    expect(html).toContain("Continue as a guest");
    expect(html).toContain("placeholder footage");
    expect(html).toContain("Email link"); // the normal sign-in is there too
  });

  it("offers no guest entry on an ordinary server's link", async () => {
    const { token } = await open("Family", false);
    const html = await render(token);
    expect(html).toContain("Family");
    expect(html).not.toContain("Continue as a guest");
  });

  it("looks the same for a switched-off, replaced, unknown or malformed link, and says nothing about any server", async () => {
    const { server, token } = await open("Secret Name", true);
    await setJoinLink(server.id, { enabled: false });
    const pages = await Promise.all([token, "A".repeat(32), "nope", ""].map(render));
    expect(new Set(pages).size).toBe(1);
    expect(pages[0]).toContain("This link isn&#x27;t valid");
    expect(pages[0]).not.toContain("Secret Name");
  });

  it("asks browsers not to send the link on, and not to index it", () => {
    expect(metadata.referrer).toBe("no-referrer");
    expect(metadata.robots).toEqual({ index: false, follow: false });
  });
});

describe("demo notices", () => {
  it("the banner says the videos, famous-artist albums and Tolkien books are stand-ins and links to the credits", () => {
    const html = renderToStaticMarkup(<DemoBanner serverId="srv" />);
    expect(html).toContain("placeholder files");
    expect(html).toContain("videos");
    expect(html).toContain("albums by famous");
    expect(html).toContain("Tolkien books");
    expect(html).toContain('href="/s/srv/credits"');
  });
  it("TMDB's logo and its required non-endorsement notice are shown together", () => {
    const html = renderToStaticMarkup(<TmdbAttribution />);
    expect(html).toContain('src="/tmdb-logo.svg"');
    expect(html).toContain("This product uses the TMDB API but is not endorsed or certified by TMDB.");
  });
});
