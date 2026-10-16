/**
 * Whether a title has something to play: a movie or an audiobook with a file, a show with at least one episode that has one. A title
 * without (scanned from an empty folder, its files since removed, or known only from its metadata) is left out of every list, search and
 * row; its own page still opens by its address and says there is nothing to play yet. Other kinds (photos, books) are not judged here.
 *
 * Written as SQL on a title's id and kind columns (pass the possibly-aliased columns) so it works in any query that selects from `titles`.
 */
import { sql, type SQL, type SQLWrapper } from "drizzle-orm";

export function hasPlayableFile(id: SQLWrapper, kind: SQLWrapper): SQL {
  return sql`(${kind} NOT IN ('movie', 'show', 'audiobook')
    OR (${kind} = 'show' AND EXISTS (SELECT 1 FROM seasons pls JOIN episodes ple ON ple.season_id = pls.id JOIN media_files plf ON plf.owner_kind = 'episode' AND plf.owner_id = ple.id WHERE pls.title_id = ${id}))
    OR (${kind} <> 'show' AND EXISTS (SELECT 1 FROM media_files plf WHERE plf.owner_kind = 'title' AND plf.owner_id = ${id})))`;
}
