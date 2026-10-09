/** Working out what to save for a download: the files' addresses (which are short-lived, so they can be asked for again) and what to keep beside them. Browser only. */
import { unsupportedCodecsParam } from "@/lib/player/codec-query";
import type { AudiobookManifest, PlayManifest } from "@/lib/player/types";
import type { DownloadOption, DownloadOptions } from "./options";
import { downloadId, type DownloadRecord } from "./types";

export class PlanError extends Error {}

async function getJson<T>(url: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { cache: "no-store" });
  } catch {
    throw new PlanError("Couldn't reach the server.");
  }
  if (res.status === 429) throw new PlanError("The demo has reached today's play limit. Try again tomorrow.");
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new PlanError(typeof body.error === "string" ? body.error : "This can't be downloaded right now.");
  }
  return (await res.json()) as T;
}

function videoUrl(ownerKind: string, ownerId: string, version: string): string {
  const params = new URLSearchParams(unsupportedCodecsParam());
  params.set("version", version);
  return `/api/play/${ownerKind}/${ownerId}?${params.toString()}`;
}

/** The addresses of a record's files, in order, freshly asked for (the old ones expire). */
export async function fetchFileUrls(record: Pick<DownloadRecord, "kind" | "ownerKind" | "ownerId" | "version" | "files">): Promise<string[]> {
  if (record.kind === "watch") {
    const m = await getJson<PlayManifest>(videoUrl(record.ownerKind, record.ownerId, record.version));
    if (m.segments.length !== record.files.length) throw new PlanError("This video has changed since the download started. Remove it and download it again.");
    return m.segments.map((s) => s.url);
  }
  const m = await getJson<AudiobookManifest>(`/api/audiobooks/${record.ownerId}/manifest`);
  const byIndex = new Map(m.urls.map((u) => [u.index, u.url]));
  const urls: string[] = [];
  for (let i = 0; i < record.files.length; i++) {
    urls.push(byIndex.get(i) ?? (await getJson<{ url: string }>(`/api/audiobooks/${record.ownerId}/segments/${i}`)).url);
  }
  return urls;
}

/** A picture to keep (best effort: a download without one is fine). Goes through the app's own image address so it is same-origin. */
async function fetchPoster(posterUrl: string | null): Promise<Blob | null> {
  if (!posterUrl) return null;
  const src = posterUrl.startsWith("http") ? `/_next/image?url=${encodeURIComponent(posterUrl)}&w=384&q=75` : posterUrl;
  try {
    const res = await fetch(src);
    return res.ok ? await res.blob() : null;
  } catch {
    return null;
  }
}

function withoutKey<T extends object, K extends keyof T>(value: T, key: K): Omit<T, K> {
  const copy = { ...value };
  delete copy[key];
  return copy;
}

const fileName = (id: string, index: number, container = "mp4") => `${id.replace(/[^a-zA-Z0-9-]/g, "_")}-${index}.${container}`;

export interface Plan {
  record: DownloadRecord;
  urls: string[];
}

/** Everything needed to begin: the record to keep and the files' first addresses. */
export async function planDownload(serverId: string, options: DownloadOptions, choice: DownloadOption): Promise<Plan> {
  const id = downloadId(options.kind, options.ownerKind, options.ownerId, choice.label);
  const base = {
    id,
    kind: options.kind,
    ownerKind: options.ownerKind,
    ownerId: options.ownerId,
    serverId,
    title: options.title,
    subtitle: options.subtitle,
    version: choice.label,
    versionName: choice.name,
    status: "downloading" as const,
    error: null,
    createdAt: Date.now(),
    completedAt: null,
  };
  if (options.kind === "watch") {
    const m = await getJson<PlayManifest>(videoUrl(options.ownerKind, options.ownerId, choice.label));
    const files = m.segments.map((s, i) => ({ name: fileName(id, i), bytes: 0, expected: s.sizeBytes ?? null, done: false }));
    const expectedTotal = files.every((f) => f.expected !== null) ? files.reduce((n, f) => n + (f.expected ?? 0), 0) : choice.sizeBytes;
    return {
      record: {
        ...base,
        poster: await fetchPoster(options.posterUrl),
        totalBytes: expectedTotal,
        files,
        timeline: { durationSeconds: m.durationSeconds, segments: m.segments.map((s) => withoutKey(s, "url")), libraryId: m.libraryId, defaultRate: m.defaultRate },
        book: null,
      },
      urls: m.segments.map((s) => s.url),
    };
  }
  const m = await getJson<AudiobookManifest>(`/api/audiobooks/${options.ownerId}/manifest`);
  const audio = withoutKey(withoutKey(m, "urls"), "resumeSeconds");
  const files = m.segments.map((_s, i) => ({ name: fileName(id, i, "m4a"), bytes: 0, expected: null, done: false }));
  const plan: Plan = {
    record: { ...base, poster: await fetchPoster(m.coverUrl ?? options.posterUrl), totalBytes: choice.sizeBytes, files, timeline: null, book: audio },
    urls: [],
  };
  plan.urls = await fetchFileUrls(plan.record);
  return plan;
}
