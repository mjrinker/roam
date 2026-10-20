/** The rules of bug reports and feature requests, with nothing that needs the database or the network. */

export const FEEDBACK_KINDS = ["bug", "feature"] as const;
export type FeedbackKind = (typeof FEEDBACK_KINDS)[number];
export const FEEDBACK_STATUSES = ["new", "planned", "in_progress", "done", "declined", "duplicate"] as const;
export type FeedbackStatus = (typeof FEEDBACK_STATUSES)[number];
export type FeedbackVisibility = "private" | "public";

export const STATUS_LABEL: Record<FeedbackStatus, string> = {
  new: "New",
  planned: "Planned",
  in_progress: "In progress",
  done: "Done",
  declined: "Not planned",
  duplicate: "Duplicate",
};

export const MAX_TITLE = 120;
export const MIN_TITLE = 4;
export const MAX_BODY = 4000;
export const MAX_COMMENT = 1500;
/** Reports one account may send in a day, and comments. */
export const MAX_REPORTS_PER_DAY = 10;
export const MAX_COMMENTS_PER_DAY = 40;

/** Collapses spaces and drops control characters from a single line. */
export const cleanLine = (text: unknown, max: number): string =>
  (typeof text === "string" ? text : "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max).trim();

/** Keeps line breaks (at most one blank line in a row), drops other control characters. */
export const cleanText = (text: unknown, max: number): string =>
  (typeof text === "string" ? text : "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, max)
    .trim();

/** What a request looks like to the rest of the board: a new request is public unless its author chose otherwise, a bug is private until the admin says. */
export const defaultVisibility = (kind: FeedbackKind, keepPrivate: boolean): FeedbackVisibility => (kind === "feature" && !keepPrivate ? "public" : "private");

/** Statuses the admin sets that close the matching GitHub issue (and reopen it when set back). */
export const isClosedStatus = (s: FeedbackStatus): boolean => s === "done" || s === "declined" || s === "duplicate";

// ── What the author can send along ────────────────────────────────────────

export type Diagnostics = Record<string, string | number | boolean | null>;

const DIAGNOSTIC_KEYS: Record<string, "string" | "number" | "boolean"> = { path: "string", userAgent: "string", viewport: "string", standalone: "boolean", locale: "string", appVersion: "string", online: "boolean" };

/** A page address with the ids and the query taken out ("/s/<id>/title/<id>?x=1" becomes "/s/:id/title/:id"), so no one's server or title is named. */
export function anonymousPath(path: string): string {
  const [pathname] = path.split(/[?#]/);
  return pathname.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ":id").replace(/\/\d{3,}(?=\/|$)/g, "/:id").slice(0, 200);
}

/** Only the known details, of the right type and a sensible length; anything else the browser sent is dropped. */
export function cleanDiagnostics(raw: unknown): Diagnostics | null {
  if (!raw || typeof raw !== "object") return null;
  const out: Diagnostics = {};
  for (const [key, type] of Object.entries(DIAGNOSTIC_KEYS)) {
    const v = (raw as Record<string, unknown>)[key];
    if (typeof v !== type) continue;
    out[key] = type === "string" ? (key === "path" ? anonymousPath(v as string) : cleanLine(v, 300)) : (v as boolean);
  }
  return Object.keys(out).length > 0 ? out : null;
}

// ── GitHub ────────────────────────────────────────────────────────────────

/** The issue's title: the report's own, marked for what it is. */
export const issueTitle = (kind: FeedbackKind, title: string) => `${kind === "bug" ? "Bug" : "Feature request"}: ${title}`.slice(0, 200);

export const issueLabels = (kind: FeedbackKind): string[] => ["roam-feedback", kind === "bug" ? "bug" : "enhancement"];

/**
 * The issue's text: what the person wrote and the (anonymised) technical details they chose to send. Never who they are, which server they are on, or
 * a link into the app that names anything: GitHub may be public, and it keeps what it is sent.
 */
export function issueBody(item: { kind: FeedbackKind; body: string; diagnostics: Diagnostics | null }): string {
  const lines = [item.body, "", "---", `_Sent from Roam by a user (${item.kind === "bug" ? "bug report" : "feature request"})._`];
  const d = item.diagnostics;
  if (d) {
    const detail = [d.path && `Page: \`${d.path}\``, d.appVersion && `Version: \`${d.appVersion}\``, d.userAgent && `Browser: ${String(d.userAgent).replace(/[`<>]/g, "")}`, d.viewport && `Screen: ${d.viewport}`, d.standalone === true ? "Installed app: yes" : null].filter(Boolean);
    if (detail.length > 0) lines.push("", "<details><summary>Technical details</summary>", "", ...detail.map((l) => `- ${l}`), "", "</details>");
  }
  return lines.join("\n");
}
