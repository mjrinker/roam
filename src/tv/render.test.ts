import { describe, expect, it } from "vitest";
import { card, detailPage, esc, homePage, messagePage, postButton, safeUrl, tvDocument, watchPage } from "./render";

describe("esc / safeUrl", () => {
  it("escapes everything that could close a tag or an attribute", () => {
    expect(esc(`<a href="x" onclick='y'>&`)).toBe("&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;");
    expect(esc(null)).toBe("");
    expect(esc(5)).toBe("5");
  });
  it("lets through paths on this site and https addresses only", () => {
    for (const ok of ["/tv/s/1", "https://image.tmdb.org/t/p/w500/a.jpg", "/api/titles/1/artwork?v=3"]) expect(safeUrl(ok), ok).toBe(ok);
    for (const bad of ["//evil.example/x.jpg", "/\\evil.example/x.jpg", "\\\\evil", "javascript:alert(1)", "data:text/html,x", "http://insecure.example/x", "https://a.example/\nx", "/tv\u0000", "", null, undefined]) {
      expect(safeUrl(bad as never), String(bad)).toBeNull();
    }
  });
});

describe("pages", () => {
  it("never print library text unescaped, in text or attributes", () => {
    const evil = `"><script>alert(1)</script>`;
    const pages = [
      card({ href: "/tv/x", name: evil, meta: evil, posterUrl: "https://a.example/x.jpg" }),
      homePage({ serverName: evil, base: "/tv/s/1", profileName: evil, continueWatching: [{ href: "/tv/x", name: evil, posterUrl: null }], libraries: [{ id: "1", name: evil, kind: evil }], unsupported: 0 }),
      detailPage({ title: evil, meta: evil, overview: evil, posterUrl: null, backHref: "/tv", actions: [{ href: "/tv", label: evil }], episodes: [{ href: "/tv", label: evil, sub: evil }] }),
      watchPage({ title: evil, subtitle: evil, ownerKind: "title", ownerId: "1", back: "/tv", next: null }),
      messagePage(evil, evil, { href: "/tv", label: evil }),
    ];
    for (const p of pages) expect(p).not.toContain("<script>alert(1)");
  });
  it("ignores an address that isn't safe instead of printing it", () => {
    const html = card({ href: "javascript:alert(1)", name: "x", posterUrl: "javascript:alert(2)" });
    expect(html).not.toContain("javascript");
    expect(html).toContain('href="/tv"');
  });
  it("loads exactly one script, with a version in its address", () => {
    expect(tvDocument({ title: "t", body: "" }).match(/<script/g)).toHaveLength(1);
    expect(tvDocument({ title: "t", body: "", script: false })).not.toContain("<script");
  });
  it("makes buttons that POST, for anything that changes state", () => {
    const b = postButton("/tv/signout", `Sign "out"`, { fields: { a: `"><x` }, autofocus: true });
    expect(b).toContain('method="post" action="/tv/signout"');
    expect(b).toContain("data-f data-autofocus");
    expect(b).not.toContain('"><x');
  });
});
