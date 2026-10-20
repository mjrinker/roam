/**
 * A scan's `errors` list also carries plain notices: files left out on purpose (a format Roam can't play, a file that already belongs to another
 * library). Those are not failures, so they are shown apart and never count as a problem with the library.
 */
export const isScanNotice = (message: string): boolean => /skipped: unsupported format|(?:was|were) skipped\.$/.test(message);

export function splitScanMessages(messages: readonly string[]): { errors: string[]; notices: string[] } {
  return { errors: messages.filter((m) => !isScanNotice(m)), notices: messages.filter(isScanNotice) };
}
