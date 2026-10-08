import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("@/lib/supabase/client", () => ({ createSupabaseBrowserClient: () => ({ auth: {} }) }));

/** True when a rendered button has the disabled ATTRIBUTE (not a "disabled:" class). */
const isDisabled = (button: string) => /<button[^>]*\sdisabled(?:=""|\s|>)/.test(button);

import { CaptchaProvider, useCaptcha } from "./captcha";
import { AuthForm } from "./auth-form";
import { GuestButton } from "./guest-button";

afterEach(() => vi.unstubAllEnvs());

function Probe() {
  const c = useCaptcha();
  return <span data-required={String(c.required)} data-ready={String(c.ready)} />;
}

describe("CaptchaProvider", () => {
  it("does nothing without a site key: no widget, nothing required, buttons usable", () => {
    vi.stubEnv("NEXT_PUBLIC_TURNSTILE_SITE_KEY", "");
    const html = renderToStaticMarkup(
      <CaptchaProvider>
        <Probe />
        <GuestButton joinToken="t" />
      </CaptchaProvider>
    );
    expect(html).toContain('data-required="false"');
    expect(html).toContain('data-ready="true"');
    expect(html).not.toContain("mb-5 flex flex-col"); // no widget container
    expect((html.match(/<button[^>]*>/g) ?? []).some(isDisabled)).toBe(false);
    expect(html).not.toContain("Waiting for the security check");
  });

  it("with a site key: the widget's place is there and the guest and sign-in buttons wait for a token", () => {
    vi.stubEnv("NEXT_PUBLIC_TURNSTILE_SITE_KEY", "0x4AAAA");
    const html = renderToStaticMarkup(
      <CaptchaProvider>
        <Probe />
        <GuestButton joinToken="t" />
        <AuthForm mode="sign-in" />
      </CaptchaProvider>
    );
    expect(html).toContain('data-required="true"');
    expect(html).toContain('data-ready="false"');
    expect(html).toContain("mb-5 flex flex-col");
    expect(html).toContain("Waiting for the security check");
    // Continue as a guest, Send me a sign-in link: disabled. Google is not gated.
    const buttons = html.match(/<button[^>]*>[^<]*(?:<[^b][^>]*>[^<]*)*<\/button>/g) ?? [];
    const disabledLabels = buttons.filter(isDisabled).map((b) => b.replace(/<[^>]+>/g, ""));
    expect(disabledLabels).toEqual(expect.arrayContaining(["Continue as a guest", "Send me a sign-in link"]));
    expect(isDisabled(buttons.find((b) => b.includes("Continue with Google"))!)).toBe(false);
  });
});
