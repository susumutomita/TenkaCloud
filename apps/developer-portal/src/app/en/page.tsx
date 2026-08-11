import type { Metadata } from "next";
import { MarketingHome } from "@/components/MarketingHome";
import { HOME_COPY } from "@/content/site-copy";

// Marketing home, English mirror, served at "/en/". The Japanese original at "/" is
// the primary; both render from the same bilingual content model.
export const metadata: Metadata = {
  title: HOME_COPY.en.meta.title,
  description: HOME_COPY.en.meta.description,
  alternates: { canonical: "/en/", languages: { ja: "/", en: "/en/" } },
};

export default function EnglishHomePage() {
  return <MarketingHome locale="en" />;
}
