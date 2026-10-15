# Roam for Xbox

A small UWP app (C#, WinUI 2) whose whole job is to show Roam's TV interface (`<your Roam>/tv`, the same pages Samsung and LG TVs use) in a WebView2 control, with the controller's buttons passed to the page as the keys it already understands. Because it is the TV interface, every improvement to that interface reaches the Xbox with no new release.

**Status: builds and passes its tests on a Windows build machine, but has not been run on an Xbox.** Nothing about how the web view and the controller behave on a console can be seen without one; the first thing to check is listed at the end.

## What it does

- Opens `<your Roam>/tv`: sign in with a code (type it at `/link` on a phone or computer), profiles with PIN pad, home, libraries, movie and show pages with the parental guide, chapters, extras and ownership, search, playlists you can make and arrange, notifications, and the video player with skipped and muted scenes and skip buttons. See `tv/README.md`.
- Controller: D-pad and left stick move, **A** chooses, **B** goes back, **Menu** plays and pauses, the shoulder buttons rewind and fast-forward.
- Stays on Roam's own pages: the window refuses to navigate anywhere else (and has no address bar to notice a wrong turn). If Roam can't be reached it says so and tries again.
- It tells the page it is an Xbox, so the name shown when you approve its sign-in code is "Xbox".

## How it is built

There is no Windows build tool on a Linux machine, so the build runs on GitHub: **`.github/workflows/xbox.yml`** builds the package on a Windows runner, runs the app's tests (`xbox/Roam.Xbox.Tests`: which pages it may open, the controller mapping), and publishes the package. Run it from the repository's **Actions** tab, **Xbox app → Run workflow**, typing your Roam's address (https, no path) if it isn't `https://roam-three-gray.vercel.app` (that default is in `Roam.Xbox/Config.cs`). The result is the artifact **roam-xbox**: the `.appx` package, its dependency packages and `Roam.Xbox.cer`, signed with a certificate made for that build.

With Visual Studio 2022 (the Universal Windows Platform workload) you can also open `xbox/Roam.Xbox/Roam.Xbox.csproj` and build or deploy straight to a console.

## Putting it on your Xbox (developer mode)

1. Turn on developer mode on the console. Microsoft's developer-mode activation needs a Microsoft Partner Center developer account (I've read that this is a one-time fee of about $19, but check Partner Center for the current terms), and the console then restarts into **Dev Home**.
2. Open the console's address on your network in a browser (**Device Portal**, on port 11443) and add the app: upload the `.appx` from the artifact and the dependency packages next to it. If the console asks for the certificate, install `Roam.Xbox.cer` as the portal's page says.
3. Start **Roam** from Dev Home. A debug build can be inspected remotely from a PC's Edge DevTools (see Microsoft's *Remote debugging Xbox WebView2 apps* page); a store build can't.

## Publishing it in the Microsoft Store

1. In Partner Center, reserve the app's name. It gives you the **Package identity**: the `Name` and `Publisher` to put in `Roam.Xbox/Package.appxmanifest` in place of the placeholders there (`Roam.Media.Xbox`, `CN=Roam`).
2. Build the package for upload (a Store submission is signed by Microsoft; the workflow's test certificate is for sideloading only), submit it, and fill in the store listing. Xbox listings need age-rating answers and a privacy policy address (`<your Roam>/privacy`). Reviewers will need a test account; see `docs/store-submission.md` for how to prepare one.

## Where to look first if it doesn't work on a console

- **The controller.** The app listens for the controller's buttons itself (`OnCoreKeyDown` in `MainPage.xaml.cs`, turning them into the keys Roam's TV interface reads) *and* the TV interface understands the controller's own key codes directly (`src/tv/client/keys.ts`). If a button does two things, remove one of the two; if it does nothing, check that the console isn't putting the app in a mouse mode (`RequiresPointerMode` in `App.xaml.cs`).
- **Video.** The TV interface plays what the web view can: H.264 with AAC works everywhere; other formats depend on the console. The server converts audio the device can't play when it knows to; the Xbox app doesn't send what it can play yet.
- **An older Xbox One.** WebView2 needs a console system version that supports it (Microsoft added it in late 2023). On an older system software the app will not start.
