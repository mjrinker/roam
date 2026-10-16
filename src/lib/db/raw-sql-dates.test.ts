import { globSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The real database driver (postgres.js) cannot send a JavaScript Date as a parameter of hand-written SQL (`sql\`... ${date}\``): it throws
 * "The string argument must be of type string... Received an instance of Date". The in-memory test database accepts it, so tests pass and
 * production fails (a play request broke this way). Dates in raw SQL go in as `${date.toISOString()}::timestamptz`; the query builder's own
 * operators (gt, lt, eq on a column) are fine and are not what this looks at.
 */
const SRC = path.join(__dirname, "../..");

/** Names that hold a Date in this codebase, interpolated bare inside a sql template. */
const BARE_DATE = /sql`[^`]*\$\{\s*(?:now|since|cutoff|date|expiresAt|startedAt|[a-zA-Z]+\.(?:since|cutoff|now|watched|notWatched))\s*\}/;

describe("raw SQL never receives a Date", () => {
  const files = globSync("**/*.{ts,tsx}", { cwd: SRC }).filter((f) => !f.endsWith(".test.ts") && !f.endsWith(".test.tsx"));

  it("found the source files it expects", () => {
    expect(files.length).toBeGreaterThan(200);
  });

  it("the rule flags a bare Date and passes an ISO string (so this is never vacuous)", () => {
    expect(BARE_DATE.test("sql`a < ${cutoff}`")).toBe(true);
    expect(BARE_DATE.test("sql`a >= ${a.since}`")).toBe(true);
    expect(BARE_DATE.test("sql`a >= ${a.since.toISOString()}::timestamptz`")).toBe(false);
  });

  for (const file of files) {
    const source = readFileSync(path.join(SRC, file), "utf8");
    if (!source.includes("sql`")) continue;
    it(`${file} puts no Date straight into raw SQL`, () => {
      const hit = source.split("\n").findIndex((line) => BARE_DATE.test(line));
      expect(hit, hit >= 0 ? `line ${hit + 1}: ${source.split("\n")[hit].trim()}` : "").toBe(-1);
    });
  }
});
