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
 * Dropbox, OneDrive, or this site itself (Google Drive streams through it). Anything else is refused rather than redirected to.
 */
export function isStorageDownloadHost(url: string, appUrl: string | undefined = process.env.NEXT_PUBLIC_APP_URL): boolean {
  if (isBoxHost(url)) return true;
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" || u.username || u.password) return false;
    const host = u.hostname.toLowerCase();
    if (SUFFIXES.some((s) => host === s || host.endsWith(`.${s}`))) return true;
    const own = appUrl ? new URL(appUrl).hostname.toLowerCase() : null;
    return own !== null && host === own;
  } catch {
    return false;
  }
}
