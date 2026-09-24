import Link from "next/link";
import { requireProfile } from "@/lib/auth/guards";
import { SignOutButton } from "@/components/nav/sign-out-button";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const profile = await requireProfile();

  return (
    <div className="flex min-h-full flex-col">
      <header className="sticky top-0 z-10 flex items-center justify-between border-b border-border bg-background/95 px-6 py-3 backdrop-blur">
        <nav className="flex items-center gap-6">
          <Link href="/library" className="text-lg font-semibold tracking-tight">
            Roam
          </Link>
          <Link
            href="/library"
            className="text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            Library
          </Link>
          {profile.role === "admin" && (
            <Link
              href="/admin"
              className="text-sm text-muted-foreground transition-colors hover:text-foreground"
            >
              Admin
            </Link>
          )}
        </nav>
        <div className="flex items-center gap-3">
          <span className="text-sm text-muted-foreground">
            {profile.displayName ?? profile.email}
          </span>
          <SignOutButton />
        </div>
      </header>
      <main className="flex-1">{children}</main>
    </div>
  );
}
