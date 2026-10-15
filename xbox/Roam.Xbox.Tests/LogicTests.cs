using Roam.Xbox;
using Windows.System;
using Xunit;

namespace Roam.Xbox.Tests
{
    public class NavigationTests
    {
        private const string Server = "https://roam.example";

        [Theory]
        [InlineData("https://roam.example/tv")]
        [InlineData("https://roam.example/tv/s/abc/title/1?x=1")]
        [InlineData("HTTPS://ROAM.EXAMPLE/tv")]
        [InlineData("about:blank")]
        [InlineData("data:text/html,hello")]
        public void OpensRoamsOwnPagesAndTheAppsOwn(string uri) => Assert.True(Navigation.IsAllowed(uri, Server));

        [Theory]
        [InlineData("https://evil.example/tv")]
        [InlineData("https://roam.example.evil.example/tv")]
        [InlineData("https://evil.example/https://roam.example/")]
        [InlineData("http://roam.example/tv")]
        [InlineData("https://roam.example:8443/tv")]
        [InlineData("ftp://roam.example/tv")]
        [InlineData("javascript:alert(1)")]
        [InlineData("file:///C:/Windows/win.ini")]
        [InlineData("not a uri")]
        [InlineData("")]
        public void RefusesAnywhereElse(string uri) => Assert.False(Navigation.IsAllowed(uri, Server));

        [Fact]
        public void RefusesEverythingWhenTheServerAddressIsBroken() => Assert.False(Navigation.IsAllowed("https://roam.example/tv", "nonsense"));

        [Fact]
        public void PressesAKeyByItsCode()
        {
            var script = Navigation.KeyScript(27);
            Assert.Contains("e.keyCode=27;", script);
            Assert.Contains("'keydown'", script);
        }

        [Fact]
        public void TheErrorPageSaysWhatIsWrong() => Assert.Contains("Roam can't be reached", Navigation.ErrorPage);
    }

    public class GamepadTests
    {
        [Theory]
        [InlineData(VirtualKey.GamepadDPadUp, 38)]
        [InlineData(VirtualKey.GamepadDPadDown, 40)]
        [InlineData(VirtualKey.GamepadDPadLeft, 37)]
        [InlineData(VirtualKey.GamepadDPadRight, 39)]
        [InlineData(VirtualKey.GamepadLeftThumbstickUp, 38)]
        [InlineData(VirtualKey.GamepadLeftThumbstickRight, 39)]
        [InlineData(VirtualKey.GamepadA, 13)]
        [InlineData(VirtualKey.GamepadB, 27)]
        [InlineData(VirtualKey.GamepadMenu, 179)]
        [InlineData(VirtualKey.GamepadLeftShoulder, 412)]
        [InlineData(VirtualKey.GamepadRightShoulder, 417)]
        public void MapsButtonsToTheKeysRoamReads(VirtualKey key, int code) => Assert.Equal(code, Gamepad.KeyCodeFor(key));

        [Theory]
        [InlineData(VirtualKey.GamepadX)]
        [InlineData(VirtualKey.GamepadY)]
        [InlineData(VirtualKey.A)]
        public void IgnoresTheRest(VirtualKey key) => Assert.Equal(0, Gamepad.KeyCodeFor(key));
    }
}
