import type { Metadata } from "next";
import { MarketingHome } from "@/components/MarketingHome";
import { HOME_COPY } from "@/content/site-copy";

// Marketing home, Japanese (primary), served at "/" (ADR-0003 §5 marketing, static).
// The English mirror lives at /en. Both render from the one bilingual content model
// so the two never drift.
export const metadata: Metadata = {
  title: HOME_COPY.ja.meta.title,
  description: HOME_COPY.ja.meta.description,
  alternates: { canonical: "/", languages: { ja: "/", en: "/en/" } },
};

export default function HomePage() {
  return <MarketingHome locale="ja" />;
}
