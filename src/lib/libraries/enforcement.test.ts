/**
 * Grep-level guard for src/lib/libraries: a module that READS titles for a viewer must apply both the
 * library-access rule and the age filter. Modules that only act for a server admin (and say so) are
 * listed with the reason. Smell tests, not proofs: the SQL tests are the real checks.
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const DIR = __dirname;
const modules = readdirSync(DIR).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));

/** Modules that touch titles but never return them to a viewer. */
const NOT_VIEWER_READERS: Record<string, string> = {
  "kind.ts": "returns only a title's library kind, for admin-only routes",
  "video-rating.ts": "admin-only: rewrites the rating on every title in a library",
};

describe("libraries modules", () => {
  it("found the modules it expects", () => {
    expect(modules).toContain("folder-browse.ts");
    expect(modules).toContain("access-service.ts");
  });

  for (const file of modules) {
    const source = readFileSync(path.join(DIR, file), "utf8");
    const readsTitles = /import\s*\{[^}]*\btitles\b[^}]*\}\s*from\s*["']@\/lib\/db\/schema["']/.test(source);
    if (!readsTitles) continue;

    if (NOT_VIEWER_READERS[file]) {
      it(`${file} is allowlisted (${NOT_VIEWER_READERS[file]})`, () => {
        expect(NOT_VIEWER_READERS[file].length).toBeGreaterThan(0);
      });
      continue;
    }
    it(`${file} (reads titles) applies library access and the age filter`, () => {
      expect(source, "missing libraryVisible").toMatch(/\blibraryVisible\b/);
      expect(source, "missing contentFilter").toMatch(/\bcontentFilter\b/);
    });
  }

  it("the allow-list only names modules that still exist", () => {
    for (const file of Object.keys(NOT_VIEWER_READERS)) expect(modules).toContain(file);
  });
});
