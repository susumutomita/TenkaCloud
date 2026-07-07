import { FOOTER_SECTIONS } from "@/lib/navigation";
import { BrandMark } from "./BrandMark";

// The one global footer (ADR-0003 §6), rendered by the app shell on every route
// from the shared FOOTER_SECTIONS model. The brand block, tagline, AWS disclaimer,
// and copyright reproduce the legacy landing footer so the chrome reads as one
// product. Chrome stays English (the JA/EN mirror only covers marketing + catalog).
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
                  <a href={link.href}>{link.label}</a>
                </li>
              ))}
            </ul>
          </div>
        ))}
        <p className="site-footer__disclaimer">
          TenkaCloud is an independent open-source project, not affiliated with, endorsed, or
          sponsored by Amazon Web Services, Inc. AWS and related marks are trademarks of Amazon.com,
          Inc. or its affiliates.
        </p>
        <p className="site-footer__legal">© 2026 BULL LLC · TenkaCloud · Apache License 2.0</p>
      </div>
    </footer>
  );
}
