import type { Metadata } from "next";
import { MachineApiPage } from "@/components/MachineApiPage";
import { MACHINE_API_COPY } from "@/content/machine-api-copy";

// Issue #2950: machine (M2M) API reference, Japanese (primary), served at
// "/developers/api/machine/". The spec is the generated artifact — see
// src/content/machine-api.generated.ts and scripts/generate-machine-api.ts.
export const metadata: Metadata = {
  title: MACHINE_API_COPY.ja.meta.title,
  description: MACHINE_API_COPY.ja.meta.description,
  alternates: {
    canonical: "/developers/api/machine/",
    languages: {
      ja: "/developers/api/machine/",
      en: "/en/developers/api/machine/",
    },
  },
};

export default function MachineApiReferencePage() {
  return <MachineApiPage locale="ja" />;
}
