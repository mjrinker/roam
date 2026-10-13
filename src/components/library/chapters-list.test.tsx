import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ChaptersList } from "./chapters-list";

const chapters = [
  { title: "Opening", startSeconds: 0 },
  { title: "The heist", startSeconds: 754.6 },
  { title: "Finale", startSeconds: 3750 },
];

describe("ChaptersList", () => {
  it("lists each chapter with its time, linking to the player at that second", () => {
    const html = renderToStaticMarkup(<ChaptersList serverId="s1" ownerKind="title" ownerId="m1" chapters={chapters} />);
    expect(html).toContain("Chapters");
    expect(html).toContain("(3)");
    expect(html).toContain('href="/s/s1/watch/title/m1?t=0"');
    expect(html).toContain('href="/s/s1/watch/title/m1?t=754"');
    expect(html).toContain('href="/s/s1/watch/title/m1?t=3750"');
    expect(html).toContain("12:34");
    expect(html).toContain("1:02:30");
    expect(html).toContain("The heist");
  });
  it("is a closed disclosure, so a long list stays out of the way", () => {
    expect(renderToStaticMarkup(<ChaptersList serverId="s" ownerKind="episode" ownerId="e" chapters={chapters} compact />)).not.toMatch(/<details[^>]* open/);
  });
  it("shows nothing without chapters", () => {
    expect(renderToStaticMarkup(<ChaptersList serverId="s" ownerKind="title" ownerId="m" chapters={[]} />)).toBe("");
  });
});
