using System;
using System.Threading.Tasks;
using Microsoft.UI.Xaml.Controls;
using Windows.UI.Core;
using Windows.UI.Xaml;
using Windows.UI.Xaml.Controls;
using Windows.UI.Xaml.Input;

namespace Roam.Xbox
{
    /// <summary>The whole app: one web view showing Roam's TV interface, with the controller's buttons passed to it as the keys it understands.</summary>
    public sealed partial class MainPage : Page
    {
        private bool _failedLast;

        public MainPage()
        {
            InitializeComponent();
            Loaded += async (s, e) => await StartAsync();
            SystemNavigationManager.GetForCurrentView().BackRequested += OnBackRequested;
            // The controller's buttons arrive as keys; whichever of the page and the web view has them, they are passed on.
            Window.Current.CoreWindow.KeyDown += OnCoreKeyDown;
        }

        private async Task StartAsync()
        {
            // Remote debugging from a PC is available only when this is set before the web view starts (see xbox/README.md); off for a store build.
#if DEBUG
            Environment.SetEnvironmentVariable("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", "--enable-features=msEdgeDevToolsWdpRemoteDebugging");
#endif
            await Web.EnsureCoreWebView2Async();
            var core = Web.CoreWebView2;
            // Roam recognises an Xbox (for the name shown when its sign-in code is approved) from this.
            core.Settings.UserAgent = core.Settings.UserAgent + " Xbox RoamXbox/1.0";
            core.Settings.AreDefaultContextMenusEnabled = false;
            core.Settings.IsZoomControlEnabled = false;
            core.Settings.AreBrowserAcceleratorKeysEnabled = false;
            core.NavigationStarting += (s, a) =>
            {
                if (!Navigation.IsAllowed(a.Uri, Config.Server)) a.Cancel = true;
            };
            core.NewWindowRequested += (s, a) =>
            {
                a.Handled = true; // never a second window: stay in this one, and only on Roam's own pages
                if (Navigation.IsAllowed(a.Uri, Config.Server)) core.Navigate(a.Uri);
            };
            core.NavigationCompleted += async (s, a) =>
            {
                if (a.IsSuccess)
                {
                    _failedLast = false;
                    return;
                }
                if (_failedLast) return;
                _failedLast = true;
                core.NavigateToString(Navigation.ErrorPage);
                await Task.Delay(TimeSpan.FromSeconds(6));
                core.Navigate(Config.Start);
            };
            core.Navigate(Config.Start);
        }

        private async void OnBackRequested(object sender, BackRequestedEventArgs e)
        {
            e.Handled = true; // Roam's own Back does the going back (and leaves when there is nowhere to go)
            await PressAsync(27);
        }

        private async void OnCoreKeyDown(CoreWindow sender, KeyEventArgs e)
        {
            var code = Gamepad.KeyCodeFor(e.VirtualKey);
            if (code == 0 || e.VirtualKey == Windows.System.VirtualKey.GamepadB) return; // B arrives as Back, above
            if (Web.CoreWebView2 == null) return;
            e.Handled = true;
            await PressAsync(code);
        }

        private async Task PressAsync(int keyCode)
        {
            if (Web.CoreWebView2 == null) return;
            await Web.CoreWebView2.ExecuteScriptAsync(Navigation.KeyScript(keyCode));
        }
    }
}
