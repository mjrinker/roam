/** Small pure rules for the in-browser reader. */

/** Books bigger than this are offered as a download instead of being read in the page (the whole file is held in memory). */
export const MAX_READER_BYTES = 120 * 1024 * 1024;

export const FONT_SIZES = [80, 90, 100, 110, 125, 150, 175, 200] as const;
export const DEFAULT_FONT_INDEX = 2;

export const clampFontIndex = (i: number): number => (Number.isInteger(i) ? Math.min(Math.max(i, 0), FONT_SIZES.length - 1) : DEFAULT_FONT_INDEX);

/** Where a reader remembers a book's place on this device only (nothing about reading is sent to the server). */
export const placeKey = (viewerId: string, titleId: string) => `roam-read:${viewerId}:${titleId}`;
export const FONT_KEY = "roam-read-font";

/** A saved place is only trusted if it looks like an EPUB CFI ("epubcfi(/6/4!/4/2)"): it comes from storage a page script could have changed. */
export function validCfi(raw: unknown): raw is string {
  return typeof raw === "string" && raw.length <= 2000 && /^epubcfi\([\w/:!@.\[\]^,~=;%-]+\)$/.test(raw);
}
