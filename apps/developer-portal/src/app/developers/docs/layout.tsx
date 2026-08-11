import type { ReactNode } from "react";
import { DocsSidebar } from "@/components/DocsSidebar";

// The /developers/docs/* layout wraps every MDX docs page with the
// shared sidebar, inside the global app shell — one navigation model, no second
// shell.
export default function DocsLayout({ children }: { children: ReactNode }) {
  return (
    <div className="docs-layout">
      <DocsSidebar />
      <article className="docs-content">{children}</article>
    </div>
  );
}
