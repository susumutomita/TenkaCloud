import { DOC_SECTIONS } from "@/content/docs-registry";
import { MaturityBadge } from "./MaturityBadge";

// The docs navigation tree (ADR-0003 §6: docs and reference share one navigation
// model). Driven by the same DOC_SECTIONS registry that feeds search and the link
// checker, plus a static entry for the API reference.
export function DocsSidebar() {
  return (
    <nav className="docs-sidebar" aria-label="Docs">
      {DOC_SECTIONS.map((section) => (
        <div key={section.title}>
          <h2>{section.title}</h2>
          <ul>
            {section.pages.map((page) => (
              <li key={page.slug}>
                <a href={page.href}>{page.title}</a> <MaturityBadge level={page.maturity} />
              </li>
            ))}
          </ul>
        </div>
      ))}
      <div>
        <h2>Reference</h2>
        <ul>
          <li>
            <a href="/developers/api/">API reference</a>
          </li>
        </ul>
      </div>
    </nav>
  );
}
