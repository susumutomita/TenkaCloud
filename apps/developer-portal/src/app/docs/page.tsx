import { LegacyRedirect } from "@/components/LegacyRedirect";
import { resolveRedirect } from "@/lib/redirects";

const TO = resolveRedirect("/docs");

export default function LegacyDocsPage() {
  if (!TO) {
    throw new Error("Missing redirect rule for /docs");
  }
  return (
    <>
      <meta httpEquiv="refresh" content={`0; url=${TO}`} />
      <LegacyRedirect to={TO} />
    </>
  );
}
