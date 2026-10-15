# Roam for Roku

A Roku channel written in BrightScript and SceneGraph. It uses the same JSON API as every other app ([`docs/api.md`](../docs/api.md)).

**Status: written and compiled, not yet run on a Roku.** There is no Roku emulator, so everything here is checked by the BrighterScript compiler (`src/roku/channel.test.ts` fails on any error) but nothing has been tried on a real device. Expect to find things that need fixing the first time it runs; the places most likely to need a tweak are listed at the end.

## What it does

- Signs in with a code (the screen shows five characters; type them at `<your Roam>/link` on a phone or computer, signed in). The sign-in is kept on the Roku.
- Who's watching (a PIN pad for a profile with a PIN), and which server if there are several.
- Home: continue watching, recently added, your movie, show and video libraries, search, switch profile, sign out.
- Libraries as poster grids (more load as you scroll), video folders, movie and show pages (a show lists one season's episodes and can change season), search.
- **Playlists** (Home, More): the playlists you can see; an episode plays at once with the ones after it queued, a movie or show opens its page. Audiobooks and photos in a playlist are left out.
- **Chapters** on a movie's page (each plays from where it starts) and **subtitles**: choose a language, search, pick one; it is shown as words on the picture while the movie plays (movies only, not episodes yet; Roku's own menu still handles tracks inside a file).
- **Mark as watched / not watched** on a movie's or show's page.
- Playing: resumes where you left off (or **Start over**), keeps your place, plays the next episode of a season by itself, skips the scenes your profile skips, and offers **Skip intro / recap / credits** (press **Down**; a profile that skips them automatically does). It holds its place when the server limits how many can watch a title at once, and says why when it can't play something.

## Not on the Roku yet

Audiobooks and music, photos, notifications, the parental guide, and ownership screens. Roku also can't reliably switch a scene's sound off on every model, so a profile that **mutes** a scene has it **skipped** instead (`roamMuteAsSkip()` in `source/config.brs`).

## Install it on your Roku (developer mode)

1. Build the package: `npx tsx scripts/package-roku.ts --url https://your-roam.example [--version 1.0.0]` (writes `dist/roku/roam-roku.zip`).
2. On the Roku, turn on developer mode: on the remote press **Home three times, Up twice, Right, Left, Right, Left, Right**, then enable the installer and set a password. Note the Roku's address.
3. In a browser on the same network open `http://<roku address>`, sign in (user `rokudev`, your password), choose the zip under **Upload**, and **Install**. The channel starts at once. While it runs, `telnet <roku address> 8085` shows its log, which is where errors appear.

A channel installed this way stays on the Roku until you remove it. Publishing it in the Roku Channel Store is a separate process with its own review (Roku certifies channels against a published checklist; check Roku's current requirements before submitting).

## Where to look first if something doesn't work

- **A video won't open.** The address of a video has no file extension, so the channel tells Roku the container from the `container` the server sends for each file (`streamFormatFor` in `PlayerScreen.brs`). Anything but mp4, mkv or webm is tried as mp4.
- **Playing a movie that is in several parts** moves from one file to the next with a short pause between them.
- **Keys during playback.** The video node keeps the **OK** key for pause; the skip button is on **Down**. If Down is also used by Roku's own controls on some firmware, `onKeyEvent` in `PlayerScreen.brs` is where to change it.
- **The PIN pad** uses Roku's own `PinDialog` (`RoamScene.brs`); its fields differ slightly between firmware versions.
- **Folders** in a video library open in place; Back goes out of the library, not up a folder.
