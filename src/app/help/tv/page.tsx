import type { Metadata } from "next";
import { headers } from "next/headers";
import { BrandLogo } from "@/components/shell/brand";
import { canonicalOrigin, tvHost } from "@/lib/tv/origin";

export const metadata: Metadata = { title: "Watch Roam on your TV" };

const BRANDS: { name: string; steps: string[] }[] = [
  { name: "Samsung", steps: ["Press Home, then go to Apps and open Internet (Samsung Internet).", "Pick the address bar at the top and type the address below."] },
  { name: "LG", steps: ["Press Home and open Web Browser.", "Pick the address bar at the top and type the address below."] },
  { name: "Amazon Fire TV", steps: ["If you don't have a browser yet, search the Appstore for Silk Browser and install it.", "Open Silk, pick the address bar and type the address below."] },
];

/** A page to send to a relative: how to open Roam on their TV, step by step. Public (no sign-in), and written for a phone screen. */
export default async function TvHelpPage() {
  const h = await headers();
  const here = h.get("host") ?? "your Roam address";
  // The short address to type on a TV (if one is set up), and the main address where a phone approves it.
  const host = tvHost() ?? here;
  const linkHost = new URL(canonicalOrigin(`https://${here}/`)).host;
  return (
    <main className="mx-auto flex w-full max-w-2xl flex-col gap-8 px-5 py-10">
      <BrandLogo variant="gradient" className="h-10 self-start" />
      <header>
        <h1 className="text-3xl font-semibold tracking-tight">Watch Roam on your TV</h1>
        <p className="mt-2 text-muted-foreground">It takes a few minutes the first time. After that, it is one click.</p>
      </header>

      <section className="flex flex-col gap-3">
        <h2 className="text-xl font-medium">Before you start</h2>
        <p>You need a Roam account (use the invite you were sent) and your phone nearby, signed in to Roam.</p>
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="text-xl font-medium">1. Open the web browser on the TV</h2>
        {BRANDS.map((b) => (
          <div key={b.name} className="rounded-xl bg-white/[0.04] p-4 ring-1 ring-white/[0.08]">
            <h3 className="font-medium">{b.name}</h3>
            <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
              {b.steps.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ol>
          </div>
        ))}
        <p className="text-sm text-muted-foreground">
          <strong>Vizio:</strong> Vizio TVs don&apos;t have a web browser. Use a streaming stick (such as an Amazon Fire TV Stick) plugged into the TV, or watch on your phone or computer.
        </p>
        <p className="text-sm text-muted-foreground">Menu names vary a little between TV models and years.</p>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-xl font-medium">2. Type this address</h2>
        <p className="rounded-xl bg-white/[0.06] px-4 py-3 text-center font-mono text-xl ring-1 ring-white/10">{host}/t</p>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-xl font-medium">3. Sign in with your phone</h2>
        <p>The TV shows a square code (a QR code) and a short code. Open your phone&apos;s camera and point it at the square, then tap the link. Or open <strong>{linkHost}/link</strong> on your phone and type the short code.</p>
        <p>Check that the TV it names is yours, then tap <strong>Yes, sign in this TV</strong>. The TV continues on its own.</p>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-xl font-medium">4. Make it one click next time</h2>
        <p>Choose who is watching. You stay signed in, so you will not need a code again.</p>
        <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
          <li>Add the page to the browser&apos;s bookmarks (look for a star or a bookmark button).</li>
          <li>Better: in the browser&apos;s settings, set its <strong>home page</strong> (or start page) to the same address, so opening the browser opens Roam.</li>
          <li>On the TV&apos;s home screen, move the browser app to the front of the row of apps so it is the first thing you reach.</li>
        </ul>
      </section>

      <p className="text-sm text-muted-foreground">Right now the TV shows movies and TV shows. Use the arrow keys to move, OK to choose and Back to go back.</p>
    </main>
  );
}
