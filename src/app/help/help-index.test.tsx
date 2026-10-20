import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import HelpPage from "./page";
import NamingHelpPage from "./naming/page";

describe("the help index", () => {
  it("lists each article as a link, the TV guide and the naming guide", () => {
    const html = renderToStaticMarkup(<HelpPage />);
    expect(html).toContain('href="/help/naming"');
    expect(html).toContain('href="/help/tv"');
    expect(html).toContain("Naming and organizing your files");
    expect(html).toContain("Watch Roam on your TV");
  });
  it("the naming guide's contents is a list with one line (item) per section, each jumping to its section", () => {
    const html = renderToStaticMarkup(<NamingHelpPage />);
    const nav = /<nav aria-label="On this page"[\s\S]*?<\/nav>/.exec(html)![0];
    const items = nav.match(/<li>/g) ?? [];
    expect(items.length).toBe(9);
    for (const id of ["basics", "movies", "tv", "extras", "subtitles", "posters", "music", "more", "formats"]) {
      expect(nav).toContain(`href="#${id}"`);
      expect(html).toContain(`id="${id}"`);
    }
    expect(nav).toContain("<ul");
    expect(html).toContain('href="/help"');
  });
});
