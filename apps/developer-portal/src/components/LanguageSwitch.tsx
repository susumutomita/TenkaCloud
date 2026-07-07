// A minimal in-page language switch, mirroring the pattern the legal pages use
// (a link to the same page in the other language). The marketing home and catalog
// are the only routes with a JA/EN mirror; the shared shell chrome stays English.
export interface LanguageSwitchProps {
  readonly ariaLabel: string;
  readonly otherHref: string;
  readonly otherLabel: string;
}

export function LanguageSwitch({ ariaLabel, otherHref, otherLabel }: LanguageSwitchProps) {
  return (
    <nav className="lang-switch" aria-label={ariaLabel}>
      <a href={otherHref}>{otherLabel}</a>
    </nav>
  );
}
