/**
 * Cloudflare Turnstile on sign-in. Supabase can require a CAPTCHA token on every sign-up, password sign-in, email
 * link and anonymous (guest) sign-in; when it does, a call without a token is refused, so the widget and the token
 * on each call have to be in place BEFORE that switch is flipped. The site key is public (it ships to the browser);
 * the secret key only ever goes into Supabase's own settings. With no site key set, there is no widget and nothing
 * changes: sign-in works exactly as before.
 */

export const TURNSTILE_SCRIPT_URL = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

/** The configured public site key, or null when CAPTCHA is not set up. */
export function captchaSiteKey(raw: string | undefined = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY): string | null {
  const key = raw?.trim();
  return key ? key : null;
}

/** The option to spread into a Supabase auth call's `options`: the token when there is one, nothing otherwise. */
export function captchaOption(token: string | null | undefined): { captchaToken?: string } {
  return token ? { captchaToken: token } : {};
}

/** Whether a sign-in button may be pressed: always when no CAPTCHA is configured, otherwise only with a token in hand. */
export function captchaSatisfied(required: boolean, token: string | null | undefined): boolean {
  return !required || !!token;
}
