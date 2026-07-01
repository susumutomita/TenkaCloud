import { LegacyRedirect } from "@/components/LegacyRedirect";
import { resolveRedirect } from "@/lib/redirects";

const TO = resolveRedirect("/changelog");

export default function LegacyChangelogPage() {
  if (!TO) {
    throw new Error("Missing redirect rule for /changelog");
  }
  return (
    <>
      <meta httpEquiv="refresh" content={`0; url=${TO}`} />
      <LegacyRedirect to={TO} />
    </>
  );
}
