// External destinations referenced by the marketing surface. Kept in one place so
// the OSS / catalog / contact links never drift across the JA and EN pages.

export const GITHUB_REPO = "https://github.com/susumutomita/TenkaCloud";
export const GITHUB_DISCUSSIONS = "https://github.com/susumutomita/TenkaCloud/discussions";
export const CATALOG_REPO = "https://github.com/susumutomita/TenkaCloudChallenge";
export const CONTACT_FORM = "https://forms.gle/djVprYmq3hFgJA7P9";

import type { Locale } from "@/lib/i18n";

// Locale-aware internal paths. Japanese is the canonical root; English mirrors sit
// under /en. Trailing slashes match the static-export routing (routes.ts).
export function homePath(locale: Locale): string {
  return locale === "ja" ? "/" : "/en/";
}

export function catalogPath(locale: Locale): string {
  return locale === "ja" ? "/catalog/" : "/en/catalog/";
}

export function privacyPath(locale: Locale): string {
  return locale === "ja" ? "/privacy/" : "/en/privacy/";
}

export function termsPath(locale: Locale): string {
  return locale === "ja" ? "/terms/" : "/en/terms/";
}

export function legalPath(locale: Locale): string {
  return locale === "ja" ? "/legal/" : "/en/legal/";
}
