import { FOOTER_SECTIONS } from "@/lib/navigation";

// The one global footer (ADR-0003 §6), rendered by the app shell on every route
// from the shared FOOTER_SECTIONS model.
export function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="site-footer__inner">
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
      </div>
    </footer>
  );
}
