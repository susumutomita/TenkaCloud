/**
 * Participant-facing fresh-clone contract: Docker only (Issue #2906).
 *
 * README.md, README.ja.md, docs/local-play.md, and the demo fixture are pinned
 * to this sequence by tests. `make local` needs Git, Make, Docker Engine, and
 * Docker Compose v2 on the host — no Bun, Node, or node_modules. The prior
 * Bun-based sequence (`make local-onboard` then `make local`) survives as the
 * developer path under `make local-dev`.
 */
export const LOCAL_ONBOARDING_COMMANDS = [
  "git clone --recurse-submodules https://github.com/susumutomita/TenkaCloud.git",
  "cd TenkaCloud",
  "make local",
] as const;
