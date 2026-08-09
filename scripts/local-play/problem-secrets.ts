import { createHmac, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Per-problem container secrets (`FLAG_SEED` and friends) for local play.
 *
 * ## Why these are derived rather than drawn
 *
 * They used to be `randomBytes(32)` per `docker compose up`. That is the right shape for
 * "a deployment's answers cannot be memorised from someone else's deployment", and the
 * wrong shape for what actually happens to a container: it gets restarted.
 *
 * Local play caps concurrent problems and evicts the least-recently-used one to make
 * room. The evicted problem restarts on its next request — and with a fresh draw, every
 * value the participant derived from the old seed stops being the answer. Nothing they
 * did was wrong. Measured across one session: four wrong submissions on
 * `stackstack-secrets`, two on `stackstack-observability`, a scored penalty on
 * `hollow-invite`, and `stackstack-defend`'s final checkpoint (which needs sixty
 * uninterrupted seconds) failing five times in a row. The same happens to anyone who
 * takes the stop button's own advice to free local resources between sessions.
 *
 * Deriving keeps the property that mattered and drops the one that hurt:
 *
 *   secret = HMAC-SHA256(master, "<problemId>\0<envName>")
 *
 * - **Same problem, restarted** — same secret. Eviction becomes invisible to scoring,
 *   which is what a participant already assumes when the UI says the problem is running.
 * - **Different problems** — different secrets, because the problem id is bound in.
 * - **Different deployments** — different secrets, because the master is generated once
 *   per deployment directory. An answer still does not carry from someone else's run.
 *
 * The master is 32 random bytes in `localDir`, mode 0600. It is a local-play artifact,
 * not a credential for anything outside this machine, but it does determine every
 * problem's answers in this deployment, so it is not written world-readable and it is
 * not logged.
 */

const MASTER_FILE = "problem-secrets.key";

/** Read this deployment's master secret, creating it on first use. */
export function loadOrCreateMasterSecret(
  localDir: string,
  io: {
    exists?: (path: string) => boolean;
    read?: (path: string) => string;
    write?: (path: string, content: string) => void;
    randomHex?: () => string;
  } = {},
): string {
  const path = join(localDir, MASTER_FILE);
  const exists = io.exists ?? ((target: string) => existsSync(target));
  const read = io.read ?? ((target: string) => readFileSync(target, "utf8"));
  const randomHex = io.randomHex ?? (() => randomBytes(32).toString("hex"));
  const write =
    io.write ??
    ((target: string, content: string) => {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content, { encoding: "utf8", mode: 0o600 });
      // `mode` on writeFileSync only applies when the file is created, so an
      // existing file left over with looser permissions is tightened here too.
      chmodSync(target, 0o600);
    });

  if (exists(path)) {
    const stored = read(path).trim();
    // A truncated or hand-edited key would silently change every answer in the
    // deployment, which is the failure this whole file exists to remove. Replace it
    // rather than derive from something that is not a key.
    if (/^[0-9a-f]{64}$/.test(stored)) return stored;
  }
  const created = randomHex();
  write(path, `${created}\n`);
  return created;
}

/**
 * The container environment for one problem: one secret per declared `secretEnv` name.
 *
 * Deterministic in (master, problemId, name) — see the module docstring for why that is
 * the point rather than a shortcut.
 */
export function deriveSecretEnv(
  master: string,
  problemId: string,
  names: readonly string[] = [],
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of names) {
    // NUL-separated so a problem id ending in the start of an env name cannot collide
    // with a different (problemId, name) pair.
    env[name] = createHmac("sha256", master).update(`${problemId}\0${name}`).digest("hex");
  }
  return env;
}
