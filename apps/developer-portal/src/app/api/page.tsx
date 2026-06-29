import { LegacyRedirect } from "@/components/LegacyRedirect";
import { resolveRedirect } from "@/lib/redirects";

const TO = resolveRedirect("/api");

export default function LegacyApiPage() {
  if (!TO) {
    throw new Error("Missing redirect rule for /api");
  }
  return (
    <>
      <meta httpEquiv="refresh" content={`0; url=${TO}`} />
      <LegacyRedirect to={TO} />
    </>
  );
}
