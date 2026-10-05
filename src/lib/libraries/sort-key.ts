/**
 * The key a folder is listed in: the file name lowercased with every run of digits in the NAME
 * zero-padded (the extension is left alone: ".mp4" is not a number), so "Track 2" sorts before
 * "Track 10" and "01 - Intro" stays where its number puts it, under any database collation. (The title
 * shown can come from the file's tags and has lost the numbering.)
 */
export function naturalSortKey(fileName: string): string {
  const name = fileName.normalize("NFC").toLowerCase();
  const dot = name.lastIndexOf(".");
  const hasExtension = dot > 0 && name.length - dot <= 6 && /^[a-z0-9]+$/.test(name.slice(dot + 1));
  const base = hasExtension ? name.slice(0, dot) : name;
  const padded = base.replace(/\d+/g, (run) => (run.length >= 12 ? run : run.padStart(12, "0")));
  return hasExtension ? padded + name.slice(dot) : padded;
}
