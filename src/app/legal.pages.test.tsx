/** The public Privacy Policy and Terms of Service say what Google (and people) need them to say. */
import { afterEach, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import PrivacyPage from "./privacy/page";
import TermsPage from "./terms/page";

afterEach(() => {
  delete process.env.NEXT_PUBLIC_CONTACT_EMAIL;
});

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ").replace(/\s+([,.;:])/g, "$1");

describe("the privacy policy", () => {
  const html = renderToStaticMarkup(<PrivacyPage />);
  const plain = text(html);
  it("explains the Google Drive access: read-only, what it is for, what is kept, and how to remove it", () => {
    expect(plain).toContain("Google user data");
    expect(plain).toContain("drive.readonly");
    expect(plain).toMatch(/read-only/i);
    expect(plain).toMatch(/never modifies, deletes, uploads, moves or shares/);
    expect(plain).toMatch(/sign-in tokens, encrypted at rest/);
    for (const heading of ["What Roam accesses", "How Roam uses it", "What Roam stores", "Who it is shared with", "Protecting it, keeping it, and removing it"]) expect(plain, heading).toContain(heading);
    expect(plain).toMatch(/not used to develop, improve or train generalised AI or machine-learning models/);
    expect(plain).toMatch(/names, folder structure, sizes, types and modified dates/);
    expect(html).toContain("https://myaccount.google.com/permissions");
  });
  it("carries Google's required Limited Use statement and links the user data policy", () => {
    expect(plain).toContain("will adhere to the Google API Services User Data Policy, including the Limited Use requirements");
    expect(html).toContain("https://developers.google.com/terms/api-services-user-data-policy");
  });
  it("says it does not sell data or advertise, lists who else receives information, and how to get data deleted", () => {
    expect(plain).toMatch(/do not sell personal information and do not show advertising/);
    for (const name of ["Supabase", "Vercel", "Cloudflare", "TMDB", "OpenSubtitles", "MusicBrainz"]) expect(plain, name).toContain(name);
    expect(plain).toMatch(/To have your account and its data deleted/);
    expect(plain).toContain("is not endorsed or certified by TMDB");
  });
  it("gives a way to contact the operator, adding an email only when one is configured", () => {
    expect(html).toContain("https://github.com/mjrinker");
    expect(html).not.toContain("mailto:");
    process.env.NEXT_PUBLIC_CONTACT_EMAIL = "help@example.com";
    expect(renderToStaticMarkup(<PrivacyPage />)).toContain("mailto:help@example.com");
  });
  it("links the terms", () => {
    expect(html).toContain('href="/terms"');
  });
});

describe("the terms of service", () => {
  const html = renderToStaticMarkup(<TermsPage />);
  const plain = text(html);
  it("covers use, admins' responsibilities, acceptable use, third parties, warranty and liability", () => {
    for (const heading of ["Your account", "Server admins", "Acceptable use", "Third-party services", "No warranty", "Limits on liability"]) expect(plain, heading).toContain(heading);
    expect(plain).toMatch(/only add media you have the legal right to store and share/);
    expect(plain).toMatch(/Roam does not provide any media/);
  });
  it("points to the privacy policy for Google access and gives a contact", () => {
    expect(plain).toMatch(/Connecting a Google account lets Roam read your Drive as described in the Privacy Policy/);
    expect(html).toContain("https://github.com/mjrinker");
    expect(html).toContain('href="/privacy"');
  });
});

describe("the public front page", () => {
  it("says what Roam is for and how it uses Google data, without needing a sign-in, and links the policies", async () => {
    const { LandingPage } = await import("@/components/landing/landing-page");
    const html = renderToStaticMarkup(<LandingPage />);
    const plain = text(html);
    expect(plain).toContain("A private media server for your family and friends");
    expect(plain).toMatch(/Connect your own Box, Dropbox, OneDrive or Google Drive/);
    expect(plain).toMatch(/read-only/);
    expect(plain).toMatch(/does not sell your data or use it for advertising/);
    expect(plain).toContain("will adhere to the Google API Services User Data Policy, including the Limited Use requirements");
    expect(html).toContain('href="/privacy"');
    expect(html).toContain('href="/terms"');
    expect(html).toContain('href="/sign-in"');
  });
});
