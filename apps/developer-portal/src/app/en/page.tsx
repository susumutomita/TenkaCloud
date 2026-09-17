import type { Metadata } from "next";
import { MarketingHome } from "@/components/MarketingHome";
import { BUSINESS_HOME_COPY } from "@/content/home-business-copy";

// Marketing home, English mirror, served at "/en/". The Japanese original at "/"
// is primary; both render from the same bilingual business narrative.
export const metadata: Metadata = {
  title: BUSINESS_HOME_COPY.en.meta.title,
  description: BUSINESS_HOME_COPY.en.meta.description,
  alternates: { canonical: "/en/", languages: { ja: "/", en: "/en/" } },
};

export default function EnglishHomePage() {
  return <MarketingHome locale="en" />;
}
