// Maturity labels (ADR-0003 §6: capability badges) describe how settled a
// surface, doc, or API operation is. They are a small, shared vocabulary so the
// label means the same thing on a landing card, a docs page, and an API
// operation.
export type Maturity = "stable" | "preview" | "planned";

export const MATURITY_LABELS: Record<Maturity, string> = {
  stable: "Stable",
  preview: "Preview",
  planned: "Planned",
};

export const MATURITY_DESCRIPTIONS: Record<Maturity, string> = {
  stable: "Generally available. Backwards-compatible changes only.",
  preview: "Available for evaluation. May change before it stabilizes.",
  planned: "On the roadmap. Not yet implemented.",
};
