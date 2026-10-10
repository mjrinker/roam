/** Reading genres out of audio tags: ID3's numbered genres, "(17)Rock" references, and several genres in one field. Pure. */
import { cleanTagString } from "@/lib/scan/tag-text";

/** ID3v1's 80 standard genres (index 0-79), then the Winamp extensions that taggers also write (80-125). */
const ID3_GENRES = [
  "Blues", "Classic Rock", "Country", "Dance", "Disco", "Funk", "Grunge", "Hip-Hop", "Jazz", "Metal", "New Age", "Oldies", "Other", "Pop", "R&B", "Rap", "Reggae", "Rock", "Techno", "Industrial",
  "Alternative", "Ska", "Death Metal", "Pranks", "Soundtrack", "Euro-Techno", "Ambient", "Trip-Hop", "Vocal", "Jazz+Funk", "Fusion", "Trance", "Classical", "Instrumental", "Acid", "House", "Game", "Sound Clip", "Gospel", "Noise",
  "Alternative Rock", "Bass", "Soul", "Punk", "Space", "Meditative", "Instrumental Pop", "Instrumental Rock", "Ethnic", "Gothic", "Darkwave", "Techno-Industrial", "Electronic", "Pop-Folk", "Eurodance", "Dream", "Southern Rock", "Comedy", "Cult", "Gangsta",
  "Top 40", "Christian Rap", "Pop/Funk", "Jungle", "Native American", "Cabaret", "New Wave", "Psychedelic", "Rave", "Showtunes", "Trailer", "Lo-Fi", "Tribal", "Acid Punk", "Acid Jazz", "Polka", "Retro", "Musical", "Rock & Roll", "Hard Rock",
  "Folk", "Folk-Rock", "National Folk", "Swing", "Fast Fusion", "Bebob", "Latin", "Revival", "Celtic", "Bluegrass", "Avantgarde", "Gothic Rock", "Progressive Rock", "Psychedelic Rock", "Symphonic Rock", "Slow Rock", "Big Band", "Chorus", "Easy Listening", "Acoustic",
  "Humour", "Speech", "Chanson", "Opera", "Chamber Music", "Sonata", "Symphony", "Booty Bass", "Primus", "Porn Groove", "Satire", "Slow Jam", "Club", "Tango", "Samba", "Folklore", "Ballad", "Power Ballad", "Rhythmic Soul", "Freestyle",
  "Duet", "Punk Rock", "Drum Solo", "A Cappella", "Euro-House", "Dance Hall",
] as const;

/** The genre an ID3v1 byte (or a bare number in an ID3v2 field) names, or null for a number with no known genre. */
export function genreFromIndex(index: number): string | null {
  return Number.isInteger(index) && index >= 0 && index < ID3_GENRES.length ? ID3_GENRES[index] : null;
}

export const MAX_GENRES = 5;
const MAX_GENRE_LENGTH = 60;

/**
 * Genres from the text fields of a tag, cleaned and without repeats: "(17)" and "17" become "Rock", "(17)Rock" is "Rock", "(RX)"/"(CR)"
 * (remix, cover) are dropped, and a field of several genres separated by ";" is split. Case differences count as the same genre
 * (the first spelling wins). At most MAX_GENRES; nothing recognisable gives an empty list.
 */
export function normalizeGenres(raw: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (text: string | null) => {
    const name = text === null ? null : cleanTagString(text, MAX_GENRE_LENGTH);
    if (!name) return;
    const key = name.toLowerCase();
    if (key === "unknown" || key === "genre" || seen.has(key) || out.length >= MAX_GENRES) return;
    seen.add(key);
    out.push(name);
  };
  for (const field of raw) {
    for (const piece of field.split(";")) {
      let rest = piece.trim();
      // Leading "(17)" references, then any text after them.
      for (let m = /^\((\d{1,3}|RX|CR)\)/.exec(rest); m; m = /^\((\d{1,3}|RX|CR)\)/.exec(rest)) {
        if (/^\d+$/.test(m[1])) add(genreFromIndex(Number(m[1])));
        rest = rest.slice(m[0].length).trim();
      }
      if (/^\d{1,3}$/.test(rest)) add(genreFromIndex(Number(rest)));
      else if (rest) add(rest);
    }
  }
  return out;
}
