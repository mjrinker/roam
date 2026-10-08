/**
 * The Supabase auth calls the sign-in forms make, each given the CAPTCHA option to attach. Kept apart from the
 * components so a test can check that EVERY call that Supabase would refuse without a token carries it (Google
 * sign-in redirects away and needs none).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

type Auth = SupabaseClient["auth"];
export type CaptchaOptions = { captchaToken?: string };

export const requestMagicLink = (auth: Auth, args: { email: string; redirectTo: string; captcha: CaptchaOptions }) =>
  auth.signInWithOtp({ email: args.email, options: { emailRedirectTo: args.redirectTo, ...args.captcha } });

export const createAccount = (auth: Auth, args: { email: string; password: string; captcha: CaptchaOptions }) =>
  auth.signUp({ email: args.email, password: args.password, options: args.captcha });

export const signInWithPassword = (auth: Auth, args: { email: string; password: string; captcha: CaptchaOptions }) =>
  auth.signInWithPassword({ email: args.email, password: args.password, options: args.captcha });

export const signInAsGuest = (auth: Auth, args: { captcha: CaptchaOptions }) => auth.signInAnonymously({ options: args.captcha });
