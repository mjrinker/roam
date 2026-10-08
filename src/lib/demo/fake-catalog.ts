/**
 * Stand-ins for things that cannot be shipped for real: books by J.R.R. Tolkien (still in copyright) and albums by famous artists.
 * Their names, years and track lists are the real ones, so the library looks and matches like the real thing (MusicBrainz even supplies
 * the covers); what is inside the files is not: the books carry public-domain text, the songs are clips of CC0 piano recordings.
 * The demo banner and the credits page say so. The same idea as the demo's movies, which play openly licensed footage.
 */
import { safeFileName } from "@/lib/demo/open-sources";

// ── Tolkien ──────────────────────────────────────────────────────────────

export interface TolkienBook {
  title: string;
  /** First published. */
  year: number;
  series?: { name: string; position: number };
}

const LOTR = "The Lord of the Rings";
const HOME = "The History of Middle-earth";

export const TOLKIEN_BOOKS: TolkienBook[] = [
  { title: "The Hobbit", year: 1937 },
  { title: "The Fellowship of the Ring", year: 1954, series: { name: LOTR, position: 1 } },
  { title: "The Two Towers", year: 1954, series: { name: LOTR, position: 2 } },
  { title: "The Return of the King", year: 1955, series: { name: LOTR, position: 3 } },
  { title: "The Lord of the Rings", year: 1954 },
  { title: "The Silmarillion", year: 1977 },
  { title: "Unfinished Tales of Númenor and Middle-earth", year: 1980 },
  { title: "The Adventures of Tom Bombadil", year: 1962 },
  { title: "Farmer Giles of Ham", year: 1949 },
  { title: "Smith of Wootton Major", year: 1967 },
  { title: "Leaf by Niggle", year: 1945 },
  { title: "The Homecoming of Beorhtnoth", year: 1953 },
  { title: "Roverandom", year: 1998 },
  { title: "Mr. Bliss", year: 1982 },
  { title: "The Father Christmas Letters", year: 1976 },
  { title: "The Letters of J.R.R. Tolkien", year: 1981 },
  { title: "The Monsters and the Critics, and Other Essays", year: 1983 },
  { title: "Tolkien On Fairy-Stories", year: 2008 },
  { title: "Finn and Hengest", year: 1982 },
  { title: "Sir Gawain and the Green Knight, Pearl and Sir Orfeo", year: 1975 },
  { title: "The Legend of Sigurd and Gudrún", year: 2009 },
  { title: "The Story of Kullervo", year: 2010 },
  { title: "The Children of Húrin", year: 2007 },
  { title: "The Fall of Arthur", year: 2013 },
  { title: "Beowulf: A Translation and Commentary", year: 2014 },
  { title: "Beren and Lúthien", year: 2017 },
  { title: "The Fall of Gondolin", year: 2018 },
  { title: "The Nature of Middle-earth", year: 2021 },
  { title: "The Fall of Númenor", year: 2022 },
  { title: "The Book of Lost Tales, Part One", year: 1983, series: { name: HOME, position: 1 } },
  { title: "The Book of Lost Tales, Part Two", year: 1984, series: { name: HOME, position: 2 } },
  { title: "The Lays of Beleriand", year: 1985, series: { name: HOME, position: 3 } },
  { title: "The Shaping of Middle-earth", year: 1986, series: { name: HOME, position: 4 } },
  { title: "The Lost Road and Other Writings", year: 1987, series: { name: HOME, position: 5 } },
  { title: "The Return of the Shadow", year: 1988, series: { name: HOME, position: 6 } },
  { title: "The Treason of Isengard", year: 1989, series: { name: HOME, position: 7 } },
  { title: "The War of the Ring", year: 1990, series: { name: HOME, position: 8 } },
  { title: "Sauron Defeated", year: 1992, series: { name: HOME, position: 9 } },
  { title: "Morgoth's Ring", year: 1993, series: { name: HOME, position: 10 } },
  { title: "The War of the Jewels", year: 1994, series: { name: HOME, position: 11 } },
  { title: "The Peoples of Middle-earth", year: 1996, series: { name: HOME, position: 12 } },
];

export const TOLKIEN = "J.R.R. Tolkien";

/** "J.R.R. Tolkien / [Series /] Title.epub": a series gets its own folder. */
export const tolkienPath = (b: TolkienBook): { folders: string[]; fileName: string } => ({
  folders: [safeFileName(TOLKIEN), ...(b.series ? [safeFileName(b.series.name)] : [])],
  fileName: `${safeFileName(b.series ? `${String(b.series.position).padStart(2, "0")} - ${b.title}` : b.title)}.epub`,
});

// ── Albums ───────────────────────────────────────────────────────────────

export interface FakeAlbum {
  artist: string;
  album: string;
  year: number;
  tracks: string[];
}

export const FAKE_ALBUMS: FakeAlbum[] = [
  { artist: "The Beatles", album: "Abbey Road", year: 1969, tracks: ["Come Together", "Something", "Maxwell's Silver Hammer", "Oh! Darling", "Octopus's Garden", "I Want You (She's So Heavy)", "Here Comes the Sun", "Because", "You Never Give Me Your Money", "Sun King", "Mean Mr. Mustard", "Polythene Pam", "She Came In Through the Bathroom Window", "Golden Slumbers", "Carry That Weight", "The End", "Her Majesty"] },
  { artist: "Pink Floyd", album: "The Dark Side of the Moon", year: 1973, tracks: ["Speak to Me", "Breathe (In the Air)", "On the Run", "Time", "The Great Gig in the Sky", "Money", "Us and Them", "Any Colour You Like", "Brain Damage", "Eclipse"] },
  { artist: "Michael Jackson", album: "Thriller", year: 1982, tracks: ["Wanna Be Startin' Somethin'", "Baby Be Mine", "The Girl Is Mine", "Thriller", "Beat It", "Billie Jean", "Human Nature", "P.Y.T. (Pretty Young Thing)", "The Lady in My Life"] },
  { artist: "Fleetwood Mac", album: "Rumours", year: 1977, tracks: ["Second Hand News", "Dreams", "Never Going Back Again", "Don't Stop", "Go Your Own Way", "Songbird", "The Chain", "You Make Loving Fun", "I Don't Want to Know", "Oh Daddy", "Gold Dust Woman"] },
  { artist: "Nirvana", album: "Nevermind", year: 1991, tracks: ["Smells Like Teen Spirit", "In Bloom", "Come as You Are", "Breed", "Lithium", "Polly", "Territorial Pissings", "Drain You", "Lounge Act", "Stay Away", "On a Plain", "Something in the Way"] },
  { artist: "Daft Punk", album: "Discovery", year: 2001, tracks: ["One More Time", "Aerodynamic", "Digital Love", "Harder, Better, Faster, Stronger", "Crescendolls", "Nightvision", "Superheroes", "High Life", "Something About Us", "Voyager", "Veridis Quo", "Short Circuit", "Face to Face", "Too Long"] },
  { artist: "Radiohead", album: "OK Computer", year: 1997, tracks: ["Airbag", "Paranoid Android", "Subterranean Homesick Alien", "Exit Music (For a Film)", "Let Down", "Karma Police", "Fitter Happier", "Electioneering", "Climbing Up the Walls", "No Surprises", "Lucky", "The Tourist"] },
  { artist: "Queen", album: "A Night at the Opera", year: 1975, tracks: ["Death on Two Legs (Dedicated to...)", "Lazing on a Sunday Afternoon", "I'm in Love with My Car", "You're My Best Friend", "'39", "Sweet Lady", "Seaside Rendezvous", "The Prophet's Song", "Love of My Life", "Good Company", "Bohemian Rhapsody", "God Save the Queen"] },
  { artist: "Miles Davis", album: "Kind of Blue", year: 1959, tracks: ["So What", "Freddie Freeloader", "Blue in Green", "All Blues", "Flamenco Sketches"] },
  { artist: "Led Zeppelin", album: "Led Zeppelin IV", year: 1971, tracks: ["Black Dog", "Rock and Roll", "The Battle of Evermore", "Stairway to Heaven", "Misty Mountain Hop", "Four Sticks", "Going to California", "When the Levee Breaks"] },
  { artist: "Adele", album: "21", year: 2011, tracks: ["Rolling in the Deep", "Rumour Has It", "Turning Tables", "Don't You Remember", "Set Fire to the Rain", "He Won't Go", "Take It All", "I'll Be Waiting", "One and Only", "Lovesong", "Someone Like You"] },
];

export const CLIP_SECONDS = 40;
const FIRST_OFFSET = 15;
const CLIP_GAP = 5;

export interface SourceAudio {
  file: string;
  seconds: number;
}

export interface PlannedClip {
  artist: string;
  album: string;
  year: number;
  track: number;
  title: string;
  folders: string[];
  fileName: string;
  sourceFile: string;
  startSeconds: number;
  durationSeconds: number;
}

/**
 * Gives every song its own stretch of one of the source recordings: the sources in turn, each cut into back-to-back clips, so no two
 * songs play the same moment of the same recording. Throws if the sources can't hold them all.
 */
export function planFakeMusic(albums: FakeAlbum[] = FAKE_ALBUMS, sources: SourceAudio[]): PlannedClip[] {
  const usable = [...sources].filter((s) => s.seconds >= FIRST_OFFSET + CLIP_SECONDS + CLIP_GAP).sort((a, b) => b.seconds - a.seconds || a.file.localeCompare(b.file));
  const next = new Map<string, number>(usable.map((s) => [s.file, FIRST_OFFSET]));
  let turn = 0;
  const take = () => {
    for (let tries = 0; tries < usable.length; tries++) {
      const s = usable[turn++ % usable.length];
      const start = next.get(s.file)!;
      if (start + CLIP_SECONDS + CLIP_GAP <= s.seconds) {
        next.set(s.file, start + CLIP_SECONDS + CLIP_GAP);
        return { file: s.file, start };
      }
    }
    throw new Error("The source recordings don't hold enough audio for every song.");
  };
  return albums.flatMap((a) =>
    a.tracks.map((title, i) => {
      const clip = take();
      return {
        artist: a.artist, album: a.album, year: a.year, track: i + 1, title,
        folders: [safeFileName(a.artist), safeFileName(a.album)],
        fileName: `${String(i + 1).padStart(2, "0")} - ${safeFileName(title)}.mp3`,
        sourceFile: clip.file, startSeconds: clip.start, durationSeconds: CLIP_SECONDS,
      };
    })
  );
}
