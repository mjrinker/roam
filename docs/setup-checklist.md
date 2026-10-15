# Setting everything up: the checklist

Everything below is written and in the repository. What is left is yours to do because it needs your accounts, your devices, or your decisions. It is in a sensible order, easiest first. Each item says what it costs, what to run, and what to tell me if it doesn't work (I can fix anything I'm shown an error or a description for). **Nothing here has run on a real device yet**, so expect to send back some bugs.

Fees are what I found or remember, not guaranteed: check each store's own page before paying.

## 0. A few things on the server (already done, or quick)

- [x] Push notifications: the three `VAPID_*` variables are in Vercel.
- [ ] **Does the Dog Die** (optional): add `DDD_API_KEY` in Vercel Production (it's in `.env.local`), then set your server to **Full** at `/platform`. The email to licensing@doesthedogdie.com (asking about auto-skipping with community timestamps, multi-household use, and Scene Alerts) was drafted and is still yours to send.
- [ ] **Subtitle mutes**: `npx tsx --env-file=.env.local scripts/build-language-filters.ts --loose --limit 20` once a day (OpenSubtitles' download limit is about 15 to 25 a day; about 1,000 files are left). Or ask me to run it.
- [ ] **Ownership**: switch it on in Server settings, then assign owners with Select, Set owner (and filter by Owner, No owner).

## 1. Decisions that the store apps need

- [ ] **The app's name.** "Roam" is probably taken in Samsung's store (names must be unique there). Pick something distinctive.
- [ ] **A reviewer account**: a demo account on your demo server with a few free-to-show titles. Reviewers type its password at `/link` on their own device to approve the TV's code (see `docs/store-submission.md`).
- [ ] A **support email** for the store listings.

## 2. Samsung and LG TVs (free, as far as I know)

Guide: `docs/store-submission.md` (accounts, certificate, paperwork, listing text, what the app does for the UI description).

1. `npx tsx scripts/package-tv.ts --url https://roam-three-gray.vercel.app --version 1.0.0`
2. **Samsung**: Seller Office account, Tizen Studio, a Samsung certificate profile; `tizen package -t wgt -s <profile> -- dist/tv/tizen`; upload, run the pre-test, fill in the UI description, choose model groups.
3. **LG**: Seller Lounge account, the webOS CLI, the **current** self-checklist from LG's site; `cd dist/tv && ares-package webos`; upload with the checklist and the UX scenario.
4. Before either, try the app on your own TVs in developer mode (`tv/README.md`).

## 3. Roku (free)

1. Developer mode on the Roku (Home ×3, Up ×2, Right, Left, Right, Left, Right) and set a password.
2. `npx tsx scripts/package-roku.ts --url https://roam-three-gray.vercel.app`
3. Open `http://<roku address>` in a browser, upload `dist/roku/roam-roku.zip`. Watch its log with `telnet <roku address> 8085`.
4. Tell me what it prints. Details and the likeliest trouble spots: `roku/README.md`.

## 4. Kodi (free)

1. `npx tsx scripts/package-kodi.ts --url https://roam-three-gray.vercel.app`
2. In Kodi: allow unknown sources, then Add-ons, Install from zip file, `dist/kodi/plugin.video.roam-1.0.0.zip`.
3. Open Add-ons, Video add-ons, Roam and sign in with the code. Details: `kodi/README.md`.

## 5. Android, Android TV and Fire TV

Free to try, $25 once to publish on Google Play, free to publish on Amazon's Appstore.

1. **To run it on a device**: on a phone, build and install (`cd android && ./gradlew :app:assembleDebug`, then `adb install app/build/outputs/apk/debug/app-debug.apk`). The toolchain is already installed on this machine (`~/tools`, `~/Android/sdk`). A Fire TV or Android TV can be installed the same way over the network (`adb connect <tv address>` with developer options on).
2. **To let me run emulators here**: Windows, edit `%UserProfile%\.wslconfig` to contain `[wsl2]` and `nestedVirtualization=true` (and a larger `memory=`, 12GB or more), then `wsl --shutdown`; it needs virtualization turned on in the BIOS and Windows 11. Then tell me and I'll run the emulator tests and fix what they show.
3. **To publish**: a signing key (`keytool -genkeypair ...`, keep it safe: losing it means you can't update the app), then a Play Console account ($25) and/or an Amazon developer account. I can set up the signing configuration once you've made the key.
4. **Push notifications to the app (optional, free)**: at console.firebase.google.com make a project, add an Android app with package name `com.roam.app`, and download `google-services.json` into `android/app/` (git-ignored) before building. Then in the project's settings, Service accounts, generate a private key and put the whole JSON file's contents in the Vercel Production variable `FCM_SERVICE_ACCOUNT`, and redeploy. Without these the app works the same, just without phone notifications. (The database column it needs is already applied.)

## 6. Xbox (about $19, from a community source)

1. GitHub, Actions, **Xbox app**, Run workflow, type `https://roam-three-gray.vercel.app` (or leave empty), download the **roam-xbox** artifact.
2. A Microsoft Partner Center developer account, then turn on developer mode on the console; add the package in Device Portal. Details and what to look at first: `xbox/README.md`.
3. For the Microsoft Store: reserve the name in Partner Center and swap its package identity into `xbox/Roam.Xbox/Package.appxmanifest`.

## 7. Apple: iPhone, iPad and Apple TV (not started)

These are the only apps **not written**: they need a Mac (Xcode) to build and test, which isn't available here. The Apple Developer Program is $99 a year. When you have a Mac (or want to rent a cloud one), tell me and I'll write the Swift apps against the same API (`docs/api.md`); an iPhone app also gives Sonos through AirPlay. Until then the web app works on iOS in Safari (and can be added to the Home Screen).

## What I'd do first

Roku (3) and Kodi (4) take minutes and show whether the approach works; then the Android phone (5, step 1); then the two TV stores (2), which take the longest because of review. Send me every bug and I'll fix them in batches.
