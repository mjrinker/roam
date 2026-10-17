/** Rules for a label's name, shared by the form and the server. A label belongs to one profile, so two of its own can't be spelled alike. */

export const LABEL_MAX_LENGTH = 40;
/** The most labels one profile can have. */
export const MAX_LABELS = 50;
/** The most labels a smart playlist can ask for at once. */
export const MAX_LABEL_FILTER = 10;

/** A name as it is compared: no case, accents or extra spaces ("Date  night" and "date night" are the same label). */
export function labelNameKey(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** The name tidied (single spaces, trimmed), or an error to show. */
export function checkLabelName(raw: string): { ok: true; name: string } | { ok: false; error: string } {
  const name = raw.replace(/\s+/g, " ").trim();
  if (!name) return { ok: false, error: "Give the label a name." };
  if ([...name].length > LABEL_MAX_LENGTH) return { ok: false, error: `Labels can be up to ${LABEL_MAX_LENGTH} characters.` };
  if (/[\u0000-\u001f\u007f]/.test(name)) return { ok: false, error: "That name has characters a label can't have." };
  return { ok: true, name };
}
