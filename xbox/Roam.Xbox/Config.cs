namespace Roam.Xbox
{
    /// <summary>Where this app takes people. The build can replace the address (see .github/workflows/xbox.yml and xbox/README.md).</summary>
    public static class Config
    {
        public const string Server = "https://roam-three-gray.vercel.app";
        public static string Start => Server + "/tv";
    }
}
