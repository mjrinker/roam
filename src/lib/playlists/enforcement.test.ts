import { globSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Keeps playlist code from reading content tables directly: every item read
 * must go through lib/playlists/items (which applies the viewing profile's age
 * restrictions in SQL). The existing lib/content/enforcement.test.ts is a raw
 * text check over src/app; these checks are about schema IMPORTS and also cover
 * lib/playlists itself.
 */

const SRC = path.join(__dirname, "../..");
const APP = path.join(SRC, "app");
const PLAYLIST_LIB = __dirname;

/** The names imported from "@/lib/db/schema" in a source file (handles multi-line imports and `as`). */
export function schemaImports(source: string): string[] {
  const names: string[] = [];
  for (const m of source.matchAll(/import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*["']@\/lib\/db\/schema["']/g)) {
    for (const part of m[1].split(",")) {
      const name = part.trim().split(/\s+as\s+/)[0].trim();
      if (name) names.push(name);
    }
  }
  return names;
}

const CONTENT_TABLES = ["titles", "episodes", "playlistItems"];

/** New playlist surfaces under src/app. Existing pages (watch, book, ...) are NOT in this set. */
function newPlaylistAppFiles(): string[] {
  const patterns = [
    "api/playlists/**/*.{ts,tsx}",
    "api/servers/*/playlists/**/*.{ts,tsx}",
    "api/servers/*/viewers/**/*.{ts,tsx}",
    "**/playlists/**/*.{ts,tsx}",
  ];
  const files = new Set<string>();
  for (const pattern of patterns) for (const f of globSync(pattern, { cwd: APP })) files.add(f.replaceAll("\\", "/"));
  return [...files].filter((f) => !f.endsWith(".test.ts") && !f.endsWith(".test.tsx"));
}

describe("schemaImports (the checker itself)", () => {
  it("finds single-line, multi-line, aliased and type-only imports", () => {
    expect(schemaImports('import { titles, episodes } from "@/lib/db/schema";')).toEqual(["titles", "episodes"]);
    expect(schemaImports('import {\n  playlistItems as items,\n  libraries,\n} from "@/lib/db/schema";')).toEqual([
      "playlistItems",
      "libraries",
    ]);
    expect(schemaImports('import type { titles } from "@/lib/db/schema";')).toEqual(["titles"]);
  });

  it("ignores other modules and comments mentioning the tables", () => {
    expect(schemaImports('import { titles } from "./titles";\n// titles episodes')).toEqual([]);
  });
});

describe("new playlist code under src/app does not touch content tables directly", () => {
  it("the rule flags a violating file and passes a clean one (so this suite is never vacuous)", () => {
    const violating = 'import { playlists, titles } from "@/lib/db/schema";';
    const clean = 'import { playlists } from "@/lib/db/schema";\nimport { listVisibleItems } from "@/lib/playlists/items";';
    const bad = (src: string) => schemaImports(src).filter((n) => CONTENT_TABLES.includes(n));
    expect(bad(violating)).toEqual(["titles"]);
    expect(bad(clean)).toEqual([]);
  });

  for (const file of newPlaylistAppFiles()) {
    it(`${file} imports none of ${CONTENT_TABLES.join("/")}`, () => {
      const imported = schemaImports(readFileSync(path.join(APP, file), "utf8"));
      expect(imported.filter((n) => CONTENT_TABLES.includes(n))).toEqual([]);
    });
  }
});

describe("playlistItems is only imported by lib/playlists", () => {
  const appFiles = globSync("**/*.{ts,tsx}", { cwd: APP }).map((f) => f.replaceAll("\\", "/"));

  it("found the app files it expects (sanity check the glob)", () => {
    expect(appFiles.length).toBeGreaterThan(10);
  });

  it("no file under src/app imports playlistItems", () => {
    const offenders = appFiles.filter((f) => schemaImports(readFileSync(path.join(APP, f), "utf8")).includes("playlistItems"));
    expect(offenders).toEqual([]);
  });
});

describe("lib/playlists modules that read content apply the age filter", () => {
  const libFiles = globSync("*.ts", { cwd: PLAYLIST_LIB }).filter(
    (f) => !f.endsWith(".test.ts") && f !== "test-db.ts"
  );

  it("found the playlist modules it expects", () => {
    expect(libFiles).toContain("items.ts");
    expect(libFiles).toContain("item-service.ts");
  });

  // These are grep-level smell tests, not proofs: they catch a new module that reads
  // content and forgets the restriction entirely.
  for (const file of libFiles) {
    const source = readFileSync(path.join(PLAYLIST_LIB, file), "utf8");
    const imported = schemaImports(source);
    const readsContent = imported.some((n) => n === "titles" || n === "episodes");
    const touchesItems = imported.includes("playlistItems");
    const filters = /\bcontentFilter\b|\bisAllowed\b/.test(source);

    const gatesLibraries = /\blibraryVisible\b/.test(source);

    if (readsContent) {
      it(`${file} (reads titles/episodes) references contentFilter or isAllowed`, () => {
        expect(filters).toBe(true);
      });
      it(`${file} (reads titles/episodes) also gates by library access (libraryVisible)`, () => {
        expect(gatesLibraries).toBe(true);
      });
    } else if (touchesItems) {
      it(`${file} (touches playlist items only) filters or uses the filtered helpers from ./items`, () => {
        expect(filters || /from\s+["']\.\/items["']/.test(source)).toBe(true);
      });
    }
  }
});
