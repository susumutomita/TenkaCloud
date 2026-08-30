import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { safeLoad } from "js-yaml";

/**
 * [Issue #3097 / ADR-0003 Phase A] Deny-by-default structural policy for catalog-authored
 * `local/docker-compose.yml` files.
 *
 * `scripts/local-play/manifest.ts` validates problem metadata *wiring* only; nothing before
 * this module read the Compose file's own content for anything beyond port-remapping text
 * (`port-remap.ts`, which preserves everything else byte-for-byte). A malicious or compromised
 * catalog Compose file could therefore declare `privileged: true`, mount the Docker socket,
 * join a host namespace, or bind-mount an arbitrary host path, and nothing in local play would
 * refuse to start it — see the compose trust table for
 * the full threat model this closes.
 *
 * This is Phase A of that ADR: a raw-YAML structural validator wired in front of the *existing*
 * adapter (`container-runner.ts`), not the canonical `docker compose config`-based validator the
 * Phase B broker will run. It is deliberately Docker-free — like the rest of `ContainerRunner`'s
 * dependencies, it must stay unit-testable without a daemon and must not make `tenkacloud local
 * list` (which never touches Docker today) start requiring it. The allowlists below are built
 * from every feature the current catalog (`problems/` submodule) actually uses — see
 * `compose-policy.test.ts`'s catalog-wide test — not from what Compose supports in general.
 */

// ---------------------------------------------------------------------------
// Path containment (shared by `runtime.entry`, `build.context`, `build.dockerfile`, volume
// bind-mount sources, and `security_opt`'s `seccomp=<file>` form).
// ---------------------------------------------------------------------------

export interface ContainmentFs {
  readonly existsSync: (path: string) => boolean;
  /**
   * Optional: resolves symlinks. Omitted by an in-memory test fake (there is nothing on real
   * disk to resolve); production always supplies the real `node:fs` implementation. Skipping
   * the symlink-resolution step when absent is safe because it only ever *narrows* what a fake
   * fs accepts relative to production, never the other way around.
   */
  readonly realpathSync?: (path: string) => string;
}

export const NODE_CONTAINMENT_FS: ContainmentFs = { existsSync, realpathSync };

/**
 * Resolve `candidate` relative to `baseDir` and verify it stays within one of `allowedRoots`,
 * both lexically (rejects `..` traversal and absolute paths) and — when the path exists and the
 * fs supports it — after resolving every symlink on the path (rejects a symlink planted inside
 * an otherwise-contained directory that points outside it). Returns the lexically resolved
 * absolute path on success; throws `label`-prefixed on any escape.
 */
export function resolveContainedPath(
  label: string,
  candidate: string,
  baseDir: string,
  allowedRoots: readonly string[],
  fs: ContainmentFs = NODE_CONTAINMENT_FS,
): string {
  if (isAbsolute(candidate)) {
    throw new Error(`${label} must be a relative path (got an absolute path: "${candidate}")`);
  }
  const lexical = resolve(baseDir, candidate);
  const lexicallyContained = allowedRoots.some(
    (root) => lexical === root || lexical.startsWith(root + sep),
  );
  if (!lexicallyContained) {
    throw new Error(`${label} escapes its allowed directory: "${candidate}"`);
  }
  if (!fs.realpathSync || !fs.existsSync(lexical)) {
    // Nothing on disk yet (or the fs fake cannot resolve symlinks) — a path that does not exist
    // cannot itself be a symlink escape, and lexical containment above already rejected `..`.
    return lexical;
  }
  const real = fs.realpathSync(lexical);
  const reallyContained = allowedRoots.some((root) => {
    if (!fs.existsSync(root)) return false;
    const realRoot = fs.realpathSync(root);
    return real === realRoot || real.startsWith(realRoot + sep);
  });
  if (!reallyContained) {
    throw new Error(
      `${label} resolves outside its allowed directory via a symlink: "${candidate}"`,
    );
  }
  return lexical;
}

/**
 * `runtime.entry` containment: the compose file itself must live under the problem's own
 * directory, with no lexical `..` escape and no symlink escape after resolution. Called from
 * `manifest.ts` in place of a bare `existsSync` join, so every local-play problem gets this
 * check regardless of which seam later reads the file's content.
 */
export function resolveComposeEntryPath(
  problemDir: string,
  entryRelativePath: string,
  fs: ContainmentFs = NODE_CONTAINMENT_FS,
): string {
  const composePath = resolveContainedPath(
    "runtime.entry",
    entryRelativePath,
    problemDir,
    [problemDir],
    fs,
  );
  if (!fs.existsSync(composePath)) {
    // Preserve the exact historical wording: infrastructure/test/scripts/local-play-manifest.test.ts
    // asserts on this message for the "compose entry is absent" case.
    throw new Error(`compose file was not found: ${composePath}`);
  }
  return composePath;
}

/**
 * [AGENTS.md (TenkaCloudChallenge) §13] "A Compose build context may point into
 * `runtimes/<family>/` only when that exact implementation is shared by multiple problems."
 * That sibling directory sits at `<problemsRoot>/runtimes`, two levels above every problem
 * directory (`<problemsRoot>/{challenges,battles}/<id>`) — the same layout
 * `catalog-loader.ts#problemSearchRoots` assumes. Centralized here so the one hardcoded
 * assumption about catalog layout lives in a single, documented place.
 */
export function catalogRuntimesRoot(problemDir: string): string {
  return join(dirname(dirname(problemDir)), "runtimes");
}

// ---------------------------------------------------------------------------
// Static `${VAR:-default}` resolution for path-bearing fields only. Compose interpolates these
// for real at `docker compose` invocation time; this module never runs Docker, so it can only
// see literal defaults. A reference with no literal default (`${VAR}`, `${VAR:?msg}`) cannot be
// verified statically and is denied rather than guessed at — every path-bearing field in the
// current catalog resolves without needing this (see compose-policy.test.ts), so this is not a
// live restriction today, only a fail-closed guard against a future one.
// ---------------------------------------------------------------------------

const ENV_INTERPOLATION_RE = /\$\{([^}]+)\}/g;

export interface StaticResolution {
  readonly value: string;
  readonly unresolved: boolean;
}

export function resolveStaticDefaults(text: string): StaticResolution {
  let unresolved = false;
  const value = text.replace(ENV_INTERPOLATION_RE, (_match, body: string) => {
    const cut = body.indexOf(":-");
    if (cut === -1) {
      unresolved = true;
      return "";
    }
    return body.slice(cut + 2);
  });
  return { value, unresolved };
}

// ---------------------------------------------------------------------------
// Violations
// ---------------------------------------------------------------------------

export interface ComposePolicyViolation {
  /** Stable machine-readable rule id . */
  readonly rule: string;
  readonly message: string;
}

export class ComposePolicyError extends Error {
  constructor(
    readonly violations: readonly ComposePolicyViolation[],
    composePath: string,
  ) {
    super(
      `compose policy violation in ${composePath}:\n` +
        violations.map((v) => `  - [${v.rule}] ${v.message}`).join("\n"),
    );
    this.name = "ComposePolicyError";
  }
}

function deny(violations: ComposePolicyViolation[], rule: string, message: string): void {
  violations.push({ rule, message });
}

/** Runs a containment/resolution helper that throws, turning the throw into a violation. */
function tryRule(violations: ComposePolicyViolation[], rule: string, run: () => void): void {
  try {
    run();
  } catch (error) {
    deny(violations, rule, error instanceof Error ? error.message : String(error));
  }
}

// ---------------------------------------------------------------------------
// Allowlists — built from what `problems/` (the TenkaCloudChallenge catalog submodule) actually
// uses today. See compose-policy.test.ts's catalog-wide scan, which fails if the real catalog
// ever needs a feature this list does not grant. Extending this list is a deliberate, reviewed
// PR — not something a problem's own Compose file can opt itself into.
// ---------------------------------------------------------------------------

const ALLOWED_TOP_LEVEL_KEYS = new Set(["services", "volumes", "networks", "name", "version"]);

const ALLOWED_SERVICE_KEYS = new Set([
  "build",
  "cap_drop",
  "cpus",
  "depends_on",
  "deploy",
  "entrypoint",
  "environment",
  "healthcheck",
  "image",
  "mem_limit",
  "networks",
  "pids_limit",
  "ports",
  "read_only",
  "restart",
  "security_opt",
  "tmpfs",
  "user",
  "volumes",
]);

/** Friendlier rule id + message for the specific items Issue #3097 names; anything else denied
 * by omission from {@link ALLOWED_SERVICE_KEYS} still gets a generic, still-actionable message
 * (see the `unknown-compose-feature` fallback in {@link checkServiceKey}). */
const NAMED_DANGEROUS_SERVICE_KEYS: Readonly<Record<string, { rule: string; message: string }>> = {
  privileged: { rule: "privileged", message: "privileged containers are denied" },
  cap_add: {
    rule: "cap-add",
    message: "cap_add is denied (dropping capabilities with cap_drop is allowed; adding is not)",
  },
  devices: { rule: "device", message: "host device pass-through (devices) is denied" },
  device_cgroup_rules: { rule: "device", message: "device cgroup rules are denied" },
  pid: {
    rule: "host-namespace",
    message: "joining a host or another container's PID namespace is denied",
  },
  ipc: {
    rule: "host-namespace",
    message: "joining a host or another container's IPC namespace is denied",
  },
  network_mode: {
    rule: "host-namespace",
    message: "network_mode is denied (host networking and container-namespace joins included)",
  },
  userns_mode: { rule: "host-namespace", message: "userns_mode is denied" },
};

const ALLOWED_BUILD_KEYS = new Set(["context", "dockerfile", "target"]);

const ALLOWED_NETWORK_KEYS = new Set(["driver", "internal", "driver_opts", "name", "external"]);
const ALLOWED_VOLUME_DEF_KEYS = new Set(["name"]);

const LOOPBACK_PORT_RE = /^(127\.0\.0\.1|localhost):\d{1,5}:\d{1,5}(\/tcp)?$/;
const UNCONFINED_RE = /unconfined/i;
const NO_NEW_PRIVILEGES_FALSE_RE = /no-new-privileges\s*:\s*false/i;

// ---------------------------------------------------------------------------
// Structural checks
// ---------------------------------------------------------------------------

type PlainObject = Readonly<Record<string, unknown>>;

function isPlainObject(value: unknown): value is PlainObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface ComposePolicyContext {
  /** Absolute, real problem directory (e.g. `<problemsRoot>/challenges/<id>`). */
  readonly problemDir: string;
  /** Absolute path to the compose file being validated (used only to resolve relative paths the
   * same way `docker compose` does: relative to the compose file's own directory). */
  readonly composePath: string;
}

function checkTopLevel(doc: PlainObject, violations: ComposePolicyViolation[]): void {
  for (const key of Object.keys(doc)) {
    if (ALLOWED_TOP_LEVEL_KEYS.has(key) || key.startsWith("x-")) continue;
    deny(
      violations,
      "unknown-compose-feature",
      `top-level key "${key}" is not in the reviewed allowlist`,
    );
  }
}

function checkNamedVolumes(
  doc: PlainObject,
  violations: ComposePolicyViolation[],
): ReadonlySet<string> {
  const declared = new Set<string>();
  const volumes = doc.volumes;
  if (!isPlainObject(volumes)) return declared;
  for (const [name, def] of Object.entries(volumes)) {
    declared.add(name);
    if (def === null || def === undefined) continue;
    if (!isPlainObject(def)) {
      deny(violations, "unknown-compose-feature", `volumes.${name} must be empty or a mapping`);
      continue;
    }
    for (const key of Object.keys(def)) {
      if (!ALLOWED_VOLUME_DEF_KEYS.has(key)) {
        deny(
          violations,
          "external-network-or-volume",
          `volumes.${name}.${key} is denied (only Docker-managed, project-scoped volumes are allowed)`,
        );
      }
    }
    if ("driver_opts" in def) {
      deny(
        violations,
        "external-network-or-volume",
        `volumes.${name}.driver_opts is denied (can disguise a host bind mount as a named volume)`,
      );
    }
  }
  return declared;
}

function checkOneNetworkDef(
  name: string,
  def: PlainObject,
  violations: ComposePolicyViolation[],
): void {
  for (const key of Object.keys(def)) {
    if (!ALLOWED_NETWORK_KEYS.has(key)) {
      deny(
        violations,
        "unknown-compose-feature",
        `networks.${name}.${key} is not in the reviewed allowlist`,
      );
    }
  }
  const driver = def.driver;
  if (driver !== undefined && driver !== "bridge") {
    deny(
      violations,
      "host-namespace",
      `networks.${name}.driver ${JSON.stringify(driver)} is denied (only the default bridge driver is allowed)`,
    );
  }
  if (def.external) {
    deny(
      violations,
      "external-network-or-volume",
      `networks.${name}.external is denied (only broker/project-owned networks are allowed)`,
    );
  }
}

function checkNetworks(doc: PlainObject, violations: ComposePolicyViolation[]): void {
  const networks = doc.networks;
  if (!isPlainObject(networks)) return;
  for (const [name, def] of Object.entries(networks)) {
    if (def === null || def === undefined) continue;
    if (!isPlainObject(def)) {
      deny(violations, "unknown-compose-feature", `networks.${name} must be empty or a mapping`);
      continue;
    }
    checkOneNetworkDef(name, def, violations);
  }
}

/** `<source>:<target>[:<options>]`, splitting only on colons outside `${...}` interpolation. */
function splitVolumeSpec(
  spec: string,
): { readonly source: string; readonly rest: string } | undefined {
  let depth = 0;
  for (let i = 0; i < spec.length; i += 1) {
    const ch = spec[i];
    if (ch === "{" && spec[i - 1] === "$") depth += 1;
    else if (ch === "}" && depth > 0) depth -= 1;
    else if (ch === ":" && depth === 0) {
      return { source: spec.slice(0, i), rest: spec.slice(i + 1) };
    }
  }
  return undefined;
}

function checkServiceVolumes(
  serviceName: string,
  volumes: unknown,
  namedVolumes: ReadonlySet<string>,
  context: ComposePolicyContext,
  fs: ContainmentFs,
  violations: ComposePolicyViolation[],
): void {
  if (!Array.isArray(volumes)) return;
  const composeDir = dirname(context.composePath);
  for (const entry of volumes) {
    if (typeof entry !== "string") {
      deny(
        violations,
        "unknown-compose-feature",
        `services.${serviceName}.volumes has a non-string entry (long-form volume entries are not in the reviewed allowlist)`,
      );
      continue;
    }
    const split = splitVolumeSpec(entry);
    if (!split) {
      deny(
        violations,
        "unknown-compose-feature",
        `services.${serviceName}.volumes entry "${entry}" is not a "<source>:<target>" bind mount or named volume`,
      );
      continue;
    }
    const { value: source, unresolved } = resolveStaticDefaults(split.source);
    if (unresolved) {
      deny(
        violations,
        "host-bind-mount",
        `services.${serviceName}.volumes source "${split.source}" depends on an environment variable with no static default`,
      );
      continue;
    }
    if (namedVolumes.has(source)) continue; // Docker-managed named volume, not a host path.
    if (isAbsolute(source)) {
      deny(
        violations,
        "docker-socket-bind",
        `services.${serviceName}.volumes source "${source}" is an absolute host path (denied — includes the Docker/container-runtime socket)`,
      );
      continue;
    }
    tryRule(violations, "host-bind-mount", () => {
      resolveContainedPath(
        `services.${serviceName}.volumes source`,
        source,
        composeDir,
        [context.problemDir],
        fs,
      );
    });
  }
}

function checkBuild(
  serviceName: string,
  build: unknown,
  context: ComposePolicyContext,
  fs: ContainmentFs,
  violations: ComposePolicyViolation[],
): void {
  if (build === undefined) return;
  if (!isPlainObject(build) && typeof build !== "string") {
    deny(
      violations,
      "unknown-compose-feature",
      `services.${serviceName}.build must be a string or mapping`,
    );
    return;
  }
  const composeDir = dirname(context.composePath);
  const runtimesRoot = catalogRuntimesRoot(context.problemDir);
  const asObject: PlainObject = typeof build === "string" ? { context: build } : build;
  for (const key of Object.keys(asObject)) {
    if (!ALLOWED_BUILD_KEYS.has(key)) {
      deny(
        violations,
        "unknown-compose-feature",
        `services.${serviceName}.build.${key} is not in the reviewed allowlist`,
      );
    }
  }
  const rawContext = asObject.context;
  if (typeof rawContext !== "string") {
    deny(
      violations,
      "build-context-escape",
      `services.${serviceName}.build.context must be a string`,
    );
    return;
  }
  const { value: resolvedContext, unresolved } = resolveStaticDefaults(rawContext);
  if (unresolved) {
    deny(
      violations,
      "build-context-escape",
      `services.${serviceName}.build.context "${rawContext}" depends on an environment variable with no static default`,
    );
    return;
  }
  let contextDir: string | undefined;
  tryRule(violations, "build-context-escape", () => {
    contextDir = resolveContainedPath(
      `services.${serviceName}.build.context`,
      resolvedContext,
      composeDir,
      [context.problemDir, runtimesRoot],
      fs,
    );
  });
  if (contextDir === undefined) return;
  const rawDockerfile = asObject.dockerfile;
  if (rawDockerfile === undefined) return;
  if (typeof rawDockerfile !== "string") {
    deny(
      violations,
      "build-context-escape",
      `services.${serviceName}.build.dockerfile must be a string`,
    );
    return;
  }
  tryRule(violations, "build-context-escape", () => {
    resolveContainedPath(
      `services.${serviceName}.build.dockerfile`,
      rawDockerfile,
      contextDir as string,
      [contextDir as string],
      fs,
    );
  });
}

function checkPorts(
  serviceName: string,
  ports: unknown,
  violations: ComposePolicyViolation[],
): void {
  if (!Array.isArray(ports)) return;
  for (const entry of ports) {
    if (typeof entry !== "string") {
      deny(
        violations,
        "wildcard-publish",
        `services.${serviceName}.ports has a non-string entry (only the "127.0.0.1:<host>:<container>" form is allowed)`,
      );
      continue;
    }
    const { value, unresolved } = resolveStaticDefaults(entry);
    if (unresolved || !LOOPBACK_PORT_RE.test(value)) {
      deny(
        violations,
        "wildcard-publish",
        `services.${serviceName}.ports entry "${entry}" must publish TCP to 127.0.0.1 or localhost only`,
      );
    }
  }
}

function checkSecurityOpt(
  serviceName: string,
  securityOpt: unknown,
  context: ComposePolicyContext,
  fs: ContainmentFs,
  violations: ComposePolicyViolation[],
): void {
  if (!Array.isArray(securityOpt)) return;
  const composeDir = dirname(context.composePath);
  for (const entry of securityOpt) {
    if (typeof entry !== "string") continue;
    if (UNCONFINED_RE.test(entry)) {
      deny(
        violations,
        "unconfined-security-profile",
        `services.${serviceName}.security_opt "${entry}" disables a confinement profile`,
      );
      continue;
    }
    if (NO_NEW_PRIVILEGES_FALSE_RE.test(entry)) {
      deny(
        violations,
        "unconfined-security-profile",
        `services.${serviceName}.security_opt "${entry}" re-enables privilege escalation`,
      );
      continue;
    }
    const seccompMatch = /^seccomp=(.+)$/.exec(entry);
    if (seccompMatch) {
      const profile = seccompMatch[1] as string;
      if (profile !== "default") {
        tryRule(violations, "unconfined-security-profile", () => {
          resolveContainedPath(
            `services.${serviceName}.security_opt seccomp profile`,
            profile,
            composeDir,
            [context.problemDir],
            fs,
          );
        });
      }
    }
  }
}

/** One disallowed service-level key: a named rule for the items Issue #3097 calls out by name,
 * a generic `unknown-compose-feature` denial for everything else omitted from the allowlist. */
function checkServiceKey(
  serviceName: string,
  key: string,
  violations: ComposePolicyViolation[],
): void {
  const named = NAMED_DANGEROUS_SERVICE_KEYS[key];
  if (named) {
    deny(violations, named.rule, `services.${serviceName}.${key}: ${named.message}`);
    return;
  }
  deny(
    violations,
    "unknown-compose-feature",
    `services.${serviceName}.${key} is not in the reviewed allowlist`,
  );
}

function checkService(
  name: string,
  service: unknown,
  namedVolumes: ReadonlySet<string>,
  context: ComposePolicyContext,
  fs: ContainmentFs,
  violations: ComposePolicyViolation[],
): void {
  if (!isPlainObject(service)) return;
  for (const key of Object.keys(service)) {
    if (!ALLOWED_SERVICE_KEYS.has(key)) checkServiceKey(name, key, violations);
  }
  checkBuild(name, service.build, context, fs, violations);
  checkServiceVolumes(name, service.volumes, namedVolumes, context, fs, violations);
  checkPorts(name, service.ports, violations);
  checkSecurityOpt(name, service.security_opt, context, fs, violations);
}

/**
 * Structurally validate raw catalog Compose YAML text against the Phase A deny-by-default
 * policy. Returns every violation found (not just the first) so a single failed start reports
 * everything wrong at once. Parsing the YAML itself is not defended against here — a genuinely
 * unparseable file fails `docker compose up` on its own regardless of this policy.
 */
export function checkComposePolicy(
  composeText: string,
  context: ComposePolicyContext,
  fs: ContainmentFs = NODE_CONTAINMENT_FS,
): ComposePolicyViolation[] {
  let doc: unknown;
  try {
    doc = safeLoad(composeText);
  } catch (error) {
    throw new Error(`failed to parse compose file: ${context.composePath}`, { cause: error });
  }
  const violations: ComposePolicyViolation[] = [];
  if (!isPlainObject(doc)) return violations;
  checkTopLevel(doc, violations);
  const namedVolumes = checkNamedVolumes(doc, violations);
  checkNetworks(doc, violations);
  const services = doc.services;
  if (isPlainObject(services)) {
    for (const [name, service] of Object.entries(services)) {
      checkService(name, service, namedVolumes, context, fs, violations);
    }
  }
  return violations;
}

/** {@link checkComposePolicy}, throwing {@link ComposePolicyError} fail-closed on any violation. */
export function assertComposePolicy(
  composeText: string,
  context: ComposePolicyContext,
  fs: ContainmentFs = NODE_CONTAINMENT_FS,
): void {
  const violations = checkComposePolicy(composeText, context, fs);
  if (violations.length > 0) throw new ComposePolicyError(violations, context.composePath);
}
