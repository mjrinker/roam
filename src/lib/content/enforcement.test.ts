import { readFileSync } from "node:fs";
import { globSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Guards against a new page or route quietly listing/serving titles,
 * episodes, or watch_state without going through the one rating check (see
 * lib/content/access, lib/auth/resolve-server's authorizeOwner). Every file
 * under src/app that touches those tables must either import one of the
 * approved helpers, or be named in ALLOWLIST with a reason it's exempt
 * (admin-only surfaces, which already require an unrestricted profile — see
 * requireServerAdmin/getCurrentServerAdmin).
 */

const APP_DIR = path.join(__dirname, "../../app");

// The age check (lib/content/access) alone is no longer enough: content is also gated by library
// access (lib/content/library-access), which authorizeOwner (resolve-server) and the playlist readers
// (playlists/items, next) apply for you.
const ENFORCEMENT_IMPORTS = ["@/lib/content/library-access", "@/lib/auth/resolve-server", "@/lib/playlists/items"];

// path (relative to src/app) -> why it doesn't need to import the above.
const ALLOWLIST: Record<string, string> = {
  "(app)/s/[serverId]/(browse)/admin/page.tsx": "admin-only (requireServerAdmin requires an unrestricted profile)",
  "platform/page.tsx": "platform-admin only (requirePlatformAdmin); shows aggregate counts, never an item",
  "api/audiobooks/search/route.ts": "admin-only (getCurrentServerAdmin)",
  "api/v1/servers/[serverId]/titles/[id]/route.ts": "reads only through lib/tv/data (library visibility and the age filter) and the ownership view; covered by app/api/v1/browse.routes.test.ts",
  "(app)/s/[serverId]/(browse)/admin/stats/page.tsx": "admin-only (requireServerAdmin); shows aggregate time and title names from lib/stats, which count only this server's activity (stats.sql.test.ts)",
  "(app)/s/[serverId]/(browse)/admin/stats/[accountId]/page.tsx": "admin-only (requireServerAdmin); one household's recorded time on this server, only for a member of it (stats.sql.test.ts)",
  "tv/s/[serverId]/labels/[id]/route.ts": "reads only through labelWithTitles in lib/labels/queries, which applies the profile's own label, library visibility, the age limit and something to play (queries.sql.test.ts and apps-features.routes.test.ts)",
  "api/ownership/owners/route.ts": "admin-only (getCurrentServerAdmin); only reads the titles of that admin's own server, to assign owners",
  "api/titles/[id]/match/route.ts": "admin-only (getCurrentServerAdmin)",
  "api/titles/[id]/match-audible/route.ts": "admin-only (getCurrentServerAdmin)",
  "api/titles/[id]/sync/route.ts": "admin-only (getCurrentServerAdmin)",
  "tv/s/[serverId]/album/[id]/route.ts": "reads only through getAlbum in lib/music/browse (access-controlled); `episodes` is just the name of the list of rows detailPage draws (data.kinds.sql.test.ts and browse.routes.test.ts)",
  "tv/s/[serverId]/library/[id]/route.ts": "reads only through libraryTitles, pageForLetter and the folder and photo readers in lib/tv/data, which apply library visibility and the age filter (library-view.sql.test.ts, data.sql.test.ts and library-view.routes.test.ts)",
  "tv/s/[serverId]/library/[id]/choose/route.ts": "reads only through tvLibrary and libraryGenres in lib/tv/data (library visibility and the age filter; library-view.sql.test.ts and library-view.routes.test.ts)",
  "api/v1/servers/[serverId]/libraries/[libraryId]/genres/route.ts": "reads only through tvLibrary and libraryGenres in lib/tv/data (library visibility and the age filter; library-view.sql.test.ts)",
  "api/v1/servers/[serverId]/collections/[id]/route.ts": "reads only through getCollection in lib/collections/queries, which applies library visibility and the age filter (collections.sql.test.ts, collections.routes.test.ts)",
  "api/collections/[id]/items/route.ts": "admin-only (getCurrentServerAdmin via adminOfCollection); only touches a collection of that admin's own server (collections.routes.test.ts)",
  "tv/s/[serverId]/collections/[libraryId]/route.ts": "reads only through tvLibrary and listCollections (library visibility and the age filter; collections.sql.test.ts and collections.tv.routes.test.ts)",
  "tv/s/[serverId]/collection/[id]/route.ts": "reads only through getCollection (library visibility and the age filter; collections.sql.test.ts and collections.tv.routes.test.ts)",
  "tv/s/[serverId]/show/[id]/route.ts": "reads only through showDetail in lib/tv/data, which applies library visibility and the age filter (data.sql.test.ts and browse.routes.test.ts)",
};

const OWNER_TABLE_RE = /\btitles\b|\bepisodes\b|\bwatchState\b/;

function findAppFiles(): string[] {
  // Test files aren't served, so they can't leak anything; only real pages and routes are checked.
  return globSync("**/*.{ts,tsx}", { cwd: APP_DIR })
    .map((f) => f.replaceAll("\\", "/"))
    .filter((f) => !/\.test\.tsx?$/.test(f));
}

describe("content access enforcement", () => {
  const files = findAppFiles();

  it("found the app files it expects to check (sanity check the glob itself)", () => {
    expect(files).toContain("api/search/route.ts");
    expect(files.length).toBeGreaterThan(10);
  });

  for (const file of files) {
    const full = path.join(APP_DIR, file);
    const source = readFileSync(full, "utf8");
    if (!OWNER_TABLE_RE.test(source)) continue;

    it(`${file} enforces or is allowlisted`, () => {
      if (ALLOWLIST[file]) {
        expect(ALLOWLIST[file].length).toBeGreaterThan(0);
        return;
      }
      const enforces = ENFORCEMENT_IMPORTS.some((spec) => source.includes(spec));
      expect(
        enforces,
        `${file} references titles/episodes/watchState but doesn't import ${ENFORCEMENT_IMPORTS.join(" or ")}. ` +
          `Add the rating check, or add it to ALLOWLIST in enforcement.test.ts with a reason.`
      ).toBe(true);
    });
  }
});
