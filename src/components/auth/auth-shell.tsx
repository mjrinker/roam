import { BrandLogo } from "@/components/shell/brand";

/** Cinematic full-screen backdrop + centered glass card shared by sign-in and invite pages. */
export function AuthShell({
  title,
  description,
  notice,
  children,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  notice?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <main className="relative flex flex-1 flex-col items-center justify-center overflow-hidden px-4 py-16">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(60%_50%_at_50%_0%,oklch(0.853_0.163_169/0.18),transparent),radial-gradient(45%_40%_at_100%_100%,oklch(0.55_0.15_290/0.14),transparent),radial-gradient(40%_35%_at_0%_90%,oklch(0.6_0.12_220/0.1),transparent)]"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 -z-10 [background-image:linear-gradient(to_right,oklch(1_0_0/0.035)_1px,transparent_1px),linear-gradient(to_bottom,oklch(1_0_0/0.035)_1px,transparent_1px)] [background-size:56px_56px] [mask-image:radial-gradient(ellipse_at_center,black,transparent_75%)]"
      />

      <div className="flex w-full max-w-md flex-col items-center gap-8">
        <BrandLogo variant="gradient" className="h-14" />

        <div className="w-full rounded-3xl bg-card/70 p-7 shadow-[0_30px_80px_-20px_rgba(0,0,0,0.8)] ring-1 ring-white/10 backdrop-blur-xl sm:p-9">
          <div className="mb-6 text-center">
            <h1 className="text-2xl font-semibold tracking-tight text-balance">{title}</h1>
            {description && (
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{description}</p>
            )}
          </div>
          {notice && (
            <p className="mb-5 rounded-xl bg-destructive/10 px-4 py-3 text-center text-sm text-destructive ring-1 ring-destructive/20">
              {notice}
            </p>
          )}
          {children}
        </div>

        <p className="text-xs text-muted-foreground/70">
          A private media server for your people.
        </p>
      </div>
    </main>
  );
}
