import { LegacyRedirect } from "@/components/LegacyRedirect";
import { resolveRedirect } from "@/lib/redirects";

const TO = resolveRedirect("/get-started");

export default function LegacyGetStartedPage() {
  if (!TO) {
    throw new Error("Missing redirect rule for /get-started");
  }
  return (
    <>
      <meta httpEquiv="refresh" content={`0; url=${TO}`} />
      <LegacyRedirect to={TO} />
    </>
  );
}
