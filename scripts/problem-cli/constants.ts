import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export const SCRIPTS_ROOT = resolve(__dirname, "..");
export const REPO_ROOT = resolve(SCRIPTS_ROOT, "..");
export const TEMPLATES_ROOT = join(REPO_ROOT, ".claude/templates/problems");
export const PROBLEMS_ROOT = join(REPO_ROOT, "problems");

export const KINDS = [
  "flag",
  "uptime-flat",
  "uptime-multi",
  "phased-polling",
  "attack-detection",
] as const;

export type Kind = (typeof KINDS)[number];

/**
 * Kind -> default category mapping. flag は Challenge、残りは Battle が想定の主用途。
 * operator は --category override で上書き可能。
 */
export const KIND_TO_DEFAULT_CATEGORY: Record<Kind, "Battle" | "Challenge"> = {
  flag: "Challenge",
  "uptime-flat": "Battle",
  "uptime-multi": "Battle",
  "phased-polling": "Battle",
  "attack-detection": "Battle",
};
