using System;

namespace Roam.Xbox
{
    /// <summary>What the app lets its window open: Roam's own pages and nothing else (a TV app has no address bar to notice a wrong turn).</summary>
    public static class Navigation
    {
        public static bool IsAllowed(string uri, string server)
        {
            if (!Uri.TryCreate(uri, UriKind.Absolute, out var target)) return false;
            if (!Uri.TryCreate(server, UriKind.Absolute, out var home)) return false;
            if (target.Scheme == "about" || target.Scheme == "data") return true; // the app's own "can't reach Roam" page
            return target.Scheme == Uri.UriSchemeHttps && string.Equals(target.Host, home.Host, StringComparison.OrdinalIgnoreCase) && target.Port == home.Port;
        }

        /// <summary>The script that presses a key in the page, as the TV interface expects keys (it reads the key code, which a real event can't be given).</summary>
        public static string KeyScript(int keyCode) =>
            "(function(){var e=new Event('keydown',{bubbles:true,cancelable:true});e.keyCode=" + keyCode + ";document.dispatchEvent(e);})();";

        public const string ErrorPage =
            "<!doctype html><html><head><meta charset='utf-8'><meta name='viewport' content='width=device-width'></head>" +
            "<body style='margin:0;background:#0b0b10;color:#ececf1;font-family:Segoe UI,Arial,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;text-align:center'>" +
            "<div><h1 style='font-weight:600'>Roam can't be reached</h1><p style='color:#b8b8c4;font-size:1.4rem'>Check the console's network connection. Trying again in a few seconds.</p></div></body></html>";
    }
}
