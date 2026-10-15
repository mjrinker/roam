# Roam for Kodi

A Kodi add-on (Python 3, Kodi 19 "Matrix" or newer) that uses the same JSON API as every other app ([`docs/api.md`](../docs/api.md)).

**Status: written and tested against stand-ins for Kodi (`kodi/tests`, 56 tests), not yet run inside a real Kodi.** The logic (the API client, the menus, playback decisions) is tested; what only a real Kodi can show is how it looks and how Kodi's player behaves. The places most likely to need a tweak are at the end.

## What it does

- **Signs in with a code**: the add-on shows a short code and an address; type the code at `<your Roam>/link` on a phone or computer where you're signed in. No password is typed into Kodi. The sign-in is kept in the add-on's own data folder.
- **Who's watching** (a PIN is asked for a profile that has one), and which server if there are several.
- **Browse**: continue watching, recently added, your libraries (movies, shows, video folders, music), search, switch profile, sign out. Shows open into seasons and episodes (watched ones are marked); music goes artist, album, songs.
- **Play** movies and episodes: it resumes where you left off (the Roam place, not Kodi's own), keeps Roam's record up to date every 15 seconds and when you stop, queues every file of a movie that is in several parts, and starts the next episode of a season by itself. Context menu on a movie: **Play from the beginning**.
- **Your profile's scene filtering**: scenes it skips are jumped over; scenes it mutes **really are muted** (Kodi can do this reliably; a setting skips them instead). If filtering can't be applied, a note says so as playing starts.
- **Skip intro / recap / credits** buttons over the picture (OK presses; Back dismisses), or automatically for a profile set to skip them.
- **Playing-at-once limit**: it holds its place while playing and says why when something can't be played.
- **Audiobooks and songs** play (an audiobook keeps its place; songs don't).

## Not in the add-on yet

Photos, subtitles search, chapters, playlists, notifications and the ownership screens. (Kodi's own subtitle tools work on what it plays.)

## Install

1. Build the zip: `npx tsx scripts/package-kodi.ts --url https://your-roam.example [--version 1.0.0]` (writes `dist/kodi/plugin.video.roam-1.0.0.zip`).
2. In Kodi: **Settings → System → Add-ons → Unknown sources: on**, then **Add-ons → Install from zip file** and choose the zip.
3. Open **Add-ons → Video add-ons → Roam**. The first time it shows the sign-in code.

Kodi's log (`kodi.log`) shows any error the add-on hits. Settings (server address, "skip muted scenes instead of muting them", sign in and out) are under the add-on's **Configure**.

## Tests

`python3 -m unittest discover -p "test_*.py"` in `kodi/tests` (also run by `npx vitest run src/kodi`). The tests stand in for Kodi's modules (`kodi/tests/stubs`), so they check the logic, not the look.

## Where to look first if something doesn't work

- **The skip button's look.** It's a Kodi window (`resources/skins/default/1080i/roam-skip.xml`) that uses the skin's `common/white.png` for its background; a skin without that picture shows a button with no background.
- **Playing several files as one film.** Parts are queued in Kodi's playlist and the position is worked out from which one is playing (`playlist_position` and `goto_part` in `kodi_adapter.py`). If a skip across files lands in the wrong place, that's where to look.
- **Resume.** The start place is set with the `StartOffset` item property; Kodi's own "resume from…" prompt should not appear, but if it does, the property isn't being read.
- **The skip button and Kodi's on-screen controls** both want the remote's OK; the button only appears during an intro or credits.
