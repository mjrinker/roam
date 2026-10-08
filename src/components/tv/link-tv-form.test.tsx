import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { LinkTvForm } from "./link-tv-form";

describe("LinkTvForm", () => {
  it("asks for the code when there is none", () => {
    const html = renderToStaticMarkup(<LinkTvForm email="me@example.com" />);
    expect(html).toContain("The code shown on your TV");
    expect(html).not.toContain("Yes, sign in this TV");
  });
  it("opens straight on the confirmation when the TV's QR code brought the code, naming the TV, where it asked from, and what approving means", () => {
    const html = renderToStaticMarkup(<LinkTvForm email="me@example.com" initial={{ code: "ABCDE", deviceLabel: "Samsung TV", location: "Denver, US" }} />);
    expect(html).toContain("Samsung TV");
    expect(html).toContain("ABCDE");
    expect(html).toContain("me@example.com");
    expect(html).toContain("It asked from Denver, US");
    expect(html).toContain("full access to your Roam account");
    expect(html).toContain("Yes, sign in this TV");
  });
  it("leaves out the place when the platform didn't say", () => {
    const html = renderToStaticMarkup(<LinkTvForm email="me@example.com" initial={{ code: "ABCDE", deviceLabel: "TV", location: null }} />);
    expect(html).not.toContain("It asked from");
  });
});

describe("LinkTvForm (typing a code)", () => {
  it("shows a five-letter example and waits until five characters are typed", () => {
    const html = renderToStaticMarkup(<LinkTvForm email="me@example.com" />);
    expect(html).toContain('placeholder="ABCDE"');
    expect(html).toMatch(/<button[^>]*disabled[^>]*>[^<]*(?:<[^>]+>[^<]*)*Continue/);
  });
});
