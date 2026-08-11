import { FOOTER_SECTIONS, LEGAL_LINKS, SOCIAL_LINKS } from "@/lib/navigation";
import { isInternalHref } from "@/lib/routes";
import { BrandMark } from "./BrandMark";

// Inline social marks, copied from the legacy landing footer so the Follow column
// reads identically.
const SOCIAL_ICON_PATHS: Record<string, string> = {
  X: "M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z",
  Instagram:
    "M12 2.16c3.2 0 3.58.01 4.85.07 1.17.05 1.8.25 2.23.41.56.22.96.48 1.38.9.42.42.68.82.9 1.38.16.42.36 1.06.41 2.23.06 1.27.07 1.65.07 4.85s-.01 3.58-.07 4.85c-.05 1.17-.25 1.8-.41 2.23-.22.56-.48.96-.9 1.38-.42.42-.82.68-1.38.9-.42.16-1.06.36-2.23.41-1.27.06-1.65.07-4.85.07s-3.58-.01-4.85-.07c-1.17-.05-1.8-.25-2.23-.41a3.7 3.7 0 0 1-1.38-.9 3.7 3.7 0 0 1-.9-1.38c-.16-.42-.36-1.06-.41-2.23-.06-1.27-.07-1.65-.07-4.85s.01-3.58.07-4.85c.05-1.17.25-1.8.41-2.23.22-.56.48-.96.9-1.38.42-.42.82-.68 1.38-.9.42-.16 1.06-.36 2.23-.41C8.42 2.17 8.8 2.16 12 2.16zm0 1.62c-3.15 0-3.52.01-4.76.07-1.15.05-1.77.24-2.19.41-.55.21-.94.47-1.35.88-.41.41-.67.8-.88 1.35-.17.42-.36 1.04-.41 2.19-.06 1.24-.07 1.61-.07 4.76s.01 3.52.07 4.76c.05 1.15.24 1.77.41 2.19.21.55.47.94.88 1.35.41.41.8.67 1.35.88.42.17 1.04.36 2.19.41 1.24.06 1.61.07 4.76.07s3.52-.01 4.76-.07c1.15-.05 1.77-.24 2.19-.41.55-.21.94-.47 1.35-.88.41-.41.67-.8.88-1.35.17-.42.36-1.04.41-2.19.06-1.24.07-1.61.07-4.76s-.01-3.52-.07-4.76c-.05-1.15-.24-1.77-.41-2.19a3.6 3.6 0 0 0-.88-1.35 3.6 3.6 0 0 0-1.35-.88c-.42-.17-1.04-.36-2.19-.41-1.24-.06-1.61-.07-4.76-.07zm0 2.76a5.3 5.3 0 1 1 0 10.6 5.3 5.3 0 0 1 0-10.6zm0 8.74a3.44 3.44 0 1 0 0-6.88 3.44 3.44 0 0 0 0 6.88zm6.75-8.94a1.24 1.24 0 1 1-2.48 0 1.24 1.24 0 0 1 2.48 0z",
};

function footerLinkProps(href: string) {
  return isInternalHref(href)
    ? {}
    : { target: "_blank" as const, rel: "noopener noreferrer" as const };
}

// The app shell renders one global footer on every route
// from the shared navigation model. The brand block, tagline, columns, social
// marks, AWS disclaimer, legal links, and copyright reproduce the legacy landing
// footer so the chrome reads as one product (#2429).
export function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="site-footer__inner">
        <div className="site-footer__brandcol">
          <span className="site-footer__brand">
            <BrandMark size={20} />
            <span>TenkaCloud</span>
          </span>
          <p className="site-footer__tag">
            Open-source cloud competitions on real AWS. Apache License 2.0.
          </p>
        </div>
        {FOOTER_SECTIONS.map((section) => (
          <div key={section.title}>
            <h2>{section.title}</h2>
            <ul>
              {section.links.map((link) => (
                <li key={link.href}>
                  <a href={link.href} {...footerLinkProps(link.href)}>
                    {link.label}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        ))}
        <div className="site-footer__social">
          <h2>Follow</h2>
          <ul>
            {SOCIAL_LINKS.map((link) => (
              <li key={link.href}>
                <a
                  className="social-link"
                  href={link.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={link.label}
                >
                  <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
                    <path fill="currentColor" d={SOCIAL_ICON_PATHS[link.label]} />
                  </svg>
                  <span>{link.label}</span>
                </a>
              </li>
            ))}
          </ul>
        </div>
        <p className="site-footer__disclaimer">
          TenkaCloud is an independent open-source project, not affiliated with, endorsed, or
          sponsored by Amazon Web Services, Inc. AWS and related marks are trademarks of Amazon.com,
          Inc. or its affiliates.
        </p>
        <div className="site-footer__legal">
          <span>© 2026 BULL LLC · TenkaCloud · Apache License 2.0</span>
          <span className="site-footer__legal-links">
            {LEGAL_LINKS.map((link) => (
              <a key={link.href} href={link.href}>
                {link.label}
              </a>
            ))}
          </span>
        </div>
      </div>
    </footer>
  );
}
