import { describe, expect, it } from "vitest";
import { anonymousPath, cleanDiagnostics, cleanLine, cleanText, defaultVisibility, isClosedStatus, issueBody, issueLabels, issueTitle } from "./rules";

describe("cleaning what people type", () => {
  it("a line loses control characters and extra spaces, and is cut to length", () => {
    expect(cleanLine("  Hello \u0000\n  world  ", 50)).toBe("Hello world");
    expect(cleanLine("x".repeat(500), 20)).toHaveLength(20);
    expect(cleanLine(42, 20)).toBe("");
  });
  it("text keeps its line breaks, but not more than one blank line in a row, and no control characters", () => {
    expect(cleanText("a\r\n\r\n\r\n\r\nb\u0007c  \nd", 100)).toBe("a\n\nbc\nd");
  });
});

describe("who sees a new report", () => {
  it("a feature request is public unless kept private; a bug is private", () => {
    expect(defaultVisibility("feature", false)).toBe("public");
    expect(defaultVisibility("feature", true)).toBe("private");
    expect(defaultVisibility("bug", false)).toBe("private");
  });
});

describe("what is sent along", () => {
  it("takes the ids and query out of an address", () => {
    expect(anonymousPath("/s/6f1c2d3e-aaaa-4bbb-8ccc-1234567890ab/title/6f1c2d3e-aaaa-4bbb-8ccc-1234567890ac?x=1#top")).toBe("/s/:id/title/:id");
    expect(anonymousPath("/s/x/watch/title/12345?a=b")).toBe("/s/x/watch/title/:id");
  });
  it("keeps only the known details, of the right type", () => {
    expect(cleanDiagnostics({ path: "/s/6f1c2d3e-aaaa-4bbb-8ccc-1234567890ab/library", userAgent: "Mozilla  5.0", viewport: "390x844", standalone: true, evil: "x", online: "yes", email: "a@b.c" })).toEqual({ path: "/s/:id/library", userAgent: "Mozilla 5.0", viewport: "390x844", standalone: true });
    expect(cleanDiagnostics(null)).toBeNull();
    expect(cleanDiagnostics({ nothing: 1 })).toBeNull();
  });
});

describe("the GitHub issue", () => {
  it("is titled and labelled for its kind", () => {
    expect(issueTitle("bug", "Player stalls")).toBe("Bug: Player stalls");
    expect(issueTitle("feature", "Dark mode")).toBe("Feature request: Dark mode");
    expect(issueLabels("bug")).toEqual(["roam-feedback", "bug"]);
    expect(issueLabels("feature")).toEqual(["roam-feedback", "enhancement"]);
  });
  it("carries the words and the anonymised details, and nothing that names the author or a server", () => {
    const body = issueBody({ kind: "bug", body: "It stops at the next part.", diagnostics: { path: "/s/:id/watch/title/:id", appVersion: "abc123", userAgent: "Safari <script>", viewport: "812x375", standalone: true } });
    expect(body).toContain("It stops at the next part.");
    expect(body).toContain("Page: `/s/:id/watch/title/:id`");
    expect(body).toContain("Version: `abc123`");
    expect(body).toContain("Installed app: yes");
    expect(body).not.toContain("<script>");
    expect(body).not.toMatch(/@|email/i);
    expect(issueBody({ kind: "feature", body: "Idea", diagnostics: null })).not.toContain("Technical details");
  });
  it("closes for done, declined and duplicate", () => {
    expect(["new", "planned", "in_progress", "done", "declined", "duplicate"].map((s) => isClosedStatus(s as never))).toEqual([false, false, false, true, true, true]);
  });
});
