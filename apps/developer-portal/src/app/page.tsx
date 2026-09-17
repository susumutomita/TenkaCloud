import type { Metadata } from "next";
import { MarketingHome } from "@/components/MarketingHome";
import { BUSINESS_HOME_COPY } from "@/content/home-business-copy";

// The static marketing home serves the primary Japanese version at "/".
// The English mirror lives at /en. Both render from the same bilingual business
// narrative, so the on-page proposition and search metadata stay aligned.
export const metadata: Metadata = {
  title: BUSINESS_HOME_COPY.ja.meta.title,
  description: BUSINESS_HOME_COPY.ja.meta.description,
  alternates: { canonical: "/", languages: { ja: "/", en: "/en/" } },
};

export default function HomePage() {
  return <MarketingHome locale="ja" />;
}
