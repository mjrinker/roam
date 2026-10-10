/**
 * No code outside a short, named list may special-case the file-tree library kinds by writing the kind
 * as a string literal. Everything else asks lib/libraries/profile (isFileTreeLibraryKind,
 * libraryKindUsesExternalMetadata) or the scan tree profile, so a kind added later can't be missed by a
 * stray `=== "video"`. A grep-level guard: it flags a quoted "video", "audio" or "photos" next to a comparison, a
 * case label, an enum list or an object key.
 */
import { readFileSync } from "node:fs";
import { globSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SRC = path.join(__dirname, "../..");
const files = globSync("**/*.{ts,tsx}", { cwd: SRC })
  .map((f) => f.replaceAll("\\", "/"))
  .filter((f) => !/\.test\.tsx?$/.test(f) && !f.startsWith("lib/playlists/test-db") && !f.startsWith("lib/scan/test-"));

/** Files that legitimately name the kinds, and why. */
const ALLOWED: Record<string, string> = {
  "lib/db/schema.ts": "defines the library_kind enum",
  "app/api/libraries/route.ts": "the creation request's list of accepted kinds",
  "components/library/audio-views.tsx": "the view tabs of the two song-library kinds (music, audio) - what each offers is the point of the file",
  "lib/player/codec-query.ts": "creates a DOM <video> element to test codec support, not a library kind",
  "tv/client/tv.ts": "creates a DOM <video> element to test codec support, not a library kind",
  "lib/libraries/profile.ts": "the one place that says which kinds are which",
  "lib/scan/tree-profile.ts": "defines the per-kind scanning profiles",
  "components/admin/library-manager.tsx": "the creation form's choices (option values)",
  "app/(app)/s/[serverId]/(browse)/library/[libraryId]/page.tsx": "icon and label maps keyed by every kind, and the audio/video item kind",
  "components/shell/app-sidebar.tsx": "icon map keyed by every kind",
  "lib/scan/scanner.ts": "the switch over library kinds (exhaustive)",
};

// ANY quoted "video" or "audio" (single, double or backtick quotes) in code, however it is used: compared,
// passed to a query, listed, a case label, an object value. Object KEYS are caught separately.
const LITERAL = /["'`](video|audio|photos)["'`]|\b(video|audio|photos)\s*:\s*[A-Z"'`]/;

describe("no stray special-casing of file-tree library kinds", () => {
  it("found the source files it expects to scan", () => {
    expect(files).toContain("lib/libraries/profile.ts");
    expect(files.length).toBeGreaterThan(100);
  });

  for (const file of files) {
    const source = readFileSync(path.join(SRC, file), "utf8");
    const hits = source.split("\n").filter((line) => LITERAL.test(line) && !line.trim().startsWith("//") && !line.trim().startsWith("*"));
    if (hits.length === 0) continue;
    it(`${file} names a file-tree kind only if it is on the allowed list`, () => {
      expect(
        ALLOWED[file],
        `${file} writes "video", "audio" or "photos" as a library kind:\n${hits.join("\n")}\nUse isFileTreeLibraryKind / libraryKindUsesExternalMetadata from lib/libraries/profile (or the scan tree profile) instead, or add the file to ALLOWED with a reason.`
      ).toBeTruthy();
    });
  }

  it("the allow-list only names files that still do it (so it can't go stale)", () => {
    for (const file of Object.keys(ALLOWED)) {
      const source = readFileSync(path.join(SRC, file), "utf8");
      expect(source.split("\n").some((line) => LITERAL.test(line)), file).toBe(true);
    }
  });
});
