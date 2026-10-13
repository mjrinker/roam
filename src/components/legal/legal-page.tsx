import Link from "next/link";
import { BrandLogo } from "@/components/shell/brand";

/** The shared frame of the Privacy Policy and Terms of Service: public pages (no sign-in), readable on a phone. */
export function LegalPage({ title, updated, children }: { title: string; updated: string; children: React.ReactNode }) {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-5 py-10 sm:py-14">
      <Link href="/" aria-label="Roam home" className="self-start">
        <BrandLogo variant="gradient" className="h-10" />
      </Link>
      <header>
        <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">{title}</h1>
        <p className="mt-2 text-sm text-muted-foreground">Last updated {updated}</p>
      </header>
      <div className="flex flex-col gap-8 text-[15px] leading-relaxed text-foreground/85">{children}</div>
      <LegalFooter />
    </main>
  );
}

export function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-xl font-semibold tracking-tight text-foreground">{title}</h2>
      {children}
    </section>
  );
}

export function Bullets({ items }: { items: React.ReactNode[] }) {
  return (
    <ul className="list-disc space-y-1.5 pl-5">
      {items.map((item, i) => (
        <li key={i}>{item}</li>
      ))}
    </ul>
  );
}

/** Links between the two pages and back to the app. */
export function LegalFooter() {
  return (
    <footer className="mt-4 flex flex-wrap gap-x-5 gap-y-1 border-t border-white/10 pt-6 text-sm text-muted-foreground">
      <Link href="/privacy" className="hover:text-foreground hover:underline">
        Privacy Policy
      </Link>
      <Link href="/terms" className="hover:text-foreground hover:underline">
        Terms of Service
      </Link>
      <Link href="/" className="hover:text-foreground hover:underline">
        Back to Roam
      </Link>
    </footer>
  );
}

/** How to reach the operator: the public GitHub profile, plus an address if one is configured for the site. */
export function Contact() {
  const email = process.env.NEXT_PUBLIC_CONTACT_EMAIL?.trim();
  return (
    <p>
      Contact the operator, Matt Rinker, through{" "}
      <a href="https://github.com/mjrinker" className="text-primary underline underline-offset-2" target="_blank" rel="noreferrer">
        github.com/mjrinker
      </a>
      {email ? (
        <>
          {" "}
          or by email at{" "}
          <a href={`mailto:${email}`} className="text-primary underline underline-offset-2">
            {email}
          </a>
        </>
      ) : null}
      .
    </p>
  );
}
