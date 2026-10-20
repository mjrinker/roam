import type { StorageProviderKind } from "@/lib/db/schema";

/** How each kind of storage is shown and signed in to. Kinds not listed here are not available yet. */
export interface ProviderInfo {
  kind: StorageProviderKind;
  name: string;
  /** Where the admin goes to sign in; `connectionId` is "new" for another connection, or an existing one to sign in again. */
  connectHref(serverId: string, connectionId: string | "new", label: string, opts?: { write?: boolean }): string;
}

const q = (params: Record<string, string>) => new URLSearchParams(params).toString();

export const PROVIDERS: ProviderInfo[] = [
  {
    kind: "box",
    name: "Box",
    connectHref: (serverId, connectionId, label) => `/api/box/connect?${q({ serverId, connectionId, label })}`,
  },
  {
    kind: "dropbox",
    name: "Dropbox",
    connectHref: (serverId, connectionId, label, opts) => `/api/dropbox/connect?${q({ serverId, connectionId, label, ...(opts?.write ? { write: "1" } : {}) })}`,
  },
  {
    kind: "onedrive",
    name: "OneDrive",
    connectHref: (serverId, connectionId, label, opts) => `/api/onedrive/connect?${q({ serverId, connectionId, label, ...(opts?.write ? { write: "1" } : {}) })}`,
  },
  {
    kind: "gdrive",
    name: "Google Drive",
    connectHref: (serverId, connectionId, label, opts) => `/api/google/connect?${q({ serverId, connectionId, label, ...(opts?.write ? { write: "1" } : {}) })}`,
  },
];

export const providerInfo = (kind: StorageProviderKind): ProviderInfo | undefined => PROVIDERS.find((p) => p.kind === kind);
export const providerName = (kind: StorageProviderKind): string => providerInfo(kind)?.name ?? kind;
