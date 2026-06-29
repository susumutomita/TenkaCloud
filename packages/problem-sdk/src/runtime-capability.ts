/**
 * [Problem SDK / Issue #2106] The runtime capabilities a Pack may declare.
 *
 * A `RuntimeCapability` is a `(provider, engine)` pair the platform recognizes —
 * executable today, a reserved roadmap pair, or a local container runtime. The
 * set is derived from `@tenkacloud/problem-runtime` so there is one source of
 * truth: when an engine ships (moves out of RESERVED_RUNTIMES) the supported set
 * here follows automatically.
 */

import {
  CONTAINER_RUNTIMES,
  EXECUTABLE_ENGINE,
  EXECUTABLE_PROVIDER,
  RESERVED_RUNTIMES,
} from "@tenkacloud/problem-runtime";

/** A `(provider, engine)` runtime capability a Pack may require. */
export interface RuntimeCapability {
  readonly provider: string;
  readonly engine: string;
}

/**
 * Every runtime capability the platform recognizes (executable + reserved +
 * container), deduplicated and stable-sorted by `provider/engine`. Authors can
 * check a `requiredRuntimes` entry against this list before publishing.
 */
export const SUPPORTED_RUNTIME_CAPABILITIES: readonly RuntimeCapability[] = dedupeAndSort([
  { provider: EXECUTABLE_PROVIDER, engine: EXECUTABLE_ENGINE },
  ...RESERVED_RUNTIMES.map((r) => ({ provider: r.provider, engine: r.engine })),
  ...CONTAINER_RUNTIMES.map((r) => ({ provider: r.provider, engine: r.engine })),
]);

/** True when `(provider, engine)` is a recognized platform runtime capability. */
export function isSupportedRuntimeCapability(provider: string, engine: string): boolean {
  return SUPPORTED_RUNTIME_CAPABILITIES.some(
    (capability) => capability.provider === provider && capability.engine === engine,
  );
}

function dedupeAndSort(capabilities: readonly RuntimeCapability[]): RuntimeCapability[] {
  const byKey = new Map<string, RuntimeCapability>();
  for (const capability of capabilities) {
    byKey.set(`${capability.provider}/${capability.engine}`, capability);
  }
  return [...byKey.values()].sort((a, b) =>
    `${a.provider}/${a.engine}`.localeCompare(`${b.provider}/${b.engine}`),
  );
}
