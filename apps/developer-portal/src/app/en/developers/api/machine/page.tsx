import type { Metadata } from "next";
import { MachineApiPage } from "@/components/MachineApiPage";
import { MACHINE_API_COPY } from "@/content/machine-api-copy";

// Issue #2950: machine (M2M) API reference, English mirror, served at
// "/en/developers/api/machine/". Same generated spec as the Japanese page; only
// the chrome copy differs.
export const metadata: Metadata = {
  title: MACHINE_API_COPY.en.meta.title,
  description: MACHINE_API_COPY.en.meta.description,
  alternates: {
    canonical: "/en/developers/api/machine/",
    languages: {
      ja: "/developers/api/machine/",
      en: "/en/developers/api/machine/",
    },
  },
};

export default function EnglishMachineApiReferencePage() {
  return <MachineApiPage locale="en" />;
}
