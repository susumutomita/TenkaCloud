import type { Metadata } from "next";
import { MaturityBadge } from "@/components/MaturityBadge";

export const metadata: Metadata = { title: "Changelog" };

interface ChangelogEntry {
  readonly date: string;
  readonly title: string;
  readonly notes: readonly string[];
}

// Changelog (ADR-0003 §5: /developers/changelog). Release history tied to the
// pack / SDK version axes. Generated from release entries in a follow-up; seeded
// here so the route is real.
const ENTRIES: readonly ChangelogEntry[] = [
  {
    date: "2026-06-29",
    title: "Developer platform foundation",
    notes: [
      "Unified Next.js developer portal: landing, docs, API reference, examples, changelog.",
      "Browse-only API reference rendered from the committed OpenAPI artifact.",
    ],
  },
];

export default function ChangelogPage() {
  return (
    <div className="page">
      <h1>
        Changelog <MaturityBadge level="preview" />
      </h1>
      {ENTRIES.map((entry) => (
        <section key={entry.date}>
          <h2>
            {entry.title} <small>· {entry.date}</small>
          </h2>
          <ul>
            {entry.notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
