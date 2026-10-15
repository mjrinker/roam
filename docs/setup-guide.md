# Roam on your devices: step-by-step

This is the long version of `docs/setup-checklist.md`. It assumes you have never done any of this. Do the sections in any order; the order below is easiest first.

**Nothing here has run on a real device yet.** The apps compile and their logic is tested, but each platform will have surprises. Every section ends with *what to try* and *what to send me*: send me the exact words on the screen or the log lines, and I'll fix things in batches.

Fees and menu names are what I found or remember. Stores change them, so if a screen doesn't match, trust the screen and tell me.

---

## Before you start

### Where things are

The code lives in your Ubuntu (WSL) environment at `/home/matt/code/roam`. Windows programs (Tizen Studio, a browser, Visual Studio) can see those files at:

```
\\wsl.localhost\Ubuntu\home\matt\code\roam
```

Paste that into the address bar of Windows File Explorer. Copy files you need out of `dist\` to somewhere ordinary like `C:\Roam\` to avoid trouble with long paths.

### Building the packages (one block)

In the Ubuntu terminal:

```bash
cd ~/code/roam
git pull --ff-only          # not needed if you haven't changed anything elsewhere
for s in package-tv package-roku package-kodi; do
  npx tsx scripts/$s.ts --url https://roam-three-gray.vercel.app
done
```

That writes (these already exist from my last build; rebuild after any change):

| What | Where (under `dist\`) |
|---|---|
| Samsung TV | `tv\tizen\` (config.xml, index.html, icon.png) |
| LG TV | `tv\webos\` (appinfo.json, index.html, two icons) |
| Roku | `roku\roam-roku.zip` |
| Kodi | `kodi\plugin.video.roam-1.0.0.zip` |

`--url` is the address your apps open. Use your Vercel address now; if you later buy a domain, rebuild with that.

The Android app is built differently (below), and the Xbox app is built on GitHub (below).

### A tip about signing in

Every app signs in the same way: it shows **five characters**. On a phone or computer where you're already signed in to Roam, open `https://roam-three-gray.vercel.app/link`, type them, and approve. The app signs in by itself within a few seconds. Nobody types a password on a TV.

---

## 1. Roku (free, about 15 minutes)

### 1.1 Turn on developer mode

1. With the Roku remote, press **Home three times**, **Up twice**, then **Right, Left, Right, Left, Right**. A *Developer Settings* screen appears.
2. Note the **IP address** it shows (like `192.168.1.57`).
3. Choose **Enable installer and restart**, accept the agreement, and set a **webserver password** (anything; you'll type it once). The Roku restarts.

### 1.2 Install the channel

1. On your computer (same Wi-Fi/network as the Roku) open a browser to `http://<the Roku's IP address>`.
2. It asks for a user name and password: the user is **`rokudev`** and the password is the one you just set.
3. Under **Upload**, click *Choose file* and pick `roam-roku.zip` (from `\\wsl.localhost\Ubuntu\home\matt\code\roam\dist\roku\`). Click **Install**.
4. The channel starts on the Roku immediately. It stays installed, listed on the home screen as "Roam" (a dev channel).

### 1.3 Try it

- It shows a code. Approve it at `/link`. It should move to "Who's watching?" (a PIN pad if the profile has a PIN), then the home screen.
- Try: open a library (movies or shows), open a movie, press **Play**, press **Back** and then **Resume**, open a show and play an episode and let it finish (the next should start), use **Search** (type with the on-screen keyboard), **Switch profile**, **Sign out**.
- If your profile has scenes set to skip, find one and check it jumps over. A profile that **mutes** scenes has them **skipped** on Roku (Rokus can't reliably mute); tell me if you'd rather have it play them unmuted.
- During an intro, a **Skip intro** label appears: press **Down** on the remote.

### 1.4 See what went wrong

The Roku prints a live log. From the Ubuntu terminal: `nc <Roku IP> 8085` (or `telnet <Roku IP> 8085`). Leave it open, use the app, and copy what it prints when something fails. A crash shows a **Backtrace** with file names and line numbers: copy the whole thing.

### 1.5 Updating or removing

To install a new build, repeat step 1.2 (it replaces the old one). To remove it, in the same browser page choose **Delete app**.

**Send me:** what you tapped, what you expected, what happened, and the log lines.

---

## 2. Kodi (free, about 10 minutes)

You need Kodi **19 (Matrix) or newer**. Kodi runs on Windows, Mac, Linux, Android TV, Fire TV and more; install it on a PC first (kodi.tv/download) to try the add-on.

### 2.1 Install the add-on

1. Copy `plugin.video.roam-1.0.0.zip` from `\\wsl.localhost\Ubuntu\home\matt\code\roam\dist\kodi\` to somewhere on the device running Kodi.
2. In Kodi: **Settings** (the cog) → **System** → **Add-ons** → turn on **Unknown sources** (accept the warning).
3. Go back to **Add-ons** → **Install from zip file** → find the zip → choose it. After a moment a notice says "Roam add-on installed".
4. Open **Add-ons → Video add-ons → Roam**.

On a Fire TV or Android TV running Kodi, put the zip somewhere Kodi's file browser can reach (a USB stick, or a network share added as a source).

### 2.2 Try it

- First time: a dialog shows a code and an address. Approve it at `/link`; the dialog closes by itself and the menu appears.
- Browse **Continue watching**, **Recently added**, a library, **Search**. Open a show: seasons then episodes (watched ones marked).
- Play a movie. Stop it, then play it again: it should resume. During an intro a **Skip intro** button appears over the picture (press **OK** on it; **Back** hides it).
- A scene your profile **mutes** is really muted by Kodi (there's a setting to skip them instead: add-on **Configure**). A scene your profile skips is jumped over.
- Right-click (or long-press) a movie: **Play from the beginning**.
- Open **Configure** on the add-on to change the server address or sign out.

### 2.3 Logs

Turn on **Settings → System → Logging → Enable debug logging**, reproduce the problem, then open `kodi.log`:

- Windows: `%APPDATA%\Kodi\kodi.log`
- Linux/Raspberry Pi: `~/.kodi/temp/kodi.log`
- Android: `Android/data/org.xbmc.kodi/files/.kodi/temp/kodi.log`

Search it for `roam` and `Traceback`; send me the lines around any `Traceback`.

---

## 3. Android phone, Android TV and Fire TV (free to try)

Everything for Android is already installed on this machine under `~/tools` and `~/Android/sdk`.

### 3.1 Build the app

In the Ubuntu terminal:

```bash
cd ~/code/roam/android
source dev-env.sh                       # sets JAVA_HOME and puts adb on your PATH
./gradlew :app:assembleDebug            # about 1–3 minutes the first time
```

The result is `android/app/build/outputs/apk/debug/app-debug.apk` (about 14 MB). A faster check without building: `./gradlew :app:testDebugUnitTest` runs the 101 automated tests.

### 3.2 Put it on an Android phone

The simplest way is **Wi-Fi debugging**, which works from Ubuntu without cables:

1. On the phone: **Settings → About phone** → tap **Build number** seven times (this turns on Developer options). Then **Settings → System → Developer options** → turn on **Wireless debugging**.
2. Tap **Wireless debugging** → **Pair device with pairing code**. It shows an IP, a port and a six-digit code.
3. In Ubuntu: `adb pair <IP>:<pairing port>` and type the code.
4. Back on the *Wireless debugging* screen note the **IP address & port** (a different port) and run `adb connect <IP>:<port>`.
5. `adb install -r app/build/outputs/apk/debug/app-debug.apk`. The "Roam" icon appears.

(Alternatively, copy the `.apk` to the phone however you like, open it, and allow "install from this source". Android will warn about an unknown app; that's expected for a build you made.)

### 3.3 Put it on an Android TV / Google TV

1. TV: **Settings → Device Preferences → About** → press OK on **Build** seven times. Then **Settings → Device Preferences → Developer options** → turn on **USB debugging** (and **Network debugging** / **Wireless debugging** if offered). Find the TV's IP under **Settings → Network**.
2. Ubuntu: `adb connect <TV IP>:5555` (accept the prompt on the TV), then `adb install -r app/build/outputs/apk/debug/app-debug.apk`.
3. Open it from the apps row. Use the remote's D-pad: the highlighted card, button or row has a teal ring.

### 3.4 Put it on a Fire TV

1. Fire TV: **Settings → My Fire TV → Developer Options** → turn on **ADB debugging** and **Apps from Unknown Sources**. (If you don't see Developer Options: **My Fire TV → About**, then click the device name seven times.)
2. Find its IP: **Settings → My Fire TV → About → Network**.
3. Ubuntu: `adb connect <Fire TV IP>:5555`, accept on the TV, `adb install -r ...app-debug.apk`.
4. Open it from **Settings → Applications → Manage Installed Applications**, or hold the Home button and choose Apps.

**Check your model first:** Amazon's newest Fire TV Stick 4K Select uses Amazon's own "Vega OS" and does not run Android apps. Older Fire TV devices (Fire OS 6, 7, 8) do.

### 3.5 Try it

Sign in with the code, choose a profile, then: open a movie, **Play**, back out and **Resume**; play an episode to the end and check the next one starts; try a title whose audio is DTS (the server should convert it for this device); with a scene-skipping profile, find a skipped scene and a muted one; an intro (**Skip intro** takes focus; press OK on a TV, tap on a phone); the playing-at-once message (if you've turned that on); Account → Signed-in devices.

### 3.6 Logs

- Everything: `adb logcat -d | tail -300`
- Only this app's crashes: `adb logcat -b crash -d`
- This app only: `adb logcat --pid=$(adb shell pidof com.roam.app)`

### 3.7 Let me run emulators here (optional but very useful)

The machine I work on has no hardware virtualization, so I can't start Android emulators. To enable it:

1. Make sure virtualization is on in your PC's **BIOS/UEFI** (Intel VT-x or AMD-V / SVM). This is usually under Advanced → CPU.
2. You need **Windows 11**. In File Explorer open `%UserProfile%` and create or edit **`.wslconfig`** (no extension) so it contains:
   ```
   [wsl2]
   nestedVirtualization=true
   memory=12GB
   ```
   (Use less memory if your PC has under 16 GB.)
3. In PowerShell: `wsl --shutdown`. Then reopen Ubuntu.
4. Check: `ls -l /dev/kvm` should list a file. If it says "No such file", virtualization isn't reaching WSL.
5. Tell me. I'll install an x86_64 phone and TV image and run the emulator tests (they play a real video through the real player).

### 3.7b Push notifications (optional, free)

By default the app only lists notifications when you open it. To have them arrive on the phone or TV:

1. Go to console.firebase.google.com and create a project (any name; Analytics can be off).
2. In the project, add an **Android app** with the package name `com.roam.app`. Skip the optional steps; download **`google-services.json`** and put it in `android/app/` (it is git-ignored, so it never goes into the repository). Build the app again; it picks the file up by itself.
3. In the project's **Settings, Service accounts**, press **Generate new private key**. A JSON file downloads. Open it, copy its entire contents, and in Vercel (project settings, Environment Variables) add **`FCM_SERVICE_ACCOUNT`** for Production with that text as the value. Redeploy.
4. Open the app once while signed in (on Android 13 or later it asks to allow notifications; say yes). From then on every notification Roam makes also goes to that device. A device that uninstalled the app is forgotten automatically.

Treat the private key like a password: don't paste it anywhere but Vercel. If you skip all of this nothing breaks.

### 3.8 Publishing (later, costs money)

You need a **signing key**. Make it once and keep it safe; **losing it means you can never update the app**:

```bash
keytool -genkeypair -v -keystore ~/roam-release.jks -alias roam -keyalg RSA -keysize 2048 -validity 10000
```

Back it up somewhere other than this machine. Then tell me and I'll set up signing and build the upload file (an `.aab`; an unsigned one already builds with `./gradlew :app:bundleRelease`).

- **Google Play** ($25 once): create a developer account at play.google.com/console. The app goes through an internal testing track first. New personal accounts have been required to run a **closed test with about 12 testers for 14 days** before production release (check Google's current rule).
- **Amazon Appstore** (free): developer.amazon.com, add an app, upload the APK, choose Fire TV, and use Amazon's testing steps.

**Send me:** the screen you were on, what you did, and the `adb logcat -b crash -d` output if it closed.

---

## 4. Samsung TV (free; the longest because of review)

Do this on a **Windows** computer (Samsung's tools are Windows/Mac/Linux desktop programs; the packages you built are just files).

### 4.1 What you need

- A free **Samsung account** (account.samsung.com).
- **Tizen Studio** (developer.tizen.org → Tizen Studio → download the Windows installer) with its **Package Manager** open afterwards: under the **Extension SDK** tab install **TV Extensions** and **Samsung Certificate Extension**.
- A Samsung TV from 2018 or later (Tizen 4.0+).

### 4.2 Put the TV in developer mode

1. On the TV: open **Apps**, then press **1 2 3 4 5** on the remote. A *Developer mode* box appears.
2. Switch it **ON**, enter the **IP address of your Windows PC** (not the TV's), and press OK. Restart the TV.
3. In Tizen Studio open the **Device Manager** (Tools → Device Manager), click **Remote Device Manager**, **+**, and add the TV: its name, its IP address, port **26101**. Turn the connection on. Note the TV's **DUID** (shown after connecting).

### 4.3 Make a certificate (once)

1. Tizen Studio → **Tools → Certificate Manager** → **+** → **Samsung** certificate → **TV**.
2. Create a new **author certificate** (choose a name and a password you'll remember).
3. Create a **distributor certificate**: choose the privilege level **Public**, and **add your TV's DUID** (needed so the TV accepts the app in developer mode).
4. Give the profile a name, like `roamprofile`.

### 4.4 Install it on your own TV first

Copy `dist\tv\tizen\` from the WSL path to `C:\Roam\tizen\`. Open **PowerShell** (Tizen Studio's tools are in `C:\tizen-studio\tools\ide\bin`; add it to your PATH or use the full path):

```
tizen package -t wgt -s roamprofile -- C:\Roam\tizen
tizen install -n Roam.wgt -t <your TV's name in Device Manager> -- C:\Roam\tizen
```

(The package command prints the `.wgt` file's name and folder.) The app then shows in the TV's apps list. Open it: you should see "Opening Roam…" then the Roam TV screen with a code.

### 4.5 Submit to the Samsung store

Full requirements are in `docs/store-submission.md`. In short:

1. Register at the **Samsung TV Seller Office** (seller.samsungapps.com/tv) as an individual seller.
2. Choose your final **app name** (it must be unique in the Seller Office; "Roam" is probably taken).
3. **Add application** → upload the signed `.wgt` → run the **pre-test** it offers and fix what it reports.
4. Fill in the listing text and images (suggested text in `docs/store-submission.md`; screenshots at 1920×1080 from the TV or Tizen emulator), the privacy policy address (`https://roam-three-gray.vercel.app/privacy`), the **reviewer account** (email and password; tell them to approve the TV's code at the `/link` page), and the **App UI Description** (built from Samsung's template; the section "What the app does" in the store doc gives the content).
5. Choose the TV model groups (Tizen 4.0 and 5.5 cover 2018–2020; add newer ones) and submit. Results arrive by email; a rejection lists what to fix. Fixes are resubmitted as a **new version** (same package ID `RoamTv0001`, a higher version number: rebuild with `--version 1.0.1`).

**Send me:** anything the pre-test or reviewers reject, word for word.

---

## 5. LG TV (free)

### 5.1 What you need

- A free **LG developer account** at webostv.developer.lge.com.
- **Node.js** on Windows (nodejs.org, the LTS), then in PowerShell: `npm install -g @webos-tools/cli`. Check with `ares --version`.
- An LG TV with webOS 22 or newer (the package is written for that; older may work).

### 5.2 TV in developer mode

1. On the TV open the **LG Content Store**, search for **Developer Mode**, install the app, open it, and sign in with your LG developer account.
2. Switch **Dev Mode Status** to **ON**; the TV restarts. Open the app again and switch **Key Server** to **ON**. It shows a **passphrase** and a countdown (it lasts a limited time, about 50 hours; open the app and use *Extend* to keep going).
3. Note the TV's IP address (Settings → Network).

### 5.3 Install it on your own TV first

Copy `dist\tv\` to `C:\Roam\tv\`. In PowerShell:

```
ares-setup-device           # choose "add": name it (e.g. lgtv), host = the TV's IP, port 9922, user prisoner
ares-novacom --device lgtv --getkey      # type the passphrase from the TV
cd C:\Roam\tv
ares-package webos
ares-install --device lgtv com.roam.tv_1.0.0_all.ipk
ares-launch --device lgtv com.roam.tv
```

It opens "Opening Roam…" then the code screen. Debug output: `ares-inspect --device lgtv --app com.roam.tv --open` opens Chrome DevTools on the TV.

### 5.4 Submit to the LG store

1. Register at **LG Seller Lounge** (seller.lgappstv.com) as an individual or company seller.
2. From LG's **App Self Checklist** page, download the **current** checklist template (an old one gets your app rejected without review) and fill it in honestly. Don't mark things "N/A" if they aren't.
3. Write the **UX scenario** document: the screens and keys (copy from the "What the app does" section of `docs/store-submission.md`).
4. Upload the `.ipk`, the checklist, the scenario, the listing text and images, and the reviewer account. Submit.
5. QA reports back; fix and resubmit with a higher version (`--version 1.0.1`).

**Send me:** any failures from QA, word for word.

---

## 6. Xbox (about $19 for developer mode; a PC test first is free)

### 6.1 Build the app on GitHub

You can't build this on Linux; GitHub does it for you:

1. Go to github.com/mjrinker/roam → **Actions** → **Xbox app** (left column) → **Run workflow**.
2. In the box, type `https://roam-three-gray.vercel.app` (or leave it empty for the default) → **Run workflow**.
3. After about 3 minutes click the finished run → scroll to **Artifacts** → download **roam-xbox**. Unzip it. Inside `xbox/AppPackages/Roam.Xbox_1.0.0.0_x64_Test/` there's an `.appx`, a `Dependencies` folder, `Add-AppDevPackage.ps1`, and `Roam.Xbox.cer` is at the top.

### 6.2 Try it on your Windows PC first (free)

The Xbox app is a normal Windows app too, so test it on your PC:

1. Right-click **`Add-AppDevPackage.ps1`** → **Run with PowerShell**. It asks to turn on developer mode and install the test certificate; say yes.
2. Open **Roam** from the Start menu. It should show the Roam TV screen (a code). Use the **arrow keys, Enter and Esc** (these are the same buttons as the controller). If you have a controller plugged in, try it.

### 6.3 Put it on the console

1. Create a **Microsoft Partner Center** developer account at partner.microsoft.com (the individual account has a one-time fee, about $19; check the page).
2. On the Xbox: open the **Microsoft Store**, search **Xbox Dev Mode Activation**, install it, sign in with your Partner Center account, and follow it. The console restarts into **Dev Home**.
3. Dev Home shows the console's IP address. On your PC open `https://<console IP>:11443` in a browser (accept the certificate warning). The first time it asks you to **pair** with a PIN shown on the console.
4. In the portal, **Home → Add**, choose the `.appx` and add the files in the `Dependencies` folder when asked (and the `.cer` if it asks), then **Go**. When it finishes the app appears in Dev Home.
5. Launch **Roam** from Dev Home. Try: the code screen, the controller (A chooses, B goes back, D-pad moves, Menu plays/pauses), a movie with a skipped scene, and a skip button.
6. When you're done testing, **Dev Home → Leave Developer mode** to return the console to normal (apps you installed this way are removed).

### 6.4 Publishing (later)

In Partner Center reserve the app name; it gives you a **Package identity** (a name and a publisher). Send those to me (or change `xbox/Roam.Xbox/Package.appxmanifest` yourself), I'll set up a Store-ready build, and you submit it with the listing, age rating, and the reviewer account.

**Send me:** what the console or PC showed when it went wrong. If a controller button does nothing, or does two things, say which.

---

## 7. iPhone, iPad and Apple TV

Not written yet: Apple's tools run only on a Mac. When you have one (or rent a cloud Mac) tell me and I'll write the apps against the same API. Costs when you get there: **$99 a year** for the Apple Developer Program. Until then, Roam works on iPhone and iPad in Safari, and you can use **Share → Add to Home Screen** to put it on the Home Screen like an app. For Apple TV, you can use AirPlay from the web version on an iPhone.

---

## 8. Things on the server side

### 8.1 Does the Dog Die

1. Vercel → your project → **Settings → Environment Variables** → add **`DDD_API_KEY`** with the key from your `.env.local` file (`grep ^DDD_API_KEY ~/code/roam/.env.local` in Ubuntu) → tick **Production** → save → redeploy (push anything, or Deployments → ⋯ → Redeploy).
2. Open `https://roam-three-gray.vercel.app/platform`, find your server, set Does the Dog Die access to **Full**.
3. Send the email to licensing@doesthedogdie.com that I drafted earlier (asking about auto-skipping with community timestamps, multi-household use on the free tier, and Scene Alerts). If you can't find it, ask me and I'll write it again.

### 8.2 Subtitle mutes (about 1,000 files left)

In Ubuntu, once a day:

```bash
cd ~/code/roam
npx tsx --env-file=.env.local scripts/build-language-filters.ts --loose --limit 20
```

It stops cleanly when OpenSubtitles' daily limit is reached. Or ask me to run it. The results are guesses at the timing; if a mute lands in the wrong place on a movie, use the flag panel (admin) to mark the scene by hand.

### 8.3 Ownership

Server settings → **Who owns what** → turn it on. Then use **Select → Set owner** in a library to assign households a batch at a time, and the **Owner** filter (with **No owner**) to find what's left. Turn on the playing-at-once limit in the same card if you want it.

---

## When something doesn't work: what to send me

Whatever the platform, these help me most:

1. **The device and its software version** (for example "Roku Ultra 4800, Roku OS 13", "Pixel 8, Android 15", "Samsung QN90B").
2. **What you did**, step by step, and **what you expected**.
3. **What happened**: the exact words on the screen (a photo of the TV is fine).
4. **The log**: Roku `nc <ip> 8085`; Kodi `kodi.log`; Android `adb logcat -b crash -d`; LG `ares-inspect`; Samsung Tizen Studio's *Web Inspector*; Xbox the Device Portal's debug output.
5. **Which profile** you were signed in as (filters, PIN, or age limits change what you see).

Send a few problems at once, and I'll fix them together.
