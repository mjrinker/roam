using Windows.System;

namespace Roam.Xbox
{
    /// <summary>The controller's buttons as the key codes Roam's TV interface reads (the same numbers Windows gives them as keys).</summary>
    public static class Gamepad
    {
        /// <summary>The key code to press in the page for a controller button, or 0 for a button the app doesn't use.</summary>
        public static int KeyCodeFor(VirtualKey key)
        {
            switch (key)
            {
                case VirtualKey.GamepadDPadUp:
                case VirtualKey.GamepadLeftThumbstickUp:
                    return 38;
                case VirtualKey.GamepadDPadDown:
                case VirtualKey.GamepadLeftThumbstickDown:
                    return 40;
                case VirtualKey.GamepadDPadLeft:
                case VirtualKey.GamepadLeftThumbstickLeft:
                    return 37;
                case VirtualKey.GamepadDPadRight:
                case VirtualKey.GamepadLeftThumbstickRight:
                    return 39;
                case VirtualKey.GamepadA:
                    return 13; // Enter: choose
                case VirtualKey.GamepadB:
                    return 27; // Escape: back
                case VirtualKey.GamepadMenu:
                    return 179; // play/pause
                case VirtualKey.GamepadLeftShoulder:
                    return 412; // rewind
                case VirtualKey.GamepadRightShoulder:
                    return 417; // fast-forward
                default:
                    return 0;
            }
        }
    }
}
