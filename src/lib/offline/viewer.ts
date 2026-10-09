/**
 * Which "who's watching" profile this browser is signed in as, so downloads and offline progress belong to it: another profile (or
 * account) using the same device doesn't see or play them, and their progress is never sent as someone else's. Browser only.
 */
const KEY = "roam-offline-viewer";

export function currentOfflineViewer(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function setOfflineViewer(viewerId: string | null): void {
  try {
    if (viewerId) localStorage.setItem(KEY, viewerId);
    else localStorage.removeItem(KEY);
  } catch {
    // blocked storage: downloads then belong to nobody and are not listed
  }
}
