# Roam API (v1)

The API that native apps (TV apps, phone apps, Kodi) use. Everything is JSON over HTTPS, at the same address as the website. This page is the contract: v1 only ever grows (new fields, new endpoints); anything that changes an existing answer will be a v2.

## Signing in

An app never sees a password. It asks for a code, shows it, and the person approves the code at **`/link`** on a phone or computer where they are signed in (the same flow TVs use).

1. `POST /api/v1/device/start` with `{ "label": "Living room Roku" }` (the name is optional and is shown to whoever approves, so make it recognisable). Answers:
   ```json
   { "userCode": "K7M2P", "deviceCode": "…", "verificationUrl": "https://…/link", "verificationUrlComplete": "https://…/link?code=K7M2P", "expiresIn": 600, "interval": 3 }
   ```
   Show `userCode` and `verificationUrl` (or a QR code of `verificationUrlComplete`). Keep `deviceCode` secret: it is what the app polls with.
2. `POST /api/v1/device/poll` with `{ "deviceCode": "…" }` every `interval` seconds. Answers `{ "status": "pending" }`, `{ "status": "expired" }` (start again), or, once approved:
   ```json
   { "status": "approved", "accessToken": "rdt_…", "tokenType": "Bearer", "account": { "id": "…", "email": "…", "displayName": "…" }, "profiles": [ { "id": "…", "name": "Ann", "avatarKey": "…", "role": "owner", "hasPin": false, "selected": true } ], "profileSelected": true }
   ```
   **The token is shown once.** Store it somewhere private. It does not expire while it is used (it stops working after 180 days unused, or when revoked).
3. Send `Authorization: Bearer rdt_…` on every later request.

A token belongs to the account and to **one profile at a time**. When `profileSelected` is false (the account has several profiles, or one with a PIN), show "Who's watching?" and choose with `POST /api/v1/me/profile` `{ "viewerId": "…", "pin": "1234" }` (the PIN only for a profile that has one; wrong guesses are limited). Until a profile is chosen, calls that need one answer **409** `profile_required`. Choose again any time to switch profiles. Changing a profile's PIN signs it out of every device.

| Call | What it does |
|---|---|
| `GET /api/v1/me` | The account, the profile in use (or null), and all profiles. |
| `POST /api/v1/me/profile` | Choose the profile (above). |
| `DELETE /api/v1/session` | Sign this device out (its token stops working). |
| `GET /api/v1/devices` | The account's signed-in devices (never their tokens), most recently used first; `current` marks this one. |
| `DELETE /api/v1/devices/{id}` | Sign one of them out. People can also do this on the web, under their profiles. |

## Errors

Every error is `{ "error": "words a person can read", "code": "machine_readable" }` with a normal status: **400** `invalid_request`, **401** `unauthorized` (no or bad token: sign in again), **404** `not_found` (also used for things you may not see, so hidden titles look exactly like missing ones), **409** `profile_required`, **429** `rate_limited`. Nothing is cached: send no cache headers of your own.

## Browsing

All under `/api/v1/servers/{serverId}`. Lists are cut for the profile in use: libraries not shared with it, and titles above its age limit, are absent.

| Call | Answer |
|---|---|
| `GET /api/v1/servers` | `{ servers: [{ id, name, role }] }` (no profile needed). |
| `…/home` | `server`, `libraries`, `continueWatching`, `continueListening`, `recentlyAdded` (items, below), `hasPlaylists`, `unreadNotifications`. |
| `…/libraries` | `{ libraries: [{ id, name, kind, style }] }`. `style` says how to browse it: `grid`, `folders`, `artists`, `timeline`, or `null` (not listable yet, e.g. eBooks). |
| `…/libraries/{id}/items` | One page, by style: **grid** `?page=1` (and optionally `sort=title\|year\|added`, `genre=Drama`, `unwatched=1`, `owner=<account id>\|none`) → `{ items, page, hasMore }`; **folders** `?path=A/B&after=CURSOR` → `{ path, folders, items, next }`; **artists** `?after=CURSOR` → `{ items, next }`; **timeline** (photos) `?view=favorites` or `?view=albums&path=…&after=CURSOR` → `{ items, next }`. Pass `next` back as `after`; null means the end. |
| `…/playlists` | The playlists this profile can see: `{ playlists: [{ id, name, itemCount, ownerName, canAdd }] }`. |
| `…/playlists/{id}` | One playlist and a page of its items (`?after=` is the previous page's `next`): `{ playlist, items, next }`. Items are like list items, plus `entryId` and `playable`; photos and eBooks are left out. Changing a playlist uses `/api/playlists/{id}` and its `items`, below. |
| `…/libraries/{id}/genres` | A grid library's genres with their counts (the same filters can be given). |
| `…/titles/{id}` | A movie, show or audiobook (see below). |
| `…/albums/{id}`, `…/artists/{id}` | An album with its songs in order; an artist with their albums. |
| `…/search?q=` | `{ query, items }`: titles, books, audio files, albums and artists. |

An **item** is `{ type, id, name, subtitle, posterUrl, square, progress? }` with `type` one of `movie`, `show`, `episode`, `audiobook`, `audio`, `album`, `artist`, `photo`, `clip`. `square` says whether the picture is a square cover or a tall poster. Open `movie`, `show` and `audiobook` with `…/titles/{id}`, `album` and `artist` with their own calls.

**A movie** (`type: "movie"`) has `name, year, overview, posterUrl, backdropUrl, runtimeSeconds, genres, certification, imdbRating, rottenTomatoesScore, finished, resume ({ positionSeconds, durationSeconds } or null)`, `play.manifestPath`, `chapters`, `extras` (groups of `{ id, name, durationSeconds, playPath }`), `cast`, `ownership`, and `guide` (parental guide lines and community reports). If `guide.fromCommunity` is true, show "Powered by DoesTheDogDie.com" with it, and say the reports are unverified: their terms require it.

**A show** has `seasons` (numbers), `season` (the one whose `episodes` are listed; choose with `?season=N`), `episodes` (`id, number, name, watched, inProgress, playPath`), `continueEpisodeId`, `watched`, `ownership` (for the listed season).

**An audiobook** has `authors, narrators, series, resume, play.manifestPath`.

## Playing

Playback uses endpoints that already existed for the website; they accept the same token.

- **Video:** `GET /api/play/{title|episode|extra}/{id}` returns the manifest: `segments` (the video in one or more files: `url`, `startSeconds`, `durationSeconds`; play them back to back as one timeline), `durationSeconds`, `resumeSeconds`, `chapters`, `skips`, `skipSegments`, `autoSkip`, `notice`, `versions`/`version`, `defaultRate`, `heartbeat`. Optional query: `unsupportedCodecs=ac3,eac3` (audio codecs the device can't play, so the server can remux), `version=` or `height=` (which resolution), `skip=violence:high,…` (extra scenes to skip for this play only). URLs expire (`expiresAt`): ask again when they do. Types: `src/lib/player/types.ts`.
- **Scene filtering is the client's job.** `skips` are on the playback timeline: `action: "skip"` means jump to `endSeconds` when the clock reaches `startSeconds`; `"mute"` means silence the audio for that stretch. The progress bar should leave out skipped time. If the manifest has a `notice`, say it once as playing starts. `skipSegments` are for "Skip intro" style buttons; with `autoSkip` set for a kind, skip that kind by itself, once per play.
- **Audiobooks, audio files and songs:** `GET /api/audiobooks/{id}/manifest`, then `GET /api/audiobooks/{id}/segments/{index}` for the parts it doesn't include.
- **Saving progress:** `PATCH /api/watch-state` with `{ "ownerKind": "title"|"episode", "ownerId", "positionSeconds", "durationSeconds", "finished" }` about every 15 seconds and when leaving. Extras keep no place.
- **Playing-at-once limit:** if the manifest has `heartbeat: true`, `POST /api/playback/beat` `{ ownerKind, ownerId, paused }` every 30 seconds, and `POST /api/playback/end` when stopping. Anything that can't play because every copy is withdrawn or in use answers **423** with `{ error, code: "withdrawn"|"busy", unit, watching }`; for `busy`, offer "tell me when it's free" with `PUT /api/playback/watch` `{ titleId, seasonId }` (and `DELETE` to stop).
- **Subtitles:** `GET /api/subtitles/search?ownerKind=&ownerId=&languages=en` then `POST /api/subtitles/download` (see the routes).
- **Marking watched:** `POST /api/watch-state/mark`.

## Everything else an app may want

Playlists (`/api/servers/{serverId}/playlists`, `/api/playlists/{id}`, `/api/playlists/{id}/items`, `…/next`), notifications (`GET /api/notifications`, `POST /api/notifications/read`), and ownership (`POST /api/ownership/claims`, `PUT /api/ownership/mine`, evidence pictures at `/api/ownership/claims/{id}/evidence`). They take and answer JSON like the rest. Push notifications to apps are not part of v1: poll `notifications` (or the `unreadNotifications` count in `home`).

## Not in v1 yet

Viewing a single photo, pictures of a title's cast, download-for-offline helpers for native apps, and the admin's screens (assigning owners, settling claims, server settings), which stay on the web.
