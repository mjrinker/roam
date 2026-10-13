<p align="center">
  <img src="public/roam-logo.svg" alt="Roam" width="360">
</p>

<p align="center">
  <strong>A private, multi-tenant media server in the cloud.</strong><br>
  Movies, TV, audiobooks, music, eBooks, and a Google&nbsp;Photos-style library, streamed straight from your own Box, Dropbox, OneDrive or Google&nbsp;Drive.
</p>

<p align="center">
  <img alt="Next.js 16" src="https://img.shields.io/badge/Next.js-16-black?logo=nextdotjs">
  <img alt="React 19" src="https://img.shields.io/badge/React-19-149eca?logo=react&logoColor=white">
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-strict-3178c6?logo=typescript&logoColor=white">
  <img alt="Postgres + Drizzle" src="https://img.shields.io/badge/Postgres-Drizzle%20ORM-336791?logo=postgresql&logoColor=white">
  <img alt="Vitest" src="https://img.shields.io/badge/tests-2%2C000%2B%20passing-6e9f18?logo=vitest&logoColor=white">
  <img alt="Deployed on Vercel" src="https://img.shields.io/badge/deployed%20on-Vercel-black?logo=vercel">
</p>

---

## What it is

Roam is a Plex-style media server with two deliberate departures:

1. **The storage is your own cloud drive, not a NAS.** Each server connects its *own* Box, Dropbox, OneDrive or Google Drive account (as many as it likes) over OAuth, and the browser streams video **directly from the provider** using short-lived, single-file download URLs. There are no media servers to run.
2. **The app is a stateless control plane on Vercel's free tier.** It handles auth, metadata, access control, and URL minting, and it is built so that it never has to move video bytes (Google Drive can stream through a free Cloudflare Worker, so even that stays off Vercel) or transcode.

It is a real, working product, not a tutorial project: it has accounts, per-person profiles with age limits, shareable libraries, resumable playback, offline downloads, playlists, a TV app, and photo browsing with a few-thousand-photo timeline. This README is written for people evaluating the engineering, so it leads with the interesting problems.

> **Status:** in daily use by a small group of people. The code is public to read ([see the license](#license)), and a [public demo server](#public-demo) lets you try it without an account or any setup.

## Engineering highlights

### Seamless multi-file playback
Movies ripped as `Part 1` / `Part 2` (and combined multi-episode files) play as **one continuous video**. A custom dual-`<video>` player preloads the next segment on a second element and swaps at the boundary, tracks a single virtual timeline across files, handles trims for combined episodes, and refreshes expiring storage URLs mid-playback. Position is saved per profile.

### Metadata and codecs without ffmpeg on the hot path
Duration, codecs, chapters, and cover art are read with **hand-written, bounded parsers** that fetch only a few KB with HTTP range requests (MP4/MOV atoms, MP3 ID3v2.2–2.4 + ID3v1, EXIF/TIFF, HEIC/HEIF boxes, JPEG/PNG/GIF/WebP headers). A scan never downloads a whole file.
Because these parse **untrusted files**, every read is range-checked, loops and allocations are capped, impossible dates and dimensions are rejected, and the parsers are covered by seeded fuzz tests that must never throw or hang.

### Scanning that is safe to run against someone's library
- **Time-budgeted and resumable.** Vercel Hobby caps functions at 60 s, so scans work in single-transaction slices with a resumable depth-first cursor, and pick up automatically on the next page load.
- **Cleanup that can't wipe a library.** Files removed from storage are pruned only after a *clean* scan cycle, each candidate is verified against the provider by id, a grace period applies, and a hard cap refuses to delete when the number looks like an outage or a wrong folder.
- One scan engine drives every library kind through a small "profile" object (what a file becomes, what is probed, what is read). A library can span folders on several connections and providers; if one is signed out the others still scan.

### Multi-tenancy and access control
- Anyone can sign up; they then create or join a **server**. One admin per server; invites are viewer-only (an admin can delete a server, a library or an invitation; expired invitations drop out of the list after a week).
- **Per-library sharing**: a library is visible to everyone on the server or to chosen accounts only. A single choke point (`libraryVisible`) is used by every reader, and a test walks the source tree to enforce it.
- **Profiles with age limits** (Netflix-style): content is filtered in SQL, before ordering and paging, so a hidden item can't leak through a count, a cursor, or a "next" button.
- Every refusal (missing, hidden, age-blocked, wrong kind) is the **same 404**, so nothing confirms an item exists.
- Storage tokens are **AES-256-GCM encrypted at rest**; Postgres row-level security is deny-all (the app is the only client); sign-up and heavy routes are rate-limited in Postgres.

### A photo library that scrolls like Google Photos
- **The whole timeline is laid out up front.** Month counts give every block its exact pixel height, and blocks fill as they near the screen. Scrubbing to any month is just a scroll: nothing is inserted above you, no scroll-correction hacks.
- A viewer that opens as an **overlay** (instant close, scroll position untouched), with pinch/double-tap zoom, swipe between items, swipe-down to close, and neighbours that slide in with the finger.
- EXIF dates and HEIC support, a month scrubber that scrolls live, favorites per profile, search by name or date, and day/month/year zoom levels.
- Thumbnails and previews are proxied through one access-checked gate with private caching; no image is stored in the database.

### Honest handling of what browsers can't play
Roam deliberately does no server-side transcoding. For files whose audio browsers can't decode (AC-3, E-AC-3, DTS) it detects the codec during the scan and offers a **remux** (video copied, audio to AAC; Box storage) as a separate "browser-friendly" file linked to the original. A video the device can't decode (HEVC on a browser without it) is refused up front instead of spinning, and the player picks a version the device can play. For phone videos (HEVC) in photo libraries it uses **Box's own H.264 rendition**, handed to the browser behind a token scoped to a single file.

## Architecture

```mermaid
flowchart LR
  B[Browser / installed PWA] -- "pages, API (cookie session)" --> V[Next.js 16 on Vercel<br/>control plane]
  V -- "Drizzle, parameterised SQL" --> P[(Supabase Postgres<br/>RLS deny-all)]
  V -- "OAuth per connection; downscoped,<br/>single-file tokens" --> X[Box · Dropbox · OneDrive · Google Drive]
  V -- "metadata" --> T[TMDB · OMDb · Audible]
  B == "video bytes: short-lived URL" ==> X
```

Video bytes never pass through Vercel, except Google Drive's when no Cloudflare Worker is set up (Drive has no per-file download links). Photo thumbnails and previews do (small, cached, and gated by the same access check as everything else).

## Public demo

You can try Roam as a guest, with no email or password: open the demo link, press **Continue as a guest**, and you're browsing a demo server.

**Demo link:** <https://roam-three-gray.vercel.app/join/9XZLaau-Tl9bxfQLQ7Ggy2qdRESKx_UQ>

What to know before you click:

- **Some of it is placeholder.** The demo's movies and shows have real, familiar names, and their posters, descriptions and ratings come from TMDB, but every video is a 45-second clip cut from one of two openly licensed films (Big Buck Bunny and Sintel, Creative Commons Attribution 3.0). In the same way, the albums by famous artists carry real titles, track lists and covers (from MusicBrainz) but 40-second clips of CC0 Chopin recordings, and the J.R.R. Tolkien books (still in copyright) are placeholder EPUBs with public-domain text. None of it is the work named. A banner says so on every page, and the credits page lists each source, its author and its licence. The photos, Chopin recordings, LibriVox audiobooks and Project Gutenberg books are real, openly licensed material, shown as what they are.
- **You're a viewer, and invisible.** A guest can watch and make their own playlists and favorites; they can't change anything, can't create servers, and other visitors can't see them. Guest accounts are deleted after about a week without a visit.
- **It has a daily play limit.** The videos stream from a real Box account, so the demo allows a fixed number of plays per day across all visitors. If it's "resting", come back tomorrow.

How it's built (the interesting part, for reviewers): a server's admin can switch on an **open join link** that only ever adds a *viewer* (a database rule makes a second admin impossible, and joining never changes an existing member's role). Guests are real accounts created with Supabase's anonymous sign-in, flagged as guests, hidden from other members from the first moment, refused anything that spends the owner's API quota, and cleaned up by a routine that deletes in dependency order and re-checks inactivity inside the transaction. Per-account limits are meaningless when accounts are free, so the real cost cap is a daily total for the whole demo, recorded against the server's owner.

## Tech stack

| Area | Choice |
|---|---|
| Framework | Next.js 16 (App Router, Server Components, route handlers, `proxy.ts`), React 19, TypeScript |
| Data | PostgreSQL on Supabase, **Drizzle ORM**, 48 migrations (enum changes split from their first use, additive-first) |
| Auth | Supabase Auth (magic link, Google, email + password), custom roles, profiles |
| Storage | Box, Dropbox, OneDrive, Google Drive behind one `StorageProvider` interface (OAuth 2 with rotating refresh tokens, byte-range reads, signed single-file stream links; optional Cloudflare Worker for Drive) |
| UI | Tailwind CSS 4, shadcn/Base UI, Lucide, installable PWA |
| Metadata | TMDB (kept once in a shared cache, refreshed within six months), OMDb, Audible, MusicBrainz, OpenSubtitles (all optional or fully offline for "generic" libraries) |
| Tests | **Vitest** with in-memory Postgres (**PGlite**) replaying the real migrations; ~2,000 tests |
| Hosting | Vercel (Fluid compute) with a Postgres-backed rate limiter and no extra services |

## Quality and testing

- Tests run against a **real Postgres engine in memory** with the production migrations, so constraints, locks, indexes, and cursor ordering are exercised, not mocked.
- Security-relevant guards (library access, age filtering, uniform 404s, kind allow-lists, rate limits) each have a test that was checked to **fail when the guard is removed** (manual mutation testing).
- Source-level enforcement tests fail the build if a new reader skips the access helper or a new code path special-cases a library kind with a string literal.
- Every feature went through plan → independent review → small commits → independent review again; the commit history reflects that.

## Feature guides

### Storage, connections and library folders

A server can have any number of **storage connections** (Server settings > Storage): Box, Dropbox, OneDrive and Google Drive, several accounts of the same kind if you like. A library is made of one or more **folders**, each on any connection; a scan treats them as one library (folders of the same name merge, and if one connection is signed out the others still scan, with the problem reported). Add or remove a library's folders under it in Server settings.

Each kind of storage needs the deployment to hold its sign-in keys, or it isn't offered:

- **Box:** `BOX_CLIENT_ID`, `BOX_CLIENT_SECRET`.
- **Dropbox:** `DROPBOX_APP_KEY`, `DROPBOX_APP_SECRET`. Create an app at dropbox.com/developers/apps with *Scoped access* and *Full Dropbox*, tick `files.metadata.read` and `files.content.read` on its Permissions tab, and add `https://<your site>/api/dropbox/callback` as a redirect URI. Dropbox streams through temporary direct links (good for four hours), so nothing passes through Roam.

- **OneDrive** (personal, work or school): `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`. Register an app at portal.azure.com (App registrations), supporting *any organizational directory and personal Microsoft accounts*, with the Web redirect URI `https://<your site>/api/onedrive/callback`; create a client secret (they expire, at most after 24 months, so note when); give it the Microsoft Graph delegated permissions `Files.Read.All`, `User.Read` and `offline_access`. OneDrive streams through each file's own pre-authenticated link (good for about an hour).

- **Google Drive:** `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`. In Google Cloud Console create a project, enable the *Google Drive API*, configure the OAuth consent screen (External; add the `.../auth/drive.readonly` scope; **publish it to "In production"** so logins don't expire after 7 days; Google shows an "unverified app" warning that you click through, and caps it at 100 users, which is plenty for a private server), then create an *OAuth client ID* of type *Web application* with the redirect URI `https://<your site>/api/google/callback`. Google has no per-file download links, so Drive files stream *through Roam* (`/api/storage/stream/<token>`, a signed link for one file that expires in four hours); the account's own token never reaches a browser. That means Drive playback uses your hosting's bandwidth, unlike Box, Dropbox and OneDrive. Only files in My Drive and shared drives can be browsed (not "Shared with me": add a shortcut-free copy or move them into a folder you own). Needs `NEXT_PUBLIC_APP_URL` set to the site's address. To take that load off your host, deploy the free Cloudflare Worker in `cloudflare/stream-worker/` (see its README) and set `STREAM_WORKER_URL` and `STREAM_SECRET`: Drive playback then streams through Cloudflare, which charges nothing for bandwidth (the free plan allows 100,000 requests a day).

Things only Box does: making browser-friendly copies of unsupported audio (remuxing), Box's own previews of phone videos, and putting a TMDB tag in a folder's name.

### Cast and crew

A movie's or show's page shows its billed cast and its key crew (directors, writers, producers, composer, cinematographer, editor) from TMDB, as rows of photos. Click a person to see their movies and shows on this server, with what they did on each (their role, or "Director"). Only what the viewer is allowed to see is listed. A person's page also shows their biography (from TMDB) above their titles, and a "Not on this server" section with their other well-known work, which opens on The Movie Database; a profile with an age limit doesn't get that section, since TMDB's credits carry no ratings to check against. Cast and crew are fetched during library scans for every title with a TMDB match; Resync on a title fetches them again.

### Audiobook authors and credits

An audiobook library has a **Books | Authors** switch. Authors shows each author as a tile (their cover, and how many books); opening one shows everything that person is credited with on the server. A book's page has a **Credits** row with its authors and narrators (a full-cast recording lists them all, labelled Cast when there are more than three), and clicking anyone opens their page: the books they wrote and the books they narrated, in series order. People are matched by name, ignoring case and spacing, across all the audiobook libraries the viewer can see.

### TMDB data and its six-month rule

TMDB's terms ask that what Roam keeps from it be refreshed at least every six months. Everything from TMDB (details, ratings, cast, crew, episodes) is kept once in a shared cache (`tmdb_entries`, `tmdb_cast`, `tmdb_crew`) that every server reads, so a movie two servers have is fetched once. Titles and episodes still carry copies of what lists and filters need (poster, description, age rating), pushed from the cache whenever it refreshes. Entries are refreshed when they are about five months old: when someone opens that movie or show (the page waits a moment for it, at most four seconds), and by a daily job (`/api/cron/refresh`, scheduled in `vercel.json`, needs `CRON_SECRET` set in the project's environment) that works through the oldest first and forgets entries no title uses. An entry that couldn't be refreshed within six months (TMDB unreachable, or the item removed) is cleared: its description, pictures, genres, cast and crew disappear from the titles that used it, while the age rating stays so a restricted title is never opened up. Titles with no match, and admin-chosen matches, are refreshed the same way by their TMDB id.

### Trailers and extras

A movie's page lists its trailers and other extras when its folder has them, named the way Plex names them. Either put the type at the end of the file name, right after a hyphen (`Teaser-trailer.mp4`, `Making Of-behindthescenes.mp4`, `Cut Scene-deleted.mp4`, `The Look-featurette.mp4`, `Talk-interview.mp4`, `Opening-scene.mp4`, `Little Film-short.mp4`, `Misc-other.mp4`), or put the videos in a subfolder of the movie's folder named for the type (`Trailers`, `Behind The Scenes`, `Deleted Scenes`, `Featurettes`, `Interviews`, `Scenes`, `Shorts`, `Other`). They are found on the next scan of the library (or Resync on the movie), appear once Roam has read their length, and play in the normal player. They never record progress and aren't offered for download. Only MP4, M4V and MOV files are used, as for movies.

### Help me choose

**Help me choose** is a button on Home and on every library page except Photos (Movies, TV Shows, Videos, Audiobooks, Audio, Music and eBooks). From Home you first tick the libraries to choose from; from a library page that library is used. It shows two random things at a time (a library is picked at random first, so a small one isn't drowned out by a big one; only things you are allowed to see and that are ready to play are offered). Choose one, then either **Watch / Listen to / Read it** (a show starts on the first episode you haven't finished, a music item is an album) or **Keep choosing**, which sets your pick against a new one, and so on. Nothing is shown twice until the libraries run out. After every fifteen rounds it asks whether to choose for you: play something random from the libraries, keep going, or play one of the two on screen.

### Music and audio views

A **Music** library is browsed as **Artists | Albums | Songs | Genres**; a generic **Audio** library as **Tracks | Artists | Albums | Genres | Folders**. Songs (Tracks) lists every song, with Play and Shuffle for the whole list, a search box (name, artist, album, folder) and a Sort menu (name, duration, artist). Genres, and in an Audio library Artists and Albums, list the groups as tiles; opening one lists its songs the same way, with Play and Shuffle for just that group. Each music artist's page has Play and Shuffle too. Artist, album and genre come from the files' own tags (the first artist, the album, and the genre(s)); songs scanned before genres were read are read once more, automatically, on the next scan. Songs with no artist, album or genre are grouped as "Unknown".

### Selecting several items

**Select** is on the Movies, TV Shows and Audiobooks library pages, on the Artists and Albums tabs of a music library, on every song list (Songs, Tracks, and the songs of an artist, album or genre), and on the folder views of Video and Audio libraries (not Photos, and not eBooks, which can't be played or downloaded). It puts a checkbox on every card: click to choose (Shift-click for a range), or **Select all** to take everything the page covers, not only what is on screen: every title matching the current search and filters, every page of the folder you are in, or every album or artist of the library. The bar then offers **Add to playlist** (everything chosen goes into one playlist you can edit, or a new one, in the order shown; albums and artists go in as their songs) and **Download** (a dialog adds up the sizes, lets you pick one resolution for all, using the closest available for each, and saves them one after another; a show stands for all its episodes). Big selections are handled in rounds. A generic Audio library has a search box (name, artist, album or folder, across the whole library) and a Sort menu (name, duration or artist; choosing the one in use turns it around), like the Movies page's, and Select all follows the search and the order. In a folder view, folders themselves can't be selected, only the files directly in the folder you are in.

### Downloads (offline)

Any movie, episode, song, album or audiobook can be saved on the device you are using: **Download** is in the More menu on a movie or audiobook page and on episode rows, a button on song rows, and **Download album** in an album's More menu. For a movie or episode the dialog lists each resolution version with its size; you pick one. The file goes into the browser's private storage (it streams straight from storage to disk, so a multi-gigabyte film never sits in memory; an interrupted download carries on from the byte it reached, and a connection that goes silent is dropped and resumed). Downloaded items are played from the device in the usual players, with or without a connection, and show up under **Downloads** in the sidebar. Where you were is remembered on the device and sent to the server once there is a connection again.

With no connection the installed app opens a page of your downloads (`/offline`, kept by a service worker that is refreshed with each deployment) and plays them from there. Downloads belong to that browser on that device: clearing the site's data removes them, and the browser may clear them when it is short of space (the app asks it not to). It needs a browser with private file storage: current Chrome, Edge, Firefox and Safari (on an iPhone, installed to the Home Screen). The player's other settings, such as subtitles you load from a file, work offline too; searching OpenSubtitles does not.

### Subtitles

Anyone who can watch a movie, video or episode can load subtitles for that viewing: in the player's captions menu (web) or with Down (TV), find one on OpenSubtitles, or on the web load an SRT, WebVTT or ASS file from the device (2 MB at most). Nothing is stored: subtitles are gone when the player closes, and each time the player loads you choose them again. Searching OpenSubtitles needs `OPENSUBTITLES_API_KEY`, `OPENSUBTITLES_USERNAME` and `OPENSUBTITLES_PASSWORD` (see `.env.example`); every download comes out of that one account's daily allowance.

### Turning on the CAPTCHA

Sign-in has Cloudflare Turnstile support that stays off until you configure it, so nothing changes for anyone until then. Order matters, because once Supabase requires a token a build without the widget cannot sign anyone in:

1. Create a Turnstile widget in the Cloudflare dashboard for your domain.
2. Set `NEXT_PUBLIC_TURNSTILE_SITE_KEY` (the public site key) in Vercel and redeploy.
3. In Supabase, Authentication > Attack Protection, turn on CAPTCHA, choose Turnstile and paste the **secret** key.
4. Run `npx tsx --env-file=.env.local scripts/check-captcha.ts` to confirm Supabase now refuses a sign-in without a token.

## Libraries and features

| Library type | What you get |
|---|---|
| **Movies / TV Shows** | TMDB posters and metadata, Plex-style naming (`{tmdb-123}`, `- pt1`, editions, extras), seasons and episodes, ratings from IMDb and Rotten Tomatoes |
| **Audiobooks** | Audible matching, chapters, resume, a persistent mini-player |
| **Music** | Artist > Album > Song from the folder layout; albums matched on MusicBrainz for names, years, track titles and cover art (clear matches only, switchable per library); album pages with play, shuffle and a queue |
| **Generic video / audio** | Folder-mirrored browsing; names, artist, and cover read from the files' own tags; one library-wide age rating |
| **eBooks** | EPUB and PDF books; EPUBs open in an in-app reader that remembers your place |
| **Photos & videos** | Timeline + albums, favorites, search, scrubber, zoom levels, viewer |

Also: a **TV interface** (`/tv`: server-rendered pages plus one script built for Chromium 56, so it runs on a 2018 Samsung, with extras on newer TVs; movies, shows, videos, music, audio, photos, audiobooks, search, playlists; sign-in by a five-character code approved from a phone; guide for relatives at `/help/tv`; Samsung/LG packages in [`tv/`](tv/README.md)), cast, crew and person pages, trailers and extras, offline downloads, Help me choose, playlists with sharing roles, per-profile watch history, global search, per-library sharing and age ratings, a resumable admin scan with live progress, a public front page with privacy and terms pages, and a [platform admin](#platform-admin) page for whoever runs the site.

## Getting started

Prerequisites: Node.js 20.9+, a [Supabase](https://supabase.com) project, at least one storage provider's OAuth app (a [Box](https://developer.box.com) custom app, or Dropbox, Microsoft or Google; see [Storage](#storage-connections-and-library-folders)), and optionally a [TMDB](https://www.themoviedb.org/settings/api) token and an [OMDb](https://www.omdbapi.com/apikey.aspx) key.

```bash
npm install
cp .env.example .env.local     # fill in the values; each one is commented
npm run db:migrate             # apply the Drizzle migrations
psql "$POSTGRES_URL" -f supabase/rls.sql   # deny-all row-level security (read its header first)
npm run dev                    # http://localhost:3000
npm test                       # ~2,000 tests, no external services needed
```

1. Create an OAuth app with the storage provider you want to start with. For Box: in the developer console, create an **OAuth 2.0** custom app and register `/api/box/callback` (local and production) as a redirect URI. The others are described under [Storage](#storage-connections-and-library-folders).
2. Generate `TOKEN_ENCRYPTION_KEY` with `openssl rand -base64 32` (it encrypts every connection's tokens; rotating it requires reconnecting every connection).
3. Sign up, **create a server**, connect storage, then add a library by choosing a folder and a type. Scans can be started from the admin page.
4. Optional: set `CRON_SECRET` so the daily TMDB refresh runs (see [TMDB data](#tmdb-data-and-its-six-month-rule)), and run `scripts/grant-platform-admin.ts` for your account to open [`/platform`](#platform-admin).

Deploying: import the repo into Vercel with the same environment variables (use the pooled `POSTGRES_URL`, port 6543). Note `vercel.json` must enable deployments for your production branch.

Folder naming for Movies/TV follows Plex conventions, e.g. `Movies/The Matrix (1999)/The Matrix (1999).mp4`, `Movie (2001)/part1.mp4`, `Show (2015)/Season 01/S01E01 - Pilot.mp4`. Pre-convert to H.264/AAC `.mp4`, `.m4v`, or `.mov` (HEVC plays only on devices that can decode it).

**Resolution versions.** Save the same movie or episode in more than one resolution with Plex's version naming, a ` - <resolution>` segment in the file name: `The Matrix (1999) - 1080p.mp4` and `The Matrix (1999) - 4K.mp4`, or `Show - S01E01 - 720p.mp4` and `Show - S01E01 - 1080p.mp4` (a split version keeps its parts: `Movie (2020) - 4K - pt1.mp4`). The label must start with a resolution word (`480p`, `720p`, `1080p`, `2160p`, `4K`, `UHD`, `HD`, `SD`, optionally followed by more words such as `1080p BluRay`), so an episode's title is never mistaken for one. By default the highest resolution plays; the player's settings menu (the gear on the web, Up on the TV) has a Quality choice, and the pick is remembered per device (the closest available resolution is used for other titles). A file with no label is just another version, shown by its real resolution.

To make the lower resolutions from files you already have, run `scripts/make-versions-box.ts` (same way as `remux-box.ts`: `npx tsx --env-file=.env.local scripts/make-versions-box.ts --dry-run`, then without `--dry-run`). For each movie and episode it reads the real resolution and encodes every rung of 2160p / 1440p / 1080p / 720p / 480p / 360p / 240p / 144p that is *below* the original (H.264, bitrate-capped to stay under Box's file size limit), uploading each next to the original as `<name> - 720p.mp4`. Each rung keeps the original's audio; when that audio is AC-3/DTS or similar it also gets an AAC copy beside it (`<name> - 720p.aac.mp4`), like the original's own. A film that is in several parts becomes one file per new version (the original's parts are left alone). Finally the original is renamed to say what it is (`<name> - 1080p.mp4`, each part, and its `.aac` copy). Safe to re-run; options include `--only movies|shows`, `--library`, `--title`, `--rungs 720,480`, `--limit`, `--skip-rename`, `--preset`, `--crf`. Each new version is added to Roam as soon as it is uploaded, so no rescan is needed.

## Project structure

```
src/
  app/            routes: (app)/s/[serverId]/…  library, title, show, book, photo, watch, admin
                  api/                           control-plane routes (play, scan, photos, playlists, …)
  components/     player/ (dual-video player), photos/ (timeline, viewer, scrubber), admin/, library/, platform/, ui/
  lib/
    scan/         scanner, file-tree engine, tag/EXIF/HEIF/MP4/ID3 parsers, prune
    storage/      StorageProvider interface; Box, Dropbox, OneDrive, Google Drive; connections, OAuth tokens, signed stream links
    tmdb/         shared TMDB cache, projections onto titles, the daily refresh
    cast/ extras/ cast, crew and person pages; trailers and extras
    music/ ebooks/ audiobooks/  MusicBrainz matching; EPUB reader; authors and credits
    platform/     the platform admin page's numbers, and the linked-accounts ledger
    tv/ offline/ choose/ demo/  the TV app; offline downloads; Help me choose; the public demo
    content/      access rules: library visibility, age filtering
    photos/       timeline queries, search, layout maths, favorites, gestures
    player/       play manifest + timeline maths
    remux/        audio remux pipeline (local runner, sandbox tier)
    db/           Drizzle schema + client
drizzle/          SQL migrations         supabase/rls.sql   deny-all RLS
cloudflare/       the optional Google Drive stream Worker     tv/   Samsung / LG packages
scripts/          remux, make-versions, seeding, grants, browser checks
```

## Platform admin

`/platform` is one page for whoever runs Roam (not for server admins): every server at a glance, and what needs attention.

- **Outside accounts and their limits.** How many Dropbox (limit 50 while the app is in development), Google (100 while unverified), Box and OneDrive accounts are linked (only the first two have limits), counted once however many servers use them, with a bar that turns amber at 80% and red at the limit, and the steps to apply for production access. Accounts are kept in a ledger (`provider_accounts`) so the count is right even after a connection is removed; when the last connection using an account is removed (or its server is deleted), Roam unlinks the account at Dropbox or Google, so it stops counting there too. Microsoft has no way for an app to do this, so a OneDrive account is only counted.
- **Items by library type.** For each kind of library: how many libraries, items, episodes and files, and their total size.
- **At a glance.** Accounts, demo guests, servers, libraries by kind, items, new accounts and active people this week and month, pending invites, storage connections.
- **Needs attention.** Storage that needs signing in again, libraries whose last scan had errors, libraries never scanned.
- **Scanning and TMDB.** Files waiting to be read or that failed, the shared TMDB cache's size and age, when the daily refresh last ran and what it did, and a button to run it now.
- **Servers.** Each server's owner, members, libraries, items and connections.

The page answers "not found" to everyone else. Grant access once, to your own account (it must have signed in):

```
npx tsx --env-file=.env.local scripts/grant-platform-admin.ts you@example.com
```

## Known limitations

- No general transcoding, by design: unsupported audio is remuxed on request, and everything else must already be browser-friendly.

## License

Roam is **source-available**, under the [PolyForm Strict License 1.0.0](LICENSE). In plain words:

- **You may** read the code, and run it yourself for personal, noncommercial use (study, a hobby project, trying it out). Charities, schools and public bodies may use it for their work too.
- **You may not** change it, copy it to somewhere else, fork it and share or host it as your own, or use it to make money. To use Roam as a service, use [the deployment](https://roam-three-gray.vercel.app) (or the public demo).
- **Found a bug, or want something changed?** Please [open a GitHub issue](https://github.com/mjrinker/roam/issues). Pull requests aren't accepted.

The demo's sample media and the data from outside services keep their own licenses (see below).

## Credits and attribution

- Movie and TV metadata and images: [TMDB](https://www.themoviedb.org). *This product uses the TMDB API but is not endorsed or certified by TMDB.*
- Album data and covers: [MusicBrainz](https://musicbrainz.org) and the Cover Art Archive. Ratings: OMDb. Subtitle search: OpenSubtitles.
- Demo footage: clips cut and re-encoded from Big Buck Bunny (© copyright 2008, Blender Foundation / www.bigbuckbunny.org) and Sintel (© copyright Blender Foundation | durian.blender.org), both CC BY 3.0. See `src/lib/demo/catalog.ts` and the demo's credits page.

## About

Built by [Matt Rinker](https://github.com/mjrinker). Developed with AI pair-programming (Claude Code) under a plan-then-review workflow, with every change reviewed and tested before it shipped.
