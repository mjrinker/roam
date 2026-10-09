# Roam on TVs

Roam has a light interface for TV browsers at `/tv` (a server-rendered page plus one small script, built for Chromium 56 so a 2018 Samsung can run it). Three ways to use it:

1. **The TV's own browser (nothing to install).** Open `https://<your-roam>/tv` in the TV's web browser and bookmark it. Samsung (Tizen), LG (webOS) and Fire TV (Silk) all have one.
2. **A launcher-icon app on Samsung or LG** (below): a tiny package that just opens `/tv`, so a Roam deploy reaches the TV with nothing to reinstall.
3. **Vizio, and any TV with Chromecast or AirPlay:** cast from a phone or computer (see the Vizio notes at the end).

## What the TV shows
Movies, TV shows, videos, audiobooks, audio, music and photos (eBooks are deliberately not on TVs). On top of browsing:
- **Search** with an on-screen keyboard (titles, books, audio files, albums and artists).
- **Recently added** and **Continue watching / listening** rows on the home screen.
- **Playlists:** list, open, **Play all** (the next item plays after each; show entries step through their episodes), and **Add to playlist** from movie, show and book pages. Playlists are created and shared on the web.
- **Photos:** by date, by album (folder) and favourites; a full-screen viewer with a slideshow; a screensaver after five idle minutes on the home screen.
- **Music:** artists, albums, songs; Shuffle and Play all for an artist; Up and Down move between songs.
- **Back remembers your place** in a list.
- **Playback speed** for video, audiobooks and audio files: Up opens a speed overlay (0.25 steps with Up and Down, 0.05 fine-tuning with Left and Right, from 0.25x to 3x). It starts at the library's default speed (an admin setting), lasts until the player is left and is never saved. Songs in a queue keep Up and Down for changing songs.

Keys: arrows move, OK chooses, Back goes back; play/pause/stop/rewind/fast-forward media keys work in players.

## Signing in on a TV
The TV shows a five-character code (and a QR code). On a phone or computer where you are signed in, open `https://<your-roam>/link`, type the code (capitals or not) and approve it. Profiles that have a PIN are not offered on TVs yet.

## Building the packages
```
npx tsx scripts/package-tv.ts --url https://<your-roam> [--version 1.0.0]
```
writes `dist/tv/tizen` and `dist/tv/webos`.

### Samsung (2018 and 2020 models: Tizen 4.0 and 5.5)
You need a free Samsung account and [Tizen Studio](https://developer.tizen.org/development/tizen-studio) (install the TV extensions from its Package Manager). Publishing to Samsung's TV store is a separate, optional process (Seller Office); installing on your own TVs needs neither.
1. On the TV: Apps, press `1 2 3 4 5` on the remote, switch **Developer mode** on, enter your computer's IP address, and restart the TV.
2. In Tizen Studio, open the Device Manager and add the TV (its IP address, port 26101) and connect.
3. Open the Certificate Manager and create a **Samsung** certificate profile: a new author certificate, then a distributor certificate for TV, signing in with your Samsung account when asked and ticking the connected TV (its DUID). Do this for each TV (the 2018 and the 2020 one can share one profile).
4. Sign and install:
   ```
   tizen package -t wgt -s <your-profile> -- dist/tv/tizen
   tizen install -n Roam.wgt -t <tv-name>
   ```
The same package works on both TV years. Samsung's tooling changes between versions; if a menu differs, Samsung's [TV developer guide](https://developer.samsung.com/smarttv/develop) is the reference. Developer-mode apps stay installed; renew the certificate when it expires.

### LG (2022 models: webOS 22)
You need a free account at [webostv.developer.lge.com](https://webostv.developer.lge.com) and the [webOS TV CLI](https://webostv.developer.lge.com/develop/tools/cli-installation) (needs Node.js).
1. On the TV, open the LG Content Store (signed in), install the **Developer Mode** app, open it, sign in with your LG developer account, switch **Dev Mode** on (the TV restarts), then open it again and switch **Key Server** on. It shows a passphrase and a countdown for how long Developer Mode lasts; extend it from the app when it runs low.
2. On your computer:
   ```
   ares-setup-device            # add the TV once (its IP, port 9922, user prisoner)
   ares-novacom --device <tv> --getkey     # enter the passphrase shown on the TV
   cd dist/tv
   ares-package webos
   ares-install --device <tv> com.roam.tv_1.0.0_all.ipk
   ares-launch --device <tv> com.roam.tv
   ```
Developer Mode apps stop working when Developer Mode lapses; switching it back on in the Developer Mode app restores them.

### Amazon Fire TV
Amazon stopped accepting web apps in its Appstore (October 2024). Use the Silk browser: open `https://<your-roam>/tv` and bookmark it. A native wrapper app can be added later.

### Vizio (2020 SmartCast)
Vizio has no app store for outside developers and no sideloading, so there is no Roam app for it. Cast to it from a phone or computer (Chromecast built in, AirPlay 2 on supported models).

## Checking changes
```
npm test                     # includes the Chromium 56 compatibility scans
TV_BROWSERS="m69=/path/to/chrome69,m86=/path/to/chrome86" npx tsx scripts/tv-browser-check.ts
```
The second drives the real pages with remote-control key presses in old Chromium builds (download them from the Chromium snapshot bucket) and also runs each with the post-Chromium-56 APIs removed.

## Newer TVs get extras

The basic pages are what a 2018 Samsung (Chromium 56) needs, and every TV gets them. The script adds a `modern` class, and loads extras, only where the browser passes feature checks (CSS grid and IntersectionObserver present):
- a wide backdrop picture behind movie and show pages, softer focus changes;
- songs that move on to the next song without loading a page (the next song's details are fetched in its last 30 seconds), a blurred cover background, the queue under the song, and Media Session (the system shows what is playing);
- **Up next** for episodes: a countdown, then the next episode starts in the same page;
- long lists load the next page as you near the end (no More button);
- the next slideshow picture is fetched ahead and fades in; the screen is asked to stay awake during music and slideshows; the picture screensaver.

Old browsers never download any of that: they get one page per step and a More button.

If one TV misbehaves with the extras, open any TV page with `?modern=0` on that TV (it is remembered; `?modern=1` turns it back on). To turn the extras off for everyone, set `TV_BASIC_ONLY=1` in the environment and redeploy.
