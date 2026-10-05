import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Artwork } from "./artwork";

const html = (src: string) => renderToStaticMarkup(<Artwork src={src} alt="" width={100} height={150} />);

describe("Artwork", () => {
  it("loads Roam's own authenticated images directly, never through the shared image optimizer", () => {
    const own = html("/api/titles/abc/artwork?v=123");
    expect(own).toContain('src="/api/titles/abc/artwork?v=123"');
    expect(own).not.toContain("/_next/image");
  });

  it("still optimizes outside images, as before", () => {
    expect(html("https://image.tmdb.org/t/p/w500/x.jpg")).toContain("/_next/image?url=");
  });

  it("an explicit unoptimized request is respected", () => {
    expect(renderToStaticMarkup(<Artwork src="https://image.tmdb.org/t/p/w500/x.jpg" alt="" width={1} height={1} unoptimized />)).not.toContain("/_next/image");
  });
});

describe("no title artwork bypasses it", () => {
  // The only components allowed to use next/image directly, and why.
  const ALLOWED: Record<string, string> = {
    "components/ui/artwork.tsx": "the wrapper itself",
    "components/admin/audible-match-dialog.tsx": "Audible search results, not stored artwork",
    "components/library/season-episodes.tsx": "episode stills come from TMDB",
  };

  function files(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const full = path.join(dir, name);
      return statSync(full).isDirectory() ? files(full) : full.endsWith(".tsx") && !full.endsWith(".test.tsx") ? [full] : [];
    });
  }
  const SRC = path.join(__dirname, "../..");

  for (const file of files(SRC)) {
    const rel = path.relative(SRC, file).replaceAll("\\", "/");
    if (!readFileSync(file, "utf8").includes('from "next/image"')) continue;
    it(`${rel} either uses Artwork or is explicitly allowed`, () => {
      expect(ALLOWED[rel], `${rel} imports next/image directly; use components/ui/artwork instead (or add it to ALLOWED with a reason).`).toBeTruthy();
    });
  }

  it("the allow-list only names files that still import it (so it can't go stale)", () => {
    for (const rel of Object.keys(ALLOWED)) {
      expect(readFileSync(path.join(SRC, rel), "utf8"), rel).toContain('from "next/image"');
    }
  });
});
