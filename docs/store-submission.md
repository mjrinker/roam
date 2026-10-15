# Publishing the TV app on Samsung and LG

The TV app is a small package that opens `https://<your Roam>/tv`, so every deploy of Roam reaches TVs without a new store release. Building it is done (`scripts/package-tv.ts`); this page is the rest: the accounts, the paperwork and the listing text. Store rules change, so check each store's own page where this says to.

## Decide first

1. **The address baked into the app.** The package opens one fixed address, and changing it later means a new store release for every TV app version. `roam-three-gray.vercel.app` is a Vercel-assigned name; use a domain you own and keep for good (set `NEXT_PUBLIC_APP_URL` to it too, since sign-in sessions belong to one hostname).
2. **The app's name.** Samsung requires app names to be unique within its Seller Office, and "Roam" is a common word. Pick something distinctive ("Roam Media", "Roam for TV") and check it is free before you build everything around it.
3. **A review account.** Reviewers must be able to get past the sign-in screen. Make an account on your demo server (not your own), with a few free-to-show titles, and put its email and password in the review notes. A TV signs in by showing a code that someone approves at `/link`, so tell reviewers: "On any phone or computer, sign in at <site>/link with this account and type the code the TV shows."
4. **A support email and the policy pages.** Both stores ask for them: privacy policy `https://<your site>/privacy` (exists), terms `https://<your site>/terms` (check it exists).

## Samsung (Tizen)

Needs: a free Samsung account, Tizen Studio with the TV extensions, and a **Samsung certificate profile** (author certificate plus a distributor certificate; the store checks the package is signed with `author-signature.xml` and `signature1.xml`).

1. Register as a seller at the Samsung TV **Seller Office** (<https://seller.samsungapps.com/tv>). Individuals can register; check whether any fee applies on the registration page.
2. Build and sign:
   ```
   npx tsx scripts/package-tv.ts --url https://YOUR-DOMAIN --version 1.0.0
   tizen package -t wgt -s <your-profile> -- dist/tv/tizen
   ```
   The version must be `[0-255].[0-255].[0-65535]`. Updates keep the same Tizen package ID (`RoamTv0001`) and a higher version.
3. In the Seller Office: register the app (this gives a Seller Office App ID, which is different from the Tizen ID), upload the signed `.wgt`, and run the **pre-test** it offers while uploading.
4. Fill in the listing (below) and the **App UI Description**, which must be built from Samsung's own template without adding or removing parts, and must be refreshed with every update.
5. Choose the model groups it should run on (Tizen 4.0 and 5.5 cover the 2018 and 2020 TVs), submit, and wait for the certification email. A failed app is fixed and resubmitted as a new version.

## LG (webOS)

Needs: a free LG account, the webOS TV CLI (`ares-*`), and an **LG Seller Lounge** seller account (<https://seller.lgappstv.com>; individual or company).

1. Build the package: `npx tsx scripts/package-tv.ts --url https://YOUR-DOMAIN --version 1.0.0`, then from `dist/tv`: `ares-package webos` (writes `com.roam.tv_1.0.0_all.ipk`).
2. Download the **current** App Self Checklist from LG's page (<https://webostv.developer.lge.com/distribute/app-self-checklist>) and fill it in honestly: marking an item N/A when it isn't is grounds for rejection, and a submission made with an old template is not reviewed. It covers content, UX, and how privacy and credentials are used.
3. Write the **UX scenario** document LG asks for (the screens and the remote's keys: see "What the app does" below).
4. In Seller Lounge, register the app, upload the `.ipk`, the checklist, the scenario, the listing and the review account, and submit. QA follows; a rejection lists the issues to fix.

## What the app does (for the UX scenario and the UI description)

- Opens, shows "Opening Roam…", and goes to the site. If the TV has no network or the site can't be reached, it says "Roam can't be reached. Check the TV's network connection." and tries again.
- First use: a five-character code and a QR code. Typing the code at the site's `/link` page on a phone or computer, signed in, signs the TV in. Nobody types a password on the TV.
- Then "Who's watching?" (profiles; a profile with a PIN shows a PIN pad), the home screen (continue watching, recently added, libraries, Playlists, Notifications, Search), and lists and detail pages for movies, shows, audiobooks, music, folders and photos.
- Keys: arrows move, **OK** chooses, **Back** goes back, play/pause/stop/rewind/fast-forward work in players. **Up** in the video player opens speed, subtitles and quality.
- It plays only what the signed-in person's server has shared with them. It contains no media of its own, no purchases, no advertising and no sign-up on the TV.

## Listing text (starting point)

**Short description:** Your own movies, shows, music and audiobooks from your Roam server, on the big screen.

**Description:** Roam is a private media server for you and the people you share with. This app puts your library on your TV: pick up where you left off, browse movies and shows, listen to music and audiobooks, and see your photos. Skip intros and credits with one press, mute or skip scenes your profile has chosen not to see, and keep your watch history across devices. Sign in without typing a password: the TV shows a code that you approve from your phone. You need a Roam account and a server that has been shared with you; the app has no content of its own.

**Category:** Video / Entertainment (use whichever the store offers closest to "media player").
**Age rating:** the app has no content of its own; answer the questionnaires for a media player that shows only what the user's own server holds.
**Keywords:** media server, movies, TV shows, music, audiobooks, photos, library.
**Privacy:** the policy page above. The app stores nothing on the TV beyond its sign-in; media streams from the storage the server's owner connected.

## Images (check each store's current sizes)

Both stores want an app icon, screenshots at TV resolution (1920×1080) and sometimes a splash/background image. The package already carries icons: 117×117 for Samsung, 80×80 and 130×130 for LG (`dist/tv/…`, drawn from `public/roam-logo.svg`). The store listing icon sizes differ from the in-package ones: take the sizes from each store's page when you register. Screenshots are best taken from a real TV or the Tizen/webOS emulators signed in to the review account, showing the home screen, a movie page and the player.
