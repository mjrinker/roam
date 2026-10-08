"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { captchaOption, captchaSatisfied, captchaSiteKey, TURNSTILE_SCRIPT_URL } from "@/lib/auth/captcha";

interface TurnstileApi {
  render(el: HTMLElement, options: Record<string, unknown>): string;
  reset(widgetId: string): void;
  remove(widgetId: string): void;
}
declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

let scriptPromise: Promise<TurnstileApi> | null = null;
function loadTurnstile(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  scriptPromise ??= new Promise<TurnstileApi>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = TURNSTILE_SCRIPT_URL;
    script.async = true;
    script.onload = () => (window.turnstile ? resolve(window.turnstile) : reject(new Error("Turnstile did not load")));
    script.onerror = () => {
      scriptPromise = null; // a later attempt may succeed
      reject(new Error("Turnstile did not load"));
    };
    document.head.appendChild(script);
  });
  return scriptPromise;
}

export interface Captcha {
  /** Whether sign-in needs a CAPTCHA (a site key is configured). */
  required: boolean;
  /** Whether a sign-in button may be pressed now. */
  ready: boolean;
  /** Spread into the `options` of a Supabase auth call. */
  options(): { captchaToken?: string };
  /** A token works once: call this after every auth call, whatever its outcome, to get a fresh one. */
  reset(): void;
}

const NONE: Captcha = { required: false, ready: true, options: () => ({}), reset: () => {} };
const CaptchaContext = createContext<Captcha>(NONE);

/** The CAPTCHA state for the sign-in forms; outside a provider (or with no site key) nothing is required. */
export const useCaptcha = () => useContext(CaptchaContext);

/** Renders the Turnstile widget (when a site key is configured) once for every sign-in control below it. */
export function CaptchaProvider({ children }: { children: React.ReactNode }) {
  const siteKey = captchaSiteKey();
  const box = useRef<HTMLDivElement>(null);
  const widget = useRef<string | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!siteKey || !box.current) return;
    let cancelled = false;
    const el = box.current;
    loadTurnstile()
      .then((api) => {
        if (cancelled) return;
        widget.current = api.render(el, {
          sitekey: siteKey,
          theme: "dark",
          callback: (t: string) => setToken(t),
          "expired-callback": () => setToken(null),
          "error-callback": () => setToken(null),
        });
      })
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
      if (widget.current) window.turnstile?.remove(widget.current);
      widget.current = null;
    };
  }, [siteKey]);

  const reset = useCallback(() => {
    setToken(null);
    if (widget.current) window.turnstile?.reset(widget.current);
  }, []);

  const value = useMemo<Captcha>(
    () => ({ required: !!siteKey, ready: captchaSatisfied(!!siteKey, token), options: () => captchaOption(token), reset }),
    [siteKey, token, reset]
  );

  return (
    <CaptchaContext.Provider value={value}>
      {siteKey && (
        <div className="mb-5 flex flex-col items-center gap-2">
          <div ref={box} />
          {failed && <p className="text-center text-xs text-destructive">The security check couldn&apos;t load. Reload the page and try again.</p>}
        </div>
      )}
      {children}
    </CaptchaContext.Provider>
  );
}
