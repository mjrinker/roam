import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The remux runner (see lib/remux/) execs a bundled static ffmpeg and ships
  // the shared core/worker .mjs files into a sandbox by reading them off
  // disk — neither is reachable by import tracing, so only that one route
  // opts in to carrying them (the installer resolves its per-platform binary
  // package dynamically at require time).
  serverExternalPackages: ["@ffmpeg-installer/ffmpeg"],
  outputFileTracingIncludes: {
    "/api/remux/run": [
      "./node_modules/@ffmpeg-installer/ffmpeg/**/*",
      "./node_modules/@ffmpeg-installer/linux-x64/**/*",
      "./src/lib/remux/remux-core.mjs",
      "./src/lib/remux/remux-worker.mjs",
    ],
  },
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "image.tmdb.org",
        pathname: "/t/p/**",
      },
      // Audiobook covers from Audible.
      {
        protocol: "https",
        hostname: "m.media-amazon.com",
        pathname: "/images/**",
      },
    ],
  },
};

export default nextConfig;
