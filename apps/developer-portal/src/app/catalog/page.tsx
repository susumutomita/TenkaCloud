import type { Metadata } from "next";
import { CatalogView } from "@/components/CatalogView";
import { CATALOG_COPY } from "@/content/site-copy";

// Public problem catalog, Japanese (primary), served at "/catalog/". Generated from
// the problems/ submodule metadata (source of truth); see src/content/catalog-data.ts.
export const metadata: Metadata = {
  title: CATALOG_COPY.ja.meta.title,
  description: CATALOG_COPY.ja.meta.description,
  alternates: { canonical: "/catalog/", languages: { ja: "/catalog/", en: "/en/catalog/" } },
};

export default function CatalogPage() {
  return <CatalogView locale="ja" />;
}
