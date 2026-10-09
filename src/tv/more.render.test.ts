import { describe, expect, it } from "vitest";
import { actionRow, detailPage, homePage, listPage, MAX_ACTIONS } from "./render";

const link = (label: string) => `<a class="btn" data-f href="/x">${label}</a>`;
const visible = (html: string) => html.replace(/<span class="morewrap">[\s\S]*$/, ""); // everything before the More button
const hidden = (html: string) => (html.match(/<span class="more-item">[\s\S]*?<\/span>/g) ?? []).join("");

describe("actionRow", () => {
  it("shows at most two actions and puts the rest behind a More button", () => {
    expect(MAX_ACTIONS).toBe(2);
    const html = actionRow(["a", "b", "c", "d"].map(link));
    expect(visible(html)).toContain(">a<");
    expect(visible(html)).toContain(">b<");
    expect(visible(html)).not.toContain(">c<");
    expect(hidden(html)).toContain(">c<");
    expect(hidden(html)).toContain(">d<");
    expect(html).toContain("data-more-toggle");
    expect(html.match(/data-more-toggle/g)).toHaveLength(1);
  });
  it("has no More button when two or fewer are shown", () => {
    for (const items of [[], ["a"], ["a", "b"]]) expect(actionRow(items.map(link)), String(items.length)).not.toContain("more");
    expect(actionRow(["a", "b"].map(link))).toBe(link("a") + link("b"));
  });
});

describe("TV pages use it", () => {
  const detail = (actions: number, posts: number) =>
    detailPage({
      title: "T",
      meta: "",
      overview: null,
      posterUrl: null,
      backHref: "/tv/s/x",
      actions: Array.from({ length: actions }, (_, i) => ({ href: `/a${i}`, label: `Action ${i + 1}` })),
      posts: Array.from({ length: posts }, (_, i) => ({ action: "/tv/s/x/mark", label: `Post ${i + 1}`, fields: { kind: "title", id: String(i) } })),
    });
  it("a detail page keeps its first two actions in view, whether they are links or forms, and tucks the rest away", () => {
    const html = detail(3, 2);
    const shown = visible(html.slice(html.indexOf('<div><a class="btn')));
    expect(shown).toContain("Action 1");
    expect(shown).toContain("Action 2");
    expect(shown).not.toContain("Action 3");
    for (const label of ["Action 3", "Post 1", "Post 2"]) expect(hidden(html), label).toContain(label);
    // posts keep working from inside the More area: still real forms
    expect(hidden(html)).toContain('<form method="post" action="/tv/s/x/mark"');
  });
  it("with one link and one form there is no More button, and with only forms the first one is focused first", () => {
    expect(detail(1, 1)).not.toContain("data-more-toggle");
    const onlyPosts = detail(0, 3);
    expect(onlyPosts).toContain("data-autofocus");
    expect(onlyPosts).toContain("data-more-toggle");
  });
  it("a list page's actions are two and a More; folders are never hidden", () => {
    const html = listPage({
      base: "/tv/s/x",
      title: "Artist",
      backHref: "/tv/s/x",
      actions: ["Play all", "Shuffle", "Add to playlist"].map((name) => ({ href: "/y", name })),
      folders: Array.from({ length: 5 }, (_, i) => ({ href: `/f${i}`, name: `Folder ${i}` })),
      items: [],
      prevHref: null,
      nextHref: null,
    });
    expect(hidden(html)).toContain("Add to playlist");
    expect(hidden(html)).not.toContain("Shuffle");
    for (let i = 0; i < 5; i++) expect(html).toContain(`Folder ${i}`);
    expect(html.match(/data-more-toggle/g)).toHaveLength(1);
    expect((html.match(/data-autofocus/g) ?? []).length).toBe(1); // exactly one place to start
  });
  it("the home screen shows Search and Playlists, with Switch profile and Sign out under More", () => {
    const html = homePage({ serverName: "S", base: "/tv/s/x", profileName: "P", continueWatching: [], libraries: [], unsupported: 0, hasPlaylists: true });
    const row = html.slice(html.indexOf('<div class="row" style="margin-top:2rem">'));
    expect(visible(row)).toContain("Search");
    expect(visible(row)).toContain("Playlists");
    expect(visible(row)).not.toContain("Switch profile");
    expect(hidden(row)).toContain("Switch profile");
    expect(hidden(row)).toContain("Sign out");
  });
  it("without playlists the home screen shows Search and Switch profile, and Sign out is under More", () => {
    const html = homePage({ serverName: "S", base: "/tv/s/x", profileName: "P", continueWatching: [], libraries: [], unsupported: 0 });
    const row = html.slice(html.indexOf('<div class="row" style="margin-top:2rem">'));
    expect(visible(row)).toContain("Switch profile");
    expect(hidden(row)).toContain("Sign out");
  });
});
