import type { Metadata } from "next";
import { Bullets, Contact, LegalPage, Section } from "@/components/legal/legal-page";

export const metadata: Metadata = {
  title: "Terms of Service",
  description: "The rules for using Roam.",
};

export default function TermsPage() {
  return (
    <LegalPage title="Terms of Service" updated="October 12, 2026">
      <p>
        These terms apply when you use Roam, a private media server operated by Matt Rinker as a personal project. By creating an account, accepting an invitation, or using Roam, you agree to them. If you don&apos;t agree, please don&apos;t use Roam.
      </p>

      <Section title="What Roam is">
        <p>
          Roam lets a person (the <strong>server admin</strong>) connect their own cloud storage, choose folders of media, and invite others to watch, listen and read from a web app. Roam does not provide any media. Everything in a library comes from the admin&apos;s own storage, and Roam
          stores only information about it (see the Privacy Policy).
        </p>
      </Section>

      <Section title="Your account">
        <Bullets
          items={[
            "You must be old enough to form a binding agreement where you live, and at least 13. Children may use profiles that an adult account holder sets up and is responsible for.",
            "Give a real email address, keep your sign-in secure, and tell us if you think someone else has used your account. You are responsible for what happens under it.",
            "Servers are private. You can join one only by invitation or an admin's join link.",
          ]}
        />
      </Section>

      <Section title="Server admins">
        <p>If you run a server, you are responsible for it. In particular you agree that:</p>
        <Bullets
          items={[
            "you will only add media you have the legal right to store and share with the people you invite, and you will respect the licences and terms of your own media and storage;",
            "you will only invite people you intend to share with, and you are responsible for the access you give them (libraries can be restricted to chosen people);",
            "you will follow the terms of the storage providers you connect (Box, Dropbox, Microsoft, Google and others), including any limits on sharing or streaming;",
            "deleting a library or server removes it from Roam for everyone on it, and cannot be undone. Your files in storage are not touched.",
          ]}
        />
      </Section>

      <Section title="Acceptable use">
        <p>You agree not to:</p>
        <Bullets
          items={[
            "use Roam to share or distribute content you don't have the right to share, or to make media publicly available;",
            "break the law, infringe others' rights, or use Roam to harass or harm anyone;",
            "try to access servers, libraries or accounts you weren't given, probe or disrupt the service, or get around its limits and access controls;",
            "use automated tools to overload the service, scrape it, or build a competing service from it;",
            "upload or link anything harmful, such as malware.",
          ]}
        />
        <p>We may limit or suspend access, or remove a server, library or account, to protect the service or other people, or for breaking these terms.</p>
      </Section>

      <Section title="Third-party services">
        <p>
          Roam works with other services: your storage provider, sign-in providers, and online metadata sources such as TMDB. Your use of them is governed by their own terms. Connecting a Google account lets Roam read your Drive as described in the Privacy Policy, and you can
          remove that access at any time from Roam or your Google account. Movie and TV data comes from TMDB; this product uses the TMDB API but is not endorsed or certified by TMDB.
        </p>
      </Section>

      <Section title="Your content and our software">
        <p>
          You keep all rights to your media and your information. Roam does not claim any ownership of what you share and uses it only to run the service for you and the people you invite. Roam&apos;s own software, name and logo belong to the operator; you may use the service as
          intended, but not copy or resell it.
        </p>
      </Section>

      <Section title="No warranty">
        <p>
          Roam is a personal project, provided <strong>&ldquo;as is&rdquo; and &ldquo;as available&rdquo;</strong>, without promises that it will be uninterrupted, error-free, or suitable for any particular purpose. Playback depends on your storage provider and your devices. Keep your own copies of anything
          important; Roam is a way to watch your media, not a backup.
        </p>
      </Section>

      <Section title="Limits on liability">
        <p>
          To the fullest extent the law allows, the operator is not liable for indirect or consequential losses, lost data, or lost profits arising from your use of Roam, and total liability for any claim is limited to the amount you paid to use Roam (which is nothing). Nothing here limits
          liability that cannot be limited by law.
        </p>
      </Section>

      <Section title="Ending your use">
        <p>
          You can stop using Roam at any time, and an admin can delete a server or remove a person. To have your account deleted, contact the operator. We may end or change the service, and we will try to give notice of major changes. Sections that by their nature should continue (such as the
          limits on liability) do so after your use ends.
        </p>
      </Section>

      <Section title="Changes and contact">
        <p>We may update these terms. The date above shows the latest version, and continuing to use Roam after a change means you accept it.</p>
        <Contact />
      </Section>
    </LegalPage>
  );
}
