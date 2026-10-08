/**
 * The files that wrap Roam's TV interface as an installable app on Samsung (Tizen) and LG (webOS) TVs. Both are "hosted" apps: a tiny
 * package whose only job is to open https://<your Roam>/tv, so every deploy reaches the TVs with nothing to reinstall. Pure functions,
 * so the generated files are tested; scripts/package-tv.ts writes them out.
 */
import { xmlEscape } from "@/lib/demo/placeholder-epub";
import { siteOrigin } from "@/lib/tv/origin";

export { siteOrigin };

export const TIZEN_PACKAGE_ID = "RoamTv0001";
export const TIZEN_APP_ID = `${TIZEN_PACKAGE_ID}.Roam`;
export const WEBOS_APP_ID = "com.roam.tv";

/** `version` is a dotted number such as "1.0.0" (both platforms insist on it). */
export const validVersion = (v: string): boolean => /^\d{1,3}(\.\d{1,3}){1,2}$/.test(v);

export function tizenConfig(origin: string, version: string): string {
  if (!siteOrigin(origin) || siteOrigin(origin) !== origin || !validVersion(version)) throw new Error("A site origin and a version such as 1.0.0 are required.");
  const start = `${origin}/tv`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<widget xmlns="http://www.w3.org/ns/widgets" xmlns:tizen="http://tizen.org/ns/widgets" id="${xmlEscape(start)}" version="${version}" viewmodes="maximized">
  <tizen:application id="${TIZEN_APP_ID}" package="${TIZEN_PACKAGE_ID}" required_version="4.0"/>
  <content src="${xmlEscape(start)}"/>
  <feature name="http://tizen.org/feature/screen.size.all"/>
  <icon src="icon.png"/>
  <name>Roam</name>
  <tizen:privilege name="http://tizen.org/privilege/tv.inputdevice"/>
  <tizen:privilege name="http://tizen.org/privilege/internet"/>
  <tizen:profile name="tv-samsung"/>
  <access origin="*" subdomains="true"/>
  <tizen:setting screen-orientation="landscape" context-menu="disable" background-support="disable" encryption="disable" install-location="auto" hwkey-event="enable"/>
</widget>
`;
}

export function webosAppInfo(version: string): string {
  if (!validVersion(version)) throw new Error("A version such as 1.0.0 is required.");
  return (
    JSON.stringify(
      { id: WEBOS_APP_ID, version, vendor: "Roam", type: "web", main: "index.html", title: "Roam", icon: "icon.png", largeIcon: "largeIcon.png", resolution: "1920x1080", disableBackHistoryAPI: false },
      null,
      2
    ) + "\n"
  );
}

/** webOS needs a local main page; this one hands over to the site, and says what's wrong if it can't. */
export function webosIndexHtml(origin: string): string {
  if (siteOrigin(origin) !== origin) throw new Error("A site origin is required.");
  const start = JSON.stringify(`${origin}/tv`).replace(/</g, "\\u003c");
  return `<!doctype html><html><head><meta charset="utf-8"><title>Roam</title>
<style>html,body{margin:0;background:#0b0b10;color:#ececf1;font-family:Arial,sans-serif;height:100%}body{display:flex;align-items:center;justify-content:center;font-size:32px}</style></head>
<body><p id="m">Opening Roam…</p>
<script>
var start = ${start};
function go() { window.location.replace(start); }
function fail() { document.getElementById("m").textContent = "Roam can't be reached. Check the TV's network connection."; window.setTimeout(go, 8000); }
var x = new XMLHttpRequest();
x.open("GET", start, true);
x.onload = go;
x.onerror = fail;
x.timeout = 10000;
x.ontimeout = fail;
try { x.send(); } catch (e) { fail(); }
</script></body></html>
`;
}
