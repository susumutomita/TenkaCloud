import type { MetadataRoute } from "next";
import { allRoutes } from "@/lib/routes";

// The portal sitemap (migrated from the static landing's sitemap.xml, #2408). It is
// generated from the one route set (src/lib/routes.ts) so a new page is listed by
// registering its route, never by editing XML by hand. Emitted to /sitemap.xml at
// build time (static export).
const BASE_URL = "https://tenkacloud.com";

export const dynamic = "force-static";

export default function sitemap(): MetadataRoute.Sitemap {
  return allRoutes().map((route) => ({
    url: `${BASE_URL}${route}`,
    changeFrequency: "weekly",
    priority: route === "/" ? 1 : 0.7,
  }));
}
