/* eslint-disable @typescript-eslint/no-explicit-any -- stand-in for next/navigation used by the browser checks: navigation is recorded, not performed */
const record = (url: string) => {
  ((window as any).__nav ??= []).push(url);
};
export const useRouter = () => ({ push: record, replace: record, refresh: () => undefined, back: () => undefined, prefetch: () => undefined });
export const usePathname = () => window.location.pathname;
export const useSearchParams = () => new URLSearchParams(window.location.search);
