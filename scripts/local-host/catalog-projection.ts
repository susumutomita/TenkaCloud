import { metadataToEntry } from "../../packages/portal-contracts/src/problem-catalog.js";
import { publicMetadata } from "./browser-metadata.js";

/** Persist exactly the public browser projection with an event, never author-only content. */
export function publicCatalogEntry(metadata: Record<string, unknown>, directory: string) {
  const projected = publicMetadata(JSON.stringify(metadata), `${directory}/metadata.json`);
  if (!projected) throw new Error("Problem metadata cannot be projected into the hosting catalog");
  return metadataToEntry(JSON.parse(projected));
}
