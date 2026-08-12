/**
 * Generic PR title gate (#3024 PR 4). GitHub Release notes are generated from merged PR
 * titles, so a title like "update" or "修正" ships meaningless release history. This gate
 * rejects titles that are a generic word — exactly, or effectively exactly once every
 * non-letter/digit character is stripped ("[WIP]", "fix.", "更新。"). Specific titles,
 * including Conventional Commit forms like `fix(local-play): handle EPIPE`, always pass:
 * their descriptions make the normalized text longer than any listed word.
 *
 * The quality bar is enforced on the input (the PR title, before merge), never by
 * hand-editing generated Release notes afterwards.
 */

export const GENERIC_PR_TITLES: readonly string[] = [
  "update",
  "fix",
  "change",
  "changes",
  "misc",
  "wip",
  "work",
  "修正",
  "更新",
  "変更",
];

/** Lowercases and strips everything that is not a letter or digit in any script. */
function normalizeTitle(title: string): string {
  return title.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

/**
 * Returns a human-readable rejection reason, or null when the title is acceptable.
 * Empty titles (or titles that normalize to nothing) are rejected too: a release note
 * line needs at least one concrete word.
 */
export function explainGenericPrTitle(title: string): string | null {
  const normalized = normalizeTitle(title);
  if (normalized === "") {
    return `PR title ${JSON.stringify(title)} carries no words at all.`;
  }
  if (GENERIC_PR_TITLES.includes(normalized)) {
    return (
      `PR title ${JSON.stringify(title)} is the generic word ${JSON.stringify(normalized)}. ` +
      "Merged PR titles become Release notes lines; say what changed and where, e.g. " +
      '"fix(local-play): handle EPIPE from the simulator proxy".'
    );
  }
  return null;
}

function main(): void {
  const title = process.env.PR_TITLE;
  if (title === undefined) {
    console.error("PR_TITLE environment variable is not set.");
    process.exit(2);
  }
  const reason = explainGenericPrTitle(title);
  if (reason !== null) {
    console.error(reason);
    process.exit(1);
  }
  console.log(`PR title ${JSON.stringify(title)} passes the generic-title gate.`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
