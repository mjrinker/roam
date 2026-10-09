import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => undefined }) }));
vi.mock("next/link", () => ({ default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a> }));
vi.mock("sonner", () => ({ toast: { success: () => undefined, error: () => undefined } }));

import { defaultSubtitleLanguage, SUBTITLE_LANGUAGES } from "@/lib/subtitles/languages";
import { SubtitleManager } from "./subtitle-manager";

const props = { ownerKind: "title" as const, ownerId: "t1", tracks: [], openSubtitlesReady: true, defaultLanguage: "en", watchHref: "/s/x/watch/title/t1" };

describe("the subtitle manager", () => {
  it("says there are none yet, offers a search and a file upload, and links back to the player", () => {
    const html = renderToStaticMarkup(<SubtitleManager {...props} />);
    expect(html).toContain("No subtitles yet.");
    expect(html).toContain("Find on OpenSubtitles");
    expect(html).toContain('aria-label="Language to search for"');
    expect(html).toContain('type="file"');
    expect(html).toContain("accept=\".srt,.vtt,.ass,.ssa");
    expect(html).toContain('href="/s/x/watch/title/t1"');
  });
  it("lists the tracks it has, with where they came from, and a remove button each", () => {
    const html = renderToStaticMarkup(
      <SubtitleManager {...props} tracks={[{ id: "a", language: "en", label: "English <b>", source: "upload", hearingImpaired: false, cueCount: 1234 }, { id: "b", language: "es", label: "Español (SDH)", source: "opensubtitles", hearingImpaired: true, cueCount: 5 }]} />
    );
    expect(html).toContain("English &lt;b&gt;");
    expect(html).not.toContain("English <b>");
    expect(html).toContain("1,234 lines");
    expect(html).toContain("your file");
    expect(html).toContain("OpenSubtitles");
    expect(html).toContain("for the hard of hearing");
    expect(html).toContain('aria-label="Remove English &lt;b&gt;"');
  });
  it("says OpenSubtitles isn't set up, without a search form, when it isn't", () => {
    const html = renderToStaticMarkup(<SubtitleManager {...props} openSubtitlesReady={false} />);
    expect(html).toContain("isn&#x27;t set up");
    expect(html).not.toContain("Language to search for");
    expect(html).toContain('type="file"'); // uploading still works
  });
  it("starts the pickers on the profile's language", () => {
    expect(renderToStaticMarkup(<SubtitleManager {...props} defaultLanguage="es" />)).toMatch(/<option value="es" selected/);
  });
});

describe("languages", () => {
  it("picks a default from a locale, falling back to English", () => {
    expect([defaultSubtitleLanguage("en-US"), defaultSubtitleLanguage("es_MX"), defaultSubtitleLanguage("fr"), defaultSubtitleLanguage("xx-YY"), defaultSubtitleLanguage(null), defaultSubtitleLanguage("")]).toEqual(["en", "es", "fr", "en", "en", "en"]);
  });
  it("lists each code once", () => {
    const codes = SUBTITLE_LANGUAGES.map((l) => l.code);
    expect(new Set(codes).size).toBe(codes.length);
  });
});
