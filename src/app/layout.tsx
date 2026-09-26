import type { Metadata } from "next";
import { Geist_Mono, Inter } from "next/font/google";
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
        <SplashScreen />
        {children}
        <Toaster richColors position="top-center" />
      </body>
    </html>
  );
}
