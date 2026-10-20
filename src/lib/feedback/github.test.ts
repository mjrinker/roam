import { describe, expect, it } from "vitest";
import { createIssue, forgetRepoVisibility, githubConfig, repoIsPublic, setIssueState } from "./github";

const cfg = { token: "tok", repo: "me/roam" };
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe("GitHub is optional", () => {
  it("is on only with a token and a repository written owner/name, and can be switched off", () => {
    expect(githubConfig({})).toBeNull();
    expect(githubConfig({ GITHUB_FEEDBACK_TOKEN: "t" })).toBeNull();
    expect(githubConfig({ GITHUB_FEEDBACK_TOKEN: "t", GITHUB_FEEDBACK_REPO: "nope" })).toBeNull();
    expect(githubConfig({ GITHUB_FEEDBACK_TOKEN: "t", GITHUB_FEEDBACK_REPO: "me/roam" })).toEqual({ token: "t", repo: "me/roam" });
    expect(githubConfig({ GITHUB_FEEDBACK_TOKEN: "t", GITHUB_FEEDBACK_REPO: "me/roam", GITHUB_FEEDBACK_AUTO: "0" })).toBeNull();
  });
});

describe("the issue calls", () => {
  it("creates an issue with the title, body and labels, and returns its number and address", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => (seen.push({ url, init }), reply({ number: 12, html_url: "https://github.com/me/roam/issues/12" }))) as unknown as typeof fetch;
    const r = await createIssue(cfg, { kind: "feature", title: "Dark mode", body: "Please", diagnostics: null }, fetchImpl);
    expect(r).toEqual({ ok: true, value: { number: 12, url: "https://github.com/me/roam/issues/12" } });
    expect(seen[0].url).toBe("https://api.github.com/repos/me/roam/issues");
    expect((seen[0].init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
    expect(JSON.parse(String(seen[0].init.body))).toMatchObject({ title: "Feature request: Dark mode", labels: ["roam-feedback", "enhancement"] });
  });
  it("closes the issue for a finished report (as completed) or a declined one (not planned), and reopens it otherwise", async () => {
    const bodies: unknown[] = [];
    const fetchImpl = (async (_u: string, init: RequestInit) => (bodies.push(JSON.parse(String(init.body))), reply({}))) as unknown as typeof fetch;
    await setIssueState(cfg, 5, "done", fetchImpl);
    await setIssueState(cfg, 5, "declined", fetchImpl);
    await setIssueState(cfg, 5, "planned", fetchImpl);
    expect(bodies).toEqual([{ state: "closed", state_reason: "completed" }, { state: "closed", state_reason: "not_planned" }, { state: "open" }]);
  });
  it("gives the failure back instead of throwing", async () => {
    const down = (async () => reply({ message: "Bad credentials" }, 401)) as unknown as typeof fetch;
    const r = await createIssue(cfg, { kind: "bug", title: "x", body: "y", diagnostics: null }, down);
    expect(r).toMatchObject({ ok: false });
    expect(!r.ok && r.error).toContain("401");
    const broken = (async () => {
      throw new Error("network");
    }) as unknown as typeof fetch;
    expect(await setIssueState(cfg, 1, "done", broken)).toMatchObject({ ok: false });
  });
  it("tells whether the repository is public, remembering it for an hour", async () => {
    forgetRepoVisibility();
    let calls = 0;
    const fetchImpl = (async () => (calls++, reply({ private: false }))) as unknown as typeof fetch;
    expect(await repoIsPublic(cfg, fetchImpl, 1000)).toBe(true);
    expect(await repoIsPublic(cfg, fetchImpl, 2000)).toBe(true);
    expect(calls).toBe(1);
    forgetRepoVisibility();
    expect(await repoIsPublic(cfg, (async () => reply({ private: true })) as unknown as typeof fetch)).toBe(false);
    forgetRepoVisibility();
    expect(await repoIsPublic(cfg, (async () => reply({}, 404)) as unknown as typeof fetch)).toBeNull();
    forgetRepoVisibility();
  });
});
