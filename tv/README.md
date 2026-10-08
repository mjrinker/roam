# Roam on TVs

Roam has a light interface for TV browsers at `/tv` (a server-rendered page plus one small script, built for Chromium 56 so a 2018 Samsung can run it). Three ways to use it:

1. **The TV's own browser (nothing to install).** Open `https://<your-roam>/tv` in the TV's web browser and bookmark it. Samsung (Tizen), LG (webOS) and Fire TV (Silk) all have one.
2. **A launcher-icon app on Samsung or LG** (below): a tiny package that just opens `/tv`, so a Roam deploy reaches the TV with nothing to reinstall.
3. **Vizio, and any TV with Chromecast or AirPlay:** cast from a phone or computer (see the Vizio notes at the end).

## Signing in on a TV
The TV shows a code. On a phone or computer where you are signed in, open `https://<your-roam>/link`, type the code and approve it. Profiles that have a PIN are not offered on TVs yet.

## Building the packages
```
npx tsx scripts/package-tv.ts --url https://<your-roam> [--version 1.0.0]
```
writes `dist/tv/tizen` and `dist/tv/webos`.

### Samsung (2018 and 2020 models: Tizen 4.0 and 5.5)
You need a free Samsung developer account and [Tizen Studio](https://developer.tizen.org/development/tizen-studio) (the TV extensions and the Certificate Manager).
1. On the TV: Apps, press `1 2 3 4 5`, switch **Developer mode** on and enter your computer's IP address, then restart the TV.
2. In Tizen Studio's Certificate Manager create a **Samsung** certificate profile (author and distributor, for the TV's DUID).
3. Sign and install:
   ```
   cd dist/tv/tizen
   tizen package -t wgt -s <your-profile> -- .
   sdb connect <tv-ip>
   tizen install -n Roam.wgt -t <tv-name>
   ```
The same package works on both TV years. Developer-mode apps stay installed; the certificate must be renewed when it expires.

### LG (2022 models: webOS 22)
Install the [webOS TV CLI](https://webostv.developer.lge.com/develop/tools/cli-installation) and the *Developer Mode* app on the TV (sign in with an LG developer account, switch Dev Mode on, note the passphrase).
```
cd dist/tv
ares-setup-device            # add the TV once (host, port 9922, user prisoner)
ares-novacom --device <tv> --getkey
ares-package webos
ares-install --device <tv> com.roam.tv_1.0.0_all.ipk
ares-launch --device <tv> com.roam.tv
```
Developer Mode apps are removed when the Dev Mode session lapses (renew it in the Developer Mode app about every 50 hours).

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
