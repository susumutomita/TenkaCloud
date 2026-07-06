/**
 * [#2392] Pure parsing for a multi-problem local session. The per-index
 * port-block planning that used to live here moved into the on-demand
 * lifecycle (`problem-lifecycle.ts` assigns offsets at start time;
 * `container-runner.ts` applies them), so only the `PROBLEM=` argument
 * parsing remains.
 */

/**
 * Split a `PROBLEM="a,b,c"` argument into an ordered, de-duplicated id list.
 * Blank entries are dropped; a repeated id keeps only its first position.
 */
export function parseProblemIds(arg: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of arg.split(",")) {
    const id = raw.trim();
    if (id.length > 0 && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}
