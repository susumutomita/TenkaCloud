/**
 * [#2392] Pure planning for a multi-problem local session: turn a list of
 * loaded problems + their compose text into per-problem plans with a distinct
 * host-port block each. Kept side-effect-free (no fs / docker) so it is fully
 * unit-tested; the orchestrator (`tenkacloud-local.ts`) does the temp-file
 * writes and `docker compose` calls around it.
 */

import type { ContainerProblem } from "./manifest";
import {
  offsetLoopbackEndpoints,
  offsetLoopbackUrl,
  portOffsetForIndex,
  remapComposeHostPorts,
} from "./port-remap";

export interface PlannedProblem {
  readonly index: number;
  /** host-port offset applied to this problem (0 for the first). */
  readonly offset: number;
  /** the problem with `challengeEndpoints` / `verifyUrl` moved onto its port block. */
  readonly problem: ContainerProblem;
  /** compose text to run: rewritten when offset > 0, byte-identical otherwise. */
  readonly composeText: string;
  /** true when the compose text was rewritten and needs a temp file. */
  readonly remapped: boolean;
}

/**
 * Plan one problem at position `index`: assign its port block, remap the compose
 * host ports, and move the participant-facing URLs onto the same block so the
 * portal and the /verify calls address the right container.
 */
export function planProblem(
  problem: ContainerProblem,
  index: number,
  composeText: string,
): PlannedProblem {
  const offset = portOffsetForIndex(index);
  const { text, portMap } = remapComposeHostPorts(composeText, offset);
  return {
    index,
    offset,
    composeText: text,
    remapped: offset > 0,
    problem: {
      ...problem,
      challengeEndpoints: offsetLoopbackEndpoints(problem.challengeEndpoints, portMap),
      verifyUrl: offsetLoopbackUrl(problem.verifyUrl, portMap),
    },
  };
}

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
