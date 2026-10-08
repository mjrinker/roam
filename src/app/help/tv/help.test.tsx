import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/headers", () => ({ headers: async () => new Headers({ host: "roam.example" }) }));

import TvHelpPage from "./page";

describe("the TV help page", () => {
  it("spells out the exact address to type, for the site it is served from", async () => {
    const html = renderToStaticMarkup(await TvHelpPage());
    expect(html).toContain("roam.example/t");
    expect(html).toContain("roam.example/link");
  });
  it("shows the short TV address when there is one, and still sends phones to the main address", async () => {
    vi.stubEnv("NEXT_PUBLIC_TV_HOST", "roamtv.vercel.app");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://main.example");
    const html = renderToStaticMarkup(await TvHelpPage());
    vi.unstubAllEnvs();
    expect(html).toContain("roamtv.vercel.app/t");
    expect(html).toContain("main.example/link");
    expect(html).not.toContain("roam.example/");
  });
  it("tells people how to avoid typing the address again", async () => {
    const html = renderToStaticMarkup(await TvHelpPage());
    expect(html).toContain("home page");
    expect(html).toContain("bookmarks");
    expect(html).toContain("will not need a code again");
  });
  it("covers each kind of TV, and says plainly that Vizio has no browser", async () => {
    const html = renderToStaticMarkup(await TvHelpPage());
    for (const word of ["Samsung", "LG", "Fire TV", "Vizio", "QR code"]) expect(html).toContain(word);
    expect(html).toContain("Vizio TVs don&#x27;t have a web browser");
  });
});
