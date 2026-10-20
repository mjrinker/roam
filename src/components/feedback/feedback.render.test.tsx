import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => undefined, refresh: () => undefined }) }));

import { FeedbackBoard } from "./feedback-board";
import { FeedbackThread } from "./feedback-thread";
import type { FeedbackView } from "@/lib/feedback/service";

const item = (over: Partial<FeedbackView> = {}): FeedbackView => ({ id: "i1", kind: "feature", title: "Sleep timer for audiobooks", body: "Stop after a while.", status: "planned", visibility: "public", votes: 4, iVoted: false, mine: false, comments: 2, duplicateOf: null, createdAt: "2026-10-19T10:00:00Z", ...over });

describe("the board", () => {
  it("lists each item with its votes, status and comments, linking to it, and has the three views", () => {
    const html = renderToStaticMarkup(<FeedbackBoard serverId="s1" tab="ideas" items={[item(), item({ id: "i2", kind: "bug", title: "A bug", visibility: "private", mine: true })]} canWrite q="" />);
    expect(html).toContain("Sleep timer for audiobooks");
    expect(html).toContain('href="/s/s1/feedback/i1"');
    expect(html).toContain("Planned");
    expect(html).toContain('aria-label="Vote (4)"');
    for (const tab of ["Ideas", "Known bugs", "Your reports"]) expect(html).toContain(tab);
    expect(html).toContain("private"); // a private report shows no vote button
    expect(html).toContain("Send feedback");
  });
  it("says what is missing, and a limited profile can read but not send or vote", () => {
    expect(renderToStaticMarkup(<FeedbackBoard serverId="s1" tab="mine" items={[]} canWrite q="" />)).toContain("You haven&#x27;t sent anything yet.");
    const kid = renderToStaticMarkup(<FeedbackBoard serverId="s1" tab="ideas" items={[item()]} canWrite={false} q="" />);
    expect(kid).not.toContain("Send feedback");
    expect(kid).toMatch(/aria-label="Vote \(4\)"[^>]*disabled|disabled[^>]*aria-label="Vote \(4\)"/);
  });
});

describe("one item", () => {
  const comments = [{ id: "c1", body: "Me too", official: false, mine: false, createdAt: "2026-10-19T11:00:00Z" }, { id: "c2", body: "Planned for next month", official: true, mine: false, createdAt: "2026-10-19T12:00:00Z" }];
  it("shows the conversation, official replies as Roam team and everyone else as someone", () => {
    const html = renderToStaticMarkup(<FeedbackThread backHref="/b" backLabel="Feedback" item={item()} comments={comments} canWrite operator={false} />);
    expect(html).toContain("Roam team");
    expect(html).toContain("Someone");
    expect(html).toContain("Add a comment");
    expect(html).not.toContain("For the platform admin");
  });
  it("gives the platform admin the controls and the details, and only them", () => {
    const op = { authorEmail: "ann@example.com", diagnostics: { path: "/s/:id/library", userAgent: "Safari" }, githubIssueNumber: 9, githubIssueUrl: "https://github.com/me/roam/issues/9", githubError: null, serverId: null };
    const html = renderToStaticMarkup(<FeedbackThread backHref="/b" backLabel="Inbox" item={item({ operator: op })} comments={comments} canWrite operator />);
    expect(html).toContain("For the platform admin");
    expect(html).toContain("ann@example.com");
    expect(html).toContain("Safari");
    expect(html).toContain("Issue #9");
    expect(html).toContain("Reply as Roam team");
    for (const s of ["New", "Planned", "In progress", "Done", "Not planned", "Duplicate"]) expect(html).toContain(`>${s}</option>`);
  });
});
