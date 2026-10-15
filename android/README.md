# Roam for Android, Android TV and Fire TV

One app (Kotlin, Jetpack Compose, Media3 ExoPlayer) for phones and tablets, Android TV / Google TV, and Amazon Fire TV (Fire OS 6 and later; the app needs Android 7.0, API 24). It uses the same JSON API as every other app ([`docs/api.md`](../docs/api.md)). On a TV it is driven with the remote (every card and button takes focus and shows a ring); on a phone, by touch.

## What it does

- **Signs in with a code**: the screen shows five characters and an address; type the code at `<your Roam>/link` on a phone or computer where you're signed in. The device token is kept encrypted (never written in the clear: if a device's key store is broken the sign-in lasts only for that run). The server address can be changed on the sign-in screen or in Account.
- **Who's watching** (a PIN is asked for a profile that has one), and which server if there are several.
- **Browse**: home (continue watching and listening, recently added, libraries), movie and show libraries as grids that load more as you reach the end, video folders, music (artist, album, songs), search, notifications, and an Account screen (switch profile, signed-in devices with sign-out, server address, sign out).
- **Movie and show pages**: resume or start over, episodes by season (watched and in-progress marked), chapters (open at that moment), extras and trailers, cast, the parental guide (with the Does the Dog Die credit and warning wherever its reports show) and who owns it.
- **Playing** (ExoPlayer): resumes where you left off, keeps Roam's record, plays the next episode of a season by itself, queues every file of a movie in several parts (a slice of a shared file is played as a clip), skips the scenes your profile skips and **really mutes** the ones it mutes, offers **Skip intro / recap / credits** (it takes focus on a TV; tap on a phone; Back dismisses), skips them automatically for a profile set to, says why when a title can't be played (every copy withdrawn, or all in use, with "Tell me when it's free"), and holds its place for the playing-at-once limit. The server is asked to convert audio this device can't play (DTS and so on) from what the device's decoders and HDMI pass-through report.
- **Audiobooks and songs** play too; an audiobook keeps its place.

Playlists can be opened and played (making and changing them is on the web and the TV interface). Audiobooks and songs keep playing with the screen off, with a notification and lock-screen controls. Not in the app yet: photos, subtitle search (a file's own subtitle tracks can be chosen in the player), downloads for offline, Chromecast.

## Build and test

You need JDK 17 and the Android SDK (platform 35, build-tools 35). With `ANDROID_HOME` set (or a `local.properties` with `sdk.dir=`):

```
cd android
./gradlew :app:testDebugUnitTest      # 101 tests, on the JVM (Robolectric runs the real screens, no emulator needed)
./gradlew :app:lintDebug              # Android lint
./gradlew :app:assembleDebug          # app/build/outputs/apk/debug/app-debug.apk
./gradlew :app:assembleRelease -ProamServer=https://your-roam.example   # unsigned, shrunk; the server address it starts with
```

The tests are in three groups: the API client against a mock server (`data/`), the playback logic (`player/`: scenes, skip buttons, saving, the playing-at-once limit; the same cases as the Kodi add-on's), and the screens (`ui/`: sign-in, profile and PIN, server choice, home, library, title, search, music, account, player overlay).

### On an emulator or a device

`app/src/androidTest` has tests that need a real Android: one plays a real video clip (served from the test) through the real player to the end and checks a scene is really jumped over, and one launches the whole app. With an emulator or a device attached:

```
./gradlew :app:connectedDebugAndroidTest
```

Create an emulator with the SDK's `avdmanager` (an x86_64 image, which needs hardware virtualization: KVM on Linux, or Windows' hypervisor). For Android TV use a `system-images;android-34;android-tv;x86` image (or Google TV); Fire TV runs this same app on Fire OS. These tests have been written and compile, but have not been run: the machine they were written on has no hardware virtualization, so no emulator would start.

## Releasing

A Play Store or Amazon Appstore release needs a signing key and a store account, which belong to whoever publishes it, so none is set up here. Fire TV: the same APK; Amazon's Appstore takes it with its own listing. The package is `com.roam.app`.

## Where to look first if something doesn't work on a real device

- **Playback of a file type ExoPlayer can't open.** The address of a video has no file extension, so the file's `container` (sent by the server) is passed as a hint (`mimeFor` in `player/ExoEngine.kt`).
- **The skip button and a TV remote.** The button takes focus when it appears; Back dismisses it (`PlayerHost` in `ui/Player.kt`).
- **Focus order on a TV.** Rows and grids rely on Compose's default focus search (`focusRing` in `ui/Common.kt` draws the highlight).
- **Mute.** It sets the player's own volume to zero for the scene (`ExoEngine.setMuted`), which the system volume doesn't change.
