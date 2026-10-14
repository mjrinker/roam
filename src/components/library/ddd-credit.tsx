/** Does the Dog Die's required credit (their API Terms: this exact phrase, linked), with the plain reminder that its reports are unverified. */
export function DddCredit({ className = "" }: { className?: string }) {
  return (
    <span className={className}>
      <a href="https://www.doesthedogdie.com" target="_blank" rel="noopener noreferrer" className="underline underline-offset-2 hover:text-foreground">
        Powered by DoesTheDogDie.com
      </a>
      . These reports come from the community, aren&apos;t verified, and may be incomplete: no warning doesn&apos;t mean the content isn&apos;t there.
    </span>
  );
}
