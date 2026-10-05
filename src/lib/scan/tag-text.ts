/**
 * Cleaning text that came out of a file's own tags before it is stored or shown. Tags are written by
 * anyone, so: lone surrogates are replaced (a half of an emoji left by cutting at a fixed length would
 * make the database reject the value and cost the file its title and cover), control characters,
 * zero-width characters and text-direction overrides (which can make one name look like another) become
 * spaces, whitespace is collapsed, and the result is cut by whole characters.
 */
const HIDDEN = new RegExp(
  "[" +
    "\\u0000-\\u001f\\u007f-\\u009f" + // control characters, C1 controls
    "\\u00ad\\u061c\\u180e" + // soft hyphen, Arabic letter mark, Mongolian vowel separator
    "\\u200b-\\u200f" + // zero-width characters and left/right marks
    "\\u2028\\u2029" + // line and paragraph separators
    "\\u202a-\\u202e" + // text-direction embeddings and overrides
    "\\u2060-\\u206f" + // word joiner, invisible operators, direction isolates
    "\\ufeff\\ufff9-\\ufffb" + // byte-order mark, interlinear annotation
    "]+",
  "g"
);

export function cleanTagString(text: string, max: number): string | null {
  const t = text.toWellFormed().replace(HIDDEN, " ").replace(/\s+/g, " ").trim();
  if (!t) return null;
  const chars = Array.from(t);
  return chars.length > max ? chars.slice(0, max).join("").trim() : t;
}
