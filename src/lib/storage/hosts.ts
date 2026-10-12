import { isBoxHost } from "@/lib/storage/box-representations";

const SUFFIXES = [
  // Dropbox's temporary links
  "dropboxusercontent.com",
  "dropbox.com",
  // OneDrive's pre-authenticated links: personal accounts, and work or school ones on SharePoint
  "microsoftpersonalcontent.com",
  "sharepoint.com",
  "1drv.com",
  "onedrive.com",
];

/**
 * True for a download link a storage provider made that Roam may send a person to: over https, no embedded login, on a host of Box,
 * Dropbox, OneDrive, this site itself or its stream Worker (Google Drive streams through one of those). Anything else is refused rather than redirected to.
 */
export function isStorageDownloadHost(url: string, appUrl: string | undefined = process.env.NEXT_PUBLIC_APP_URL, workerUrl: string | undefined = process.env.STREAM_WORKER_URL): boolean {
  if (isBoxHost(url)) return true;
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" || u.username || u.password) return false;
    const host = u.hostname.toLowerCase();
    if (SUFFIXES.some((s) => host === s || host.endsWith(`.${s}`))) return true;
    const ours = [appUrl, workerUrl].filter((v): v is string => !!v).map((v) => new URL(v).hostname.toLowerCase());
    return ours.includes(host);
  } catch {
    return false;
  }
}
