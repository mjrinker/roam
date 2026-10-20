/**
 * Keeping a GitHub issue for each report, when the deployment is set up for it (GITHUB_FEEDBACK_TOKEN, a fine-grained token with "Issues: read
 * and write" on one repository, and GITHUB_FEEDBACK_REPO, "owner/name"). Only the report's own words and anonymised details are sent (see
 * issueBody); closing a report on the board closes its issue, and reopening it reopens it. Nothing here ever throws into a request: callers get
 * the failure back to store.
 */
import { isClosedStatus, issueBody, issueLabels, issueTitle, type Diagnostics, type FeedbackKind, type FeedbackStatus } from "@/lib/feedback/rules";

export interface GithubConfig {
  token: string;
  repo: string;
}

export function githubConfig(env: Record<string, string | undefined> = process.env): GithubConfig | null {
  const token = env.GITHUB_FEEDBACK_TOKEN?.trim();
  const repo = env.GITHUB_FEEDBACK_REPO?.trim();
  if (!token || !repo || !/^[\w.-]+\/[\w.-]+$/.test(repo) || env.GITHUB_FEEDBACK_AUTO === "0") return null;
  return { token, repo };
}

const headers = (c: GithubConfig) => ({ Authorization: `Bearer ${c.token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "Roam-feedback", "Content-Type": "application/json" });

export type GithubResult<T> = { ok: true; value: T } | { ok: false; error: string };

async function call<T>(c: GithubConfig, method: string, path: string, body?: unknown, fetchImpl: typeof fetch = fetch): Promise<GithubResult<T>> {
  try {
    const res = await fetchImpl(`https://api.github.com/repos/${c.repo}${path}`, { method, headers: headers(c), body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return { ok: false, error: `GitHub ${res.status}: ${(await res.text().catch(() => "")).slice(0, 160)}` };
    return { ok: true, value: (await res.json()) as T };
  } catch (err) {
    return { ok: false, error: `GitHub: ${(err as Error).message}`.slice(0, 200) };
  }
}

/** Whether the repository is public (so a report posted there is public), cached for an hour. Null when it can't be found out. */
let publicCache: { at: number; value: boolean | null } | null = null;
export async function repoIsPublic(c: GithubConfig, fetchImpl: typeof fetch = fetch, now = Date.now()): Promise<boolean | null> {
  if (publicCache && now - publicCache.at < 3_600_000) return publicCache.value;
  const r = await call<{ private?: boolean }>(c, "GET", "", undefined, fetchImpl);
  const value = r.ok && typeof r.value.private === "boolean" ? !r.value.private : null;
  publicCache = { at: now, value };
  return value;
}
export const forgetRepoVisibility = () => {
  publicCache = null;
};

export async function createIssue(c: GithubConfig, item: { kind: FeedbackKind; title: string; body: string; diagnostics: Diagnostics | null }, fetchImpl: typeof fetch = fetch): Promise<GithubResult<{ number: number; url: string }>> {
  const r = await call<{ number: number; html_url: string }>(c, "POST", "/issues", { title: issueTitle(item.kind, item.title), body: issueBody(item), labels: issueLabels(item.kind) }, fetchImpl);
  return r.ok ? { ok: true, value: { number: r.value.number, url: r.value.html_url } } : r;
}

/** Closes the issue for a finished, declined or duplicate report, and reopens it for anything else. */
export async function setIssueState(c: GithubConfig, issueNumber: number, status: FeedbackStatus, fetchImpl: typeof fetch = fetch): Promise<GithubResult<null>> {
  const closed = isClosedStatus(status);
  const r = await call<unknown>(c, "PATCH", `/issues/${issueNumber}`, { state: closed ? "closed" : "open", ...(closed ? { state_reason: status === "done" ? "completed" : "not_planned" } : {}) }, fetchImpl);
  return r.ok ? { ok: true, value: null } : r;
}
