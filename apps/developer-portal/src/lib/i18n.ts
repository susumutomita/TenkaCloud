// The portal ships in Japanese (primary, at the root path) and English (mirror,
// under /en). These are the only two supported locales (#1108: ja + en only).
// The marketing home and public catalog render from one bilingual content model,
// so both language versions stay structurally identical (parity is enforced by
// the shared TypeScript shape, not by hand).

export type Locale = "ja" | "en";

export const LOCALES: readonly Locale[] = ["ja", "en"];

// The opposite locale, used to render the in-page language switch.
export function otherLocale(locale: Locale): Locale {
  return locale === "ja" ? "en" : "ja";
}

// The HTML lang attribute value for a locale (BCP-47).
export function htmlLang(locale: Locale): string {
  return locale === "ja" ? "ja" : "en";
}
