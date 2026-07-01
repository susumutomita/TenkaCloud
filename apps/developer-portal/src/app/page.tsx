import Link from "next/link";
import { MaturityBadge } from "@/components/MaturityBadge";
import { FIRST_PACK_HREF, RUN_PACKS_HREF } from "@/lib/navigation";

// Landing page (ADR-0003 §5: "/" marketing, static). Two doc call-to-actions sit
// in the hero (#2104): "Build a problem pack" is the author journey landing on the
// first-pack tutorial, and "Install and run packs" is the operator journey landing
// on getting started. The demo/organizer conversion paths (the cards below) are
// preserved. `data-cta` marks each doc CTA so navigation measurement can tell docs
// traffic from demo traffic without ever reading pack content.
export default function HomePage() {
  return (
    <>
      <section className="hero">
        <h1>Run cloud competitions, end to end</h1>
        <p>
          TenkaCloud delivers Battle and Challenge problem packs into competitor accounts, scores
          them live, and shows every team their standing — all on serverless AWS.
        </p>
        <div className="hero__actions">
          <Link className="btn" data-cta="author-build-pack" href={FIRST_PACK_HREF}>
            Build a problem pack
          </Link>
          <Link className="btn btn--secondary" data-cta="operator-run-packs" href={RUN_PACKS_HREF}>
            Install and run packs
          </Link>
        </div>
        <p className="hero__hint">Scaffold and validate a pack offline before you ship it:</p>
        <pre className="hero__code">
          <code>{`bun --cwd infrastructure run pack init ./my-first-pack
bun --cwd infrastructure run pack validate ./my-first-pack`}</code>
        </pre>
      </section>
      <div className="page">
        <div className="card-grid">
          <div className="card">
            <h3>
              Problem packs <MaturityBadge level="stable" />
            </h3>
            <p>Battle (real-time) and Challenge (self-paced) packs, authored once and reused.</p>
            <Link href="/developers/docs/concepts/problem-packs/">Learn about packs →</Link>
          </div>
          <div className="card">
            <h3>
              Platform API <MaturityBadge level="preview" />
            </h3>
            <p>List packs, inspect compatibility, and drive deployments from the HTTP API.</p>
            <Link href="/developers/api/">API reference →</Link>
          </div>
          <div className="card">
            <h3>
              Sandbox console <MaturityBadge level="planned" />
            </h3>
            <p>An isolated, authenticated console for trying the API safely. Coming soon.</p>
            <Link href="/developers/">Developer hub →</Link>
          </div>
        </div>
      </div>
    </>
  );
}
