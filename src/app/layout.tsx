import type { Metadata, Viewport } from "next";
import { Geist_Mono, Inter } from "next/font/google";
import { GestureGuard } from "@/components/shell/gesture-guard";
import { OfflineBoot } from "@/components/offline/offline-boot";
import { SplashScreen, SPLASH_SKIP_SCRIPT } from "@/components/shell/splash-screen";
import { Toaster } from "@/components/ui/sonner";
import "./globals.css";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
  display: "swap",
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Roam",
  description: "A private, cloud-based media server for the family.",
  appleWebApp: {
    capable: true,
    title: "Roam",
    statusBarStyle: "black",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  themeColor: "#1c1e23",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`dark ${inter.variable} ${geistMono.variable} h-full antialiased`}
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: SPLASH_SKIP_SCRIPT }} />
      </head>
      <body className="min-h-full flex flex-col bg-background text-foreground">
        <GestureGuard />
        <OfflineBoot />
        <SplashScreen />
        {children}
        <Toaster richColors position="top-center" />
      </body>
    </html>
  );
}
