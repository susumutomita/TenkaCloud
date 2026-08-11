import { MATURITY_DESCRIPTIONS, MATURITY_LABELS, type Maturity } from "@/lib/maturity";

// A shared maturity badge rendered next to docs
// pages, landing cards, and — later — API operations, so maturity reads the same
// everywhere.
export function MaturityBadge({ level }: { level: Maturity }) {
  return (
    <span
      className={`badge badge--${level}`}
      title={MATURITY_DESCRIPTIONS[level]}
      data-maturity={level}
    >
      {MATURITY_LABELS[level]}
    </span>
  );
}
