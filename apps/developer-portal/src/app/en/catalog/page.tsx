import type { Metadata } from "next";
import { CatalogView } from "@/components/CatalogView";
import { CATALOG_COPY } from "@/content/site-copy";

// Public problem catalog, English mirror, served at "/en/catalog/". Same generated
// data as the Japanese catalog; only the chrome copy differs.
export const metadata: Metadata = {
  title: CATALOG_COPY.en.meta.title,
  description: CATALOG_COPY.en.meta.description,
  alternates: { canonical: "/en/catalog/", languages: { ja: "/catalog/", en: "/en/catalog/" } },
};

export default function EnglishCatalogPage() {
  return <CatalogView locale="en" />;
}
