/**
 * Participant-facing fresh-clone contract while local play still needs Bun.
 *
 * README.md, README.ja.md, docs/local-play.md, and the demo fixture are pinned
 * to this sequence by tests. Issue #2906 can replace this one value with the
 * Docker-only sequence without silently leaving one player surface behind.
 */
export const LOCAL_ONBOARDING_COMMANDS = [
  "git clone --recurse-submodules https://github.com/susumutomita/TenkaCloud.git",
  "cd TenkaCloud",
  "make local-onboard",
  "make local",
] as const;
