import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = { title: "Examples" };

// /developers/examples/* provides copyable SDK / CLI / HTTP
// snippets. Concise but real for the foundation; CI-tested snippet sources are a
// follow-up.
export default function ExamplesPage() {
  return (
    <div className="page">
      <h1>Examples</h1>
      <p>Copyable snippets for the most common tasks.</p>

      <h2>List packs (HTTP)</h2>
      <pre>
        <code>{`curl ${"$"}{SANDBOX_BASE_URL}/packs`}</code>
      </pre>

      <h2>Deploy a pack (CLI)</h2>
      <pre>
        <code>make deploy</code>
      </pre>

      <p>
        See the <Link href="/developers/api/">API reference</Link> for the full operation list.
      </p>
    </div>
  );
}
