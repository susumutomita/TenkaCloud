"use client";

import { usePathname } from "next/navigation";
import { localeOf, mirrorPath } from "@/lib/locale-path";

// The global JA/EN switch in the site header (#2429), mirroring the legacy
// landing's two-link switch. The active locale link is marked aria-current; the
// other links to the current page's counterpart (mirrorPath falls back to the
// other locale's home for routes without a mirror).
export function HeaderLangSwitch() {
  const pathname = usePathname() || "/";
  const current = localeOf(pathname);
  const other = mirrorPath(pathname);
  const jaHref = current === "ja" ? pathname : other;
  const enHref = current === "en" ? pathname : other;

  return (
    <nav className="lang-switch" aria-label="Language">
      <a
        className={current === "ja" ? "lang on" : "lang"}
        href={jaHref}
        hrefLang="ja"
        aria-current={current === "ja" ? "page" : undefined}
      >
        日本語
      </a>
      <a
        className={current === "en" ? "lang on" : "lang"}
        href={enHref}
        hrefLang="en"
        aria-current={current === "en" ? "page" : undefined}
      >
        English
      </a>
    </nav>
  );
}
