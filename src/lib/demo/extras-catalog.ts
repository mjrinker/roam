/**
 * The rest of the public demo's content, beyond the movies and shows: a photo library, music, audiobooks and home
 * videos. Unlike the movies and shows these are NOT stand-ins: the music is the real recordings it says it is, the
 * audiobooks are real public-domain readings of the books they are named for, and the photos are real photographs
 * under their own titles and dates. Every item is accepted only if its source declares it public domain or CC0
 * (see open-sources.ts), and the script records each one's author and source for the credits page.
 */
import { safeFileName } from "@/lib/demo/open-sources";

// ── Photos (Wikimedia Commons, CC0 only) ─────────────────────────────────

export interface PhotoAlbum {
  /** The album (folder) name. */
  album: string;
  /** A Commons search for CC0 candidates. */
  search: string;
  /** How many photos to take from it. */
  take: number;
}

const cc0 = 'incategory:"CC-Zero" filetype:bitmap';
export const PHOTO_ALBUMS: PhotoAlbum[] = [
  { album: "Mountains", search: `${cc0} mountain landscape`, take: 7 },
  { album: "Lakes and Sunsets", search: `${cc0} lake sunset`, take: 7 },
  { album: "City", search: `${cc0} city street architecture`, take: 6 },
  { album: "Wildlife", search: `${cc0} wildlife`, take: 6 },
  { album: "Flowers", search: `${cc0} flower garden`, take: 5 },
];

// ── Music (Musopen's Chopin collection on the Internet Archive, CC0) ──────

export const MUSIC_ITEM = "musopen-chopin";
export const MUSIC_COMPOSER = "Frédéric Chopin";
export const MUSIC_PERFORMER = "Aaron Dunn";

export interface MusicTrack {
  /** The file's name inside the archive item. */
  file: string;
  title: string;
}
export interface MusicAlbum {
  name: string;
  year: number;
  tracks: MusicTrack[];
}

export const MUSIC_ALBUMS: MusicAlbum[] = [
  {
    name: "The Four Ballades",
    year: 2012,
    tracks: [
      { file: "Ballade no. 1 - Op. 23.mp3", title: "Ballade No. 1 in G minor, Op. 23" },
      { file: "Ballade no. 2 - Op. 38.mp3", title: "Ballade No. 2 in F major, Op. 38" },
      { file: "Ballade no. 3 - Op. 47.mp3", title: "Ballade No. 3 in A-flat major, Op. 47" },
      { file: "Ballade no. 4 - Op. 52.mp3", title: "Ballade No. 4 in F minor, Op. 52" },
    ],
  },
  {
    name: "Impromptus",
    year: 2012,
    tracks: [
      { file: "Impromptu no. 1 - Op. 29.mp3", title: "Impromptu No. 1 in A-flat major, Op. 29" },
      { file: "Impromptu no. 2 - Op. 36.mp3", title: "Impromptu No. 2 in F-sharp major, Op. 36" },
      { file: "Impromptu no. 3 - Op. 51.mp3", title: "Impromptu No. 3 in G-flat major, Op. 51" },
      { file: "Fantasie Impromptu Op. 66.mp3", title: "Fantaisie-Impromptu in C-sharp minor, Op. 66" },
    ],
  },
  {
    name: "Waltzes and Showpieces",
    year: 2012,
    tracks: [
      { file: "Grande Valse Brilliante Op.18 In E flat major.mp3", title: "Grande Valse brillante in E-flat major, Op. 18" },
      { file: "Allegro de Concert Op. 46 in A Major.mp3", title: "Allegro de concert in A major, Op. 46" },
      { file: "Fantasy Op. 49 in F minor.mp3", title: "Fantasy in F minor, Op. 49" },
      { file: "Canon in F minor.mp3", title: "Canon in F minor" },
    ],
  },
];

export interface PlannedTrack {
  folders: string[];
  fileName: string;
  sourceFile: string;
  tags: { title: string; artist: string; album: string; track: number; date: string; comment: string };
}

/** Every music file: Frédéric Chopin / album / "01 - Title.mp3", tagged so the library shows the composer, the album and the order. */
export function planMusic(albums: MusicAlbum[] = MUSIC_ALBUMS): PlannedTrack[] {
  return albums.flatMap((album) =>
    album.tracks.map((t, i) => ({
      folders: [MUSIC_COMPOSER, album.name],
      fileName: `${String(i + 1).padStart(2, "0")} - ${safeFileName(t.title)}.mp3`,
      sourceFile: t.file,
      tags: { title: t.title, artist: MUSIC_COMPOSER, album: album.name, track: i + 1, date: String(album.year), comment: `Performed by ${MUSIC_PERFORMER}. Musopen, CC0.` },
    }))
  );
}

// ── Audiobooks (LibriVox recordings on the Internet Archive, public domain) ──

export interface AudiobookSpec {
  /** The Internet Archive item. */
  item: string;
  author: string;
  title: string;
  year: number;
  /** How many of the first chapter files to take. */
  chapters: number;
}

export const AUDIOBOOKS: AudiobookSpec[] = [
  { item: "alices_adventures_1003", author: "Lewis Carroll", title: "Alice's Adventures in Wonderland", year: 1865, chapters: 3 },
  { item: "frankenstein_cs_librivox", author: "Mary Shelley", title: "Frankenstein", year: 1818, chapters: 3 },
  { item: "pride_and_prejudice_librivox", author: "Jane Austen", title: "Pride and Prejudice", year: 1813, chapters: 3 },
  { item: "dracula_librivox", author: "Bram Stoker", title: "Dracula", year: 1897, chapters: 2 },
  { item: "adventures_holmes", author: "Arthur Conan Doyle", title: "The Adventures of Sherlock Holmes", year: 1892, chapters: 1 },
];

/** "Author / Title (Year) /" in the layout Roam scans for audiobooks. */
export const audiobookFolders = (b: AudiobookSpec): string[] => [safeFileName(b.author), safeFileName(`${b.title} (${b.year})`)];

/** A chapter's file name: "01 - Down the Rabbit Hole.mp3" from its archive title (which may already begin with its own number, dropped so it isn't doubled). */
export function chapterFileName(index: number, archiveTitle: string | null | undefined, fallback: string): string {
  const cleaned = safeFileName((archiveTitle ?? "").replace(/^\s*\d+\s*[-–.:]?\s*/, "")) || safeFileName(fallback);
  return `${String(index + 1).padStart(2, "0")} - ${cleaned}.mp3`;
}
