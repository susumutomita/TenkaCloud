import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = { title: "Product" };

export default function ProductPage() {
  return (
    <div className="page">
      <h1>Product</h1>
      <p>
        TenkaCloud is a multi-tenant platform for running cloud competitions. Organizers pick packs,
        deploy them into competitor accounts, and watch scoring update in real time.
      </p>
      <div className="card-grid">
        <div className="card">
          <h3>Control plane</h3>
          <p>Tenant management, invitations, and the system-admin console on SBT.</p>
        </div>
        <div className="card">
          <h3>Application plane</h3>
          <p>Per-tenant admin console and the competitor participant portal.</p>
        </div>
        <div className="card">
          <h3>Problem deploy</h3>
          <p>Cross-account deployment of pack templates with strict isolation.</p>
        </div>
      </div>
      <p>
        Ready to build? Head to the <Link href="/developers/">developer hub</Link>.
      </p>
    </div>
  );
}
