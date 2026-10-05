/** Shown at once while the next photo's page is prepared (stepping with the arrow keys), instead of the old photo sitting there. */
export default function Loading() {
  return <div className="min-h-svh bg-black" aria-busy="true" />;
}
