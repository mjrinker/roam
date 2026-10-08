/** Small pure rules for the in-browser reader. */

/** Books bigger than this are offered as a download instead of being read in the page (the whole file is held in memory, several times over once it is opened, so the limit is kept well below what a phone can take). */
export const MAX_READER_BYTES = 50 * 1024 * 1024;

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

/**
 * What a book's pages may load. The reader draws a book in a sandboxed frame with scripts off; this also stops the book
 * fetching anything from the internet (a tracking image, a remote stylesheet), so opening one tells nobody anything.
 * Pictures, styles and fonts that come out of the book itself are served as blob: and data: addresses.
 */
export const BOOK_CSP = "default-src 'none'; img-src blob: data:; style-src 'unsafe-inline' blob: data:; font-src blob: data:; media-src blob: data:";

/** Whether a key press came from a control that uses the arrow keys itself (a menu, a text field), and so must not turn the page. */
export function keyBelongsToControl(target: { tagName?: string; isContentEditable?: boolean } | null): boolean {
  const tag = (target?.tagName ?? "").toUpperCase();
  return tag === "SELECT" || tag === "INPUT" || tag === "TEXTAREA" || tag === "BUTTON" || tag === "A" || !!target?.isContentEditable;
}

/**
 * The page's HTML with the policy as the very first thing in its head, so it applies before anything in the page is
 * requested (adding it to a page that is already loaded is too late: its pictures are already on their way).
 */
export function withBookCsp(html: string): string {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${BOOK_CSP}"/>`;
  if (/<head[\s>]/i.test(html)) return html.replace(/<head(\s[^>]*)?>/i, (open) => open + meta);
  if (/<html[\s>]/i.test(html)) return html.replace(/<html(\s[^>]*)?>/i, (open) => `${open}<head>${meta}</head>`);
  return `<head>${meta}</head>${html}`;
}
