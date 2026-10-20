import type { Metadata } from "next";
import Link from "next/link";
import { BrandLogo } from "@/components/shell/brand";

export const metadata: Metadata = { title: "Naming and organizing your files" };

/** A folder tree or a list of file names, set in a fixed-width box. */
function Tree({ children }: { children: string }) {
  return <pre className="overflow-x-auto rounded-xl bg-white/[0.05] p-4 text-[13px] leading-relaxed ring-1 ring-white/[0.08]">{children.trim()}</pre>;
}

function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section id={id} className="flex scroll-mt-6 flex-col gap-3">
      <h2 className="text-xl font-semibold tracking-tight">{title}</h2>
      {children}
    </section>
  );
}

const Note = ({ children }: { children: React.ReactNode }) => <p className="text-sm text-muted-foreground">{children}</p>;
const Code = ({ children }: { children: React.ReactNode }) => <code className="rounded bg-white/10 px-1.5 py-0.5 text-[13px]">{children}</code>;

/**
 * How to name and arrange files so Roam finds them. Public (no sign-in), written for a phone screen. It follows Plex's naming rules, so a library
 * already set up for Plex works as it is; the examples here are exercised by src/lib/scan/plex-naming.test.ts.
 */
export default function NamingHelpPage() {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-10 px-5 py-10 text-[15px] leading-relaxed text-foreground/90 sm:py-14">
      <Link href="/" aria-label="Roam home" className="self-start">
        <BrandLogo variant="gradient" className="h-10" />
      </Link>
      <header>
        <Link href="/help" className="text-sm text-muted-foreground hover:text-foreground hover:underline">
          ← Help
        </Link>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight sm:text-4xl">Naming and organizing your files</h1>
        <p className="mt-2 text-muted-foreground">
          Roam finds your movies, shows and music by how they are named, the same way Plex does. If your library is already set up for Plex, you can point Roam at it as it is.
        </p>
        <nav aria-label="On this page" className="mt-5">
          <h2 className="text-sm font-medium text-muted-foreground">On this page</h2>
          <ul className="mt-2 flex flex-col gap-1 text-sm">
            {[
            ["basics", "The basics"],
            ["movies", "Movies"],
            ["tv", "TV shows"],
            ["extras", "Trailers and extras"],
            ["subtitles", "Subtitles"],
            ["posters", "Posters"],
            ["music", "Music"],
            ["more", "Photos, videos, books"],
            ["formats", "File types"],
            ].map(([id, label]) => (
              <li key={id}>
                <a href={`#${id}`} className="text-primary hover:underline">
                  {label}
                </a>
              </li>
            ))}
          </ul>
        </nav>
      </header>

      <Section id="basics" title="The basics">
        <ul className="list-disc space-y-1.5 pl-5">
          <li>
            <strong>One kind of thing per library.</strong> Keep movies, TV shows and music in separate folders, and make each its own library. Mixing them confuses matching.
          </li>
          <li>
            <strong>Put the year in brackets after the title:</strong> <Code>Avatar (2009)</Code>. It tells apart films with the same name.
          </li>
          <li>
            <strong>Names don&apos;t have to be perfect.</strong> Roam looks the title up on TMDB. If it picks the wrong one, add an id (below) or an admin can fix the match on the title&apos;s page.
          </li>
          <li>
            <strong>To pin the exact match,</strong> add the TMDB or IMDb id in curly brackets: <Code>{"{tmdb-272}"}</Code> or <Code>{"{imdb-tt0372784}"}</Code>. For shows <Code>{"{tvdb-73244}"}</Code> works too.
          </li>
          <li>After adding files, scan the library (or wait for the next scan). Files appear once Roam has read their length.</li>
        </ul>
      </Section>

      <Section id="movies" title="Movies">
        <p>One folder per movie is best, named like the movie. The file inside is named the same:</p>
        <Tree>{`
Movies/
  Avatar (2009)/
    Avatar (2009).mp4
  Batman Begins (2005) {tmdb-272}/
    Batman Begins (2005) {tmdb-272}.mp4
    Batman Begins (2005).en.srt
    poster.jpg
`}</Tree>
        <p>Movies can also sit loose in the library folder, with no folder each:</p>
        <Tree>{`
Movies/
  Avatar (2009).mp4
  Batman Begins (2005).mp4
`}</Tree>
        <h3 className="font-medium">The same movie in different versions</h3>
        <p>
          Add <Code>- anything</Code> after the year. Each different text is its own version: the player offers them under Quality, and it picks the best one for the screen. Resolution words
          (<Code>1080p</Code>, <Code>4K</Code>, <Code>720p</Code>, <Code>SD</Code>) are shown as sizes.
        </p>
        <Tree>{`
Pulp Fiction (1994)/
  Pulp Fiction (1994) - 1080p.mp4
  Pulp Fiction (1994) - 720p.mp4
  Pulp Fiction (1994) - for the phone.mp4
`}</Tree>
        <h3 className="font-medium">Editions (Director&apos;s Cut, Extended and so on)</h3>
        <p>
          An edition is a different cut of the film, shown as its own title. Put <Code>{"{edition-Name}"}</Code> in the folder name, the file name, or both. Several editions can share one folder, or each can have its own.
        </p>
        <Tree>{`
Movies/
  Blade Runner (1982)/
    Blade Runner (1982).mp4
    Blade Runner (1982) {edition-Director's Cut}.mp4
    Blade Runner (1982) {edition-Final Cut}.mp4
`}</Tree>
        <p>
          A version of an edition keeps its tag: <Code>{"Blade Runner (1982).4k.hevc {edition-Final Cut}.mp4"}</Code>.
        </p>
        <h3 className="font-medium">A movie in several files</h3>
        <p>
          If a movie is split into parts, put the parts in its folder, ending in <Code>- pt1</Code>, <Code>- pt2</Code> (also <Code>cd1</Code>, <Code>disc1</Code>, <Code>disk1</Code>, <Code>dvd1</Code>, <Code>part1</Code>). They play one after another as one movie. All parts should be the same file type.
        </p>
        <Tree>{`
The Dark Knight (2008)/
  The Dark Knight (2008) - pt1.mp4
  The Dark Knight (2008) - pt2.mp4
`}</Tree>
      </Section>

      <Section id="tv" title="TV shows">
        <p>A folder for the show, a folder for each season, and the season and episode number in each file name (<Code>s01e01</Code>):</p>
        <Tree>{`
TV Shows/
  Band of Brothers (2001)/
    Season 01/
      Band of Brothers (2001) - s01e01 - Currahee.mp4
      Band of Brothers (2001) - s01e02 - Day of Days.mp4
  The Office (US) (2005) {tvdb-73244}/
    Season 01/
      The Office (US) - s01e01 - Pilot.mp4
`}</Tree>
        <ul className="list-disc space-y-1.5 pl-5">
          <li>
            <strong>Dashes, dots or spaces</strong> between the parts all work, and so does <Code>1x01</Code>. Anything after the episode number is optional; a title after a dash is used if TMDB has none. Put info you want ignored in <Code>[brackets]</Code>: <Code>Show - s01e01 [1080p Bluray].mp4</Code>.
          </li>
          <li>
            <strong>Use the English word &quot;Season&quot;</strong> for folders, even if your shows are in another language. <Code>Season 1</Code>, <Code>Season 01</Code> and <Code>S01</Code> all work.
          </li>
          <li>
            <strong>Specials</strong> (extras that aired as episodes) go in <Code>Season 00</Code> or <Code>Specials</Code>, numbered <Code>s00e01</Code>.
          </li>
          <li>
            <strong>One file with several episodes:</strong> <Code>Show - s02e18-e19.mp4</Code>. Both episodes appear and play the whole file. Separate files are better when you have them.
          </li>
          <li>
            <strong>An episode in parts:</strong> <Code>Show - s01e01 - pt1.mp4</Code>, <Code>- pt2.mp4</Code>.
          </li>
          <li>
            <strong>Several versions of an episode:</strong> <Code>Show - s01e01 - 1080p.mp4</Code>, <Code>Show - s01e01 - 720p.mp4</Code>.
          </li>
        </ul>
        <h3 className="font-medium">Shows named by date</h3>
        <p>Talk shows and the like are named by the day they aired, as <Code>YYYY-MM-DD</Code> or <Code>DD-MM-YYYY</Code>, with dashes, periods or spaces. Roam matches the date to the episode TMDB lists for that day.</p>
        <Tree>{`
The Colbert Report (2005)/
  Season 08/
    The Colbert Report (2005) - 2011-11-15 - Elijah Wood.mp4
`}</Tree>
        <h3 className="font-medium">When the names are hard to change: a .plexmatch file</h3>
        <p>
          A text file named exactly <Code>.plexmatch</Code> in a show or season folder tells Roam what it holds, without renaming anything. One hint per line, <Code>#</Code> for comments:
        </p>
        <Tree>{`
title: Cool Show
year: 2018
tmdbid: 12345
season: 2
ep: S02E01: The Beginning.mp4
ep: SP01: A Special.mp4
pattern: Part {e} of the story.mp4
`}</Tree>
        <Note>
          Other hints: <Code>tvdbid</Code>, <Code>imdbid</Code>, ranges (<Code>ep: 01-02: both.mp4</Code>), and patterns with <Code>{"{s}"}</Code>, <Code>{"{e}"}</Code>, <Code>{"{sp}"}</Code>, <Code>{"{see}"}</Code> and <Code>*</Code>.
        </Note>
      </Section>

      <Section id="extras" title="Trailers and extras">
        <p>Extras show on the movie&apos;s (or show&apos;s) page. Either end the file name with the type, after a hyphen with no space, or put them in a folder named for the type.</p>
        <Tree>{`
Avatar (2009)/
  Avatar (2009).mp4
  Teaser Trailer-trailer.mp4
  Bar Fight-deleted.mp4
  Sigourney Weaver-interview.mp4
  Behind The Scenes/
    Performance Capture.mp4
  Deleted Scenes/
    Lost Sister.mp4
`}</Tree>
        <p>
          The types are <Code>-trailer</Code>, <Code>-behindthescenes</Code>, <Code>-deleted</Code>, <Code>-featurette</Code>, <Code>-interview</Code>, <Code>-scene</Code>, <Code>-short</Code> and <Code>-other</Code>. The folders are{" "}
          <Code>Trailers</Code>, <Code>Behind The Scenes</Code>, <Code>Deleted Scenes</Code>, <Code>Featurettes</Code>, <Code>Interviews</Code>, <Code>Scenes</Code>, <Code>Shorts</Code> and <Code>Other</Code>.
        </p>
        <p>
          For a show, put the folders in the show folder or a season folder, or put the type after an episode&apos;s name: <Code>Show - s01e01 - Title-deleted.mp4</Code>. Several of one type get a number: <Code>-deleted1</Code>, <Code>-deleted2</Code>.
        </p>
      </Section>

      <Section id="subtitles" title="Subtitles">
        <p>Put the subtitle file beside the video with the same name, then the language, then the type:</p>
        <Tree>{`
Avatar (2009)/
  Avatar (2009).mp4
  Avatar (2009).en.srt
  Avatar (2009).eng.srt
  Avatar (2009).en.forced.ass
  Avatar (2009).en.sdh.srt
  Avatar (2009).de.srt
`}</Tree>
        <ul className="list-disc space-y-1.5 pl-5">
          <li>
            The language is a two- or three-letter code (<Code>en</Code>, <Code>eng</Code>, <Code>de</Code>, <Code>es</Code>). Without one, the language shows as unknown.
          </li>
          <li>
            <Code>forced</Code> is for subtitles of foreign parts only; <Code>sdh</Code> or <Code>cc</Code> is for the deaf and hard of hearing.
          </li>
          <li>
            Formats: <Code>.srt</Code>, <Code>.vtt</Code>, <Code>.ass</Code>, <Code>.ssa</Code>, <Code>.smi</Code>. Save text subtitles as UTF-8.
          </li>
          <li>
            Or put them in a folder called <Code>Subs</Code> or <Code>Subtitles</Code> next to the videos. For shows, the files are named like the episodes: <Code>Show - s02e03.eng.srt</Code>.
          </li>
        </ul>
      </Section>

      <Section id="posters" title="Posters">
        <p>Roam uses TMDB&apos;s poster. To use your own, put a picture in the folder:</p>
        <ul className="list-disc space-y-1.5 pl-5">
          <li>
            <strong>Movies:</strong> <Code>poster.jpg</Code> (or <Code>cover</Code>, <Code>folder</Code>, <Code>movie</Code>, <Code>default</Code>) in the movie&apos;s folder, or <Code>Avatar (2009).jpg</Code> beside a loose movie.
          </li>
          <li>
            <strong>Shows:</strong> <Code>poster.jpg</Code> (or <Code>folder</Code>, <Code>show</Code>) in the show&apos;s folder.
          </li>
          <li>
            Formats: <Code>.jpg</Code>, <Code>.jpeg</Code>, <Code>.png</Code>, <Code>.tbn</Code>.
          </li>
        </ul>
      </Section>

      <Section id="music" title="Music">
        <p>One folder per artist, one per album inside it, and the track number first in each file name:</p>
        <Tree>{`
Music/
  Pink Floyd/
    The Wall/
      101 - In the Flesh.mp3
      102 - The Thin Ice.mp3
      201 - Hey You.mp3
      cover.jpg
    Wish You Were Here/
      01 - Shine On You Crazy Diamond.m4a
      01 - Shine On You Crazy Diamond.lrc
      02 - Welcome to the Machine.mp3
  Various Artists/
    Guardians Of The Galaxy - Awesome Mix Vol. 1/
      01 - Hooked On A Feeling.mp3
`}</Tree>
        <ul className="list-disc space-y-1.5 pl-5">
          <li>
            <strong>Several discs:</strong> put the disc number in front of the track number, so track 2 on disc 3 is <Code>302 - Name.mp3</Code>. Or use disc folders (<Code>CD1</Code>, <Code>Disc 2</Code>) inside the album.
          </li>
          <li>
            <strong>Compilations</strong> go under an artist called exactly <Code>Various Artists</Code>.
          </li>
          <li>
            <strong>Lyrics:</strong> a <Code>.lrc</Code> (timed) or <Code>.txt</Code> file with the song&apos;s name, beside it.
          </li>
          <li>
            <strong>Cover art:</strong> <Code>cover.jpg</Code> (or <Code>folder</Code>, <Code>album</Code>, <Code>default</Code>, <Code>poster</Code>, <Code>front</Code>) in the album folder. A picture inside the song&apos;s own tags is used first.
          </li>
          <li>Keep tracks in album folders even if they are tagged: a flat pile of files gives a poor result.</li>
        </ul>
      </Section>

      <Section id="more" title="Photos, videos, audiobooks and books">
        <ul className="list-disc space-y-1.5 pl-5">
          <li>
            <strong>Photos and videos in a Photos library:</strong> any folders you like. Folders become albums, and pictures are placed by the date taken inside them (or, if the picture has none, a date in its name like <Code>IMG_20190314_142530.jpg</Code>).
          </li>
          <li>
            <strong>Video and Audio libraries:</strong> any folders; every file is listed by its name.
          </li>
          <li>
            <strong>Audiobooks:</strong> one folder per book, with the parts inside in order (<Code>Part 1</Code>, <Code>Part 2</Code>, or <Code>CD1</Code>, <Code>CD2</Code> folders).
          </li>
          <li>
            <strong>eBooks:</strong> EPUB or PDF files; the title and author are read from the file.
          </li>
        </ul>
      </Section>

      <Section id="formats" title="File types Roam can play">
        <p>
          Roam plays video in <Code>.mp4</Code>, <Code>.m4v</Code> and <Code>.mov</Code> (H.264 video and AAC audio work everywhere; HEVC only on devices that can decode it). Files in other formats, such as <Code>.mkv</Code> and <Code>.avi</Code>, which
          Plex would convert as it plays, are skipped, and the scan tells the admin how many. Convert them first (a tool like HandBrake does it) or ask your admin.
        </p>
        <p>
          Music: <Code>.mp3</Code>, <Code>.m4a</Code>, <Code>.m4b</Code>. Pictures: <Code>.jpg</Code>, <Code>.png</Code>, <Code>.webp</Code>, <Code>.gif</Code>, <Code>.heic</Code>.
        </p>
      </Section>

      <footer className="flex flex-wrap gap-x-5 gap-y-1 border-t border-white/10 pt-6 text-sm text-muted-foreground">
        <Link href="/" className="hover:text-foreground hover:underline">
          Back to Roam
        </Link>
        <Link href="/help" className="hover:text-foreground hover:underline">
          All help
        </Link>
      </footer>
    </main>
  );
}
