import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => undefined }) }));

import { ParentalGuide } from "./parental-guide";
import { PlayChoicesButton } from "./play-choices";

const community = { source: "community" as const, category: "animals" as const, severity: "high" as const, scenes: 2, seconds: 25 };
const file = { category: "violence" as const, severity: "medium" as const, scenes: 3, seconds: 60 };

describe("the parental guide with Does the Dog Die", () => {
  it("shows a community category without a strength, the reports, and the required credit and warning", () => {
    const html = renderToStaticMarkup(<ParentalGuide lines={[community]} prefs={{}} imdbId={null} reports={[{ topicName: "a dog dies", yes: 57, no: 3 }]} />);
    expect(html).toContain("Animal harm");
    expect(html).toContain("Reported by the community");
    expect(html).not.toContain("Strong");
    expect(html).toContain("a dog dies");
    expect(html).toContain("57 yes, 3 no");
    expect(html).toContain("Powered by DoesTheDogDie.com");
    expect(html).toContain('href="https://www.doesthedogdie.com"');
    expect(html).toContain("aren&#x27;t verified");
  });
  it("shows no credit when nothing came from them, and keeps file lines' strength", () => {
    const html = renderToStaticMarkup(<ParentalGuide lines={[file]} prefs={{}} imdbId="tt1" />);
    expect(html).not.toContain("DoesTheDogDie");
    expect(html).toContain("Moderate");
    expect(html).toContain("From a content filter file");
  });
  it("shows the guide for reports alone, and nothing when there is nothing", () => {
    expect(renderToStaticMarkup(<ParentalGuide lines={[]} prefs={{}} imdbId={null} reports={[{ topicName: "x", yes: 5, no: 1 }]} />)).toContain("What the community reports");
    expect(renderToStaticMarkup(<ParentalGuide lines={[]} prefs={{}} imdbId={null} reports={[]} />)).toBe("");
  });
});

describe("the play button's first-time lookup", () => {
  it("is still a plain link to the player, ready to ask the server first", () => {
    const html = renderToStaticMarkup(<PlayChoicesButton href="/s/1/watch/title/2" lines={[]} prefs={{}} dddUrl="/api/ddd/title/2">Play</PlayChoicesButton>);
    expect(html).toContain('href="/s/1/watch/title/2"');
  });
});

describe("the play button with reported-but-unskippable topics", () => {
  it("still links to the player, ready to warn first", () => {
    const html = renderToStaticMarkup(<PlayChoicesButton href="/s/1/watch/title/2" lines={[]} prefs={{ animals: "low" }} unskippable={[{ category: "animals", topicName: "a dog dies", yes: 57, no: 3 }]}>Play</PlayChoicesButton>);
    expect(html).toContain('href="/s/1/watch/title/2"');
  });
});
