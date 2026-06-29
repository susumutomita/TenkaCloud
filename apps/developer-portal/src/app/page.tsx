import Link from "next/link";
import { MaturityBadge } from "@/components/MaturityBadge";
import { FIRST_PACK_HREF } from "@/lib/navigation";

// Landing page (ADR-0003 §5: "/" marketing, static). The "Deploy your First Pack"
// CTA is the acceptance-criteria path: a visitor reaches "First Pack" from the
// landing page without leaving the app shell.
export default function HomePage() {
  return (
    <>
      <section className="hero">
        <h1>Run cloud competitions, end to end</h1>
        <p>
          TenkaCloud delivers Battle and Challenge problem packs into competitor accounts, scores
          them live, and shows every team their standing — all on serverless AWS.
        </p>
        <Link className="btn" href={FIRST_PACK_HREF}>
          Deploy your First Pack
        </Link>
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
