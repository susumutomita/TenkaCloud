/**
 * [Problem Packs / Issue #2459] SaaS-mode synth guard: fail loud when pack activations exist.
 *
 * `bin/tenkacloud-lite.ts` builds a `catalogSource` from the {@link ActivationStore} so an
 * activated pack reaches the Lite synth. `bin/infrastructure.ts` (SaaS mode) does NOT — it calls
 * `resolveAppConfig` with no `catalogSource` at all, so any activation on disk is silently
 * ignored by a `make deploy-saas` run. That is a silent fallback, which this repo forbids ("if it
 * fails, fail loudly").
 *
 * Packs stay Lite-only by design (#2459): the pooled Application Plane shares ONE Lambda
 * environment across every tenant, so there is no per-tenant slot for the synth-time
 * esbuild-define mechanism a per-tenant effective catalog would need. Until that seam exists, the
 * only correct behavior for a SaaS synth that finds activations is to refuse, not to proceed
 * quietly.
 *
 * This module owns exactly that refusal. It resolves the SAME pack store path
 * `bin/tenkacloud-lite.ts` resolves (`<binDir>/../../.tenkacloud/pack-store`), so a Lite-mode
 * install/activate and this guard always agree on where the store lives — including inside the
 * SaaS CodeBuild source bundle (`scripts/package-source-bundle.sh` copies `.tenkacloud/pack-store`
 * into `source.zip`, and the bundle's `binDir/../..` resolves to the same relative root as the
 * repo checkout).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { ActivationStore } from "./pack-activation.js";

/**
 * Refuse a SaaS synth that would silently drop existing pack activations.
 *
 * No `.tenkacloud/pack-store` directory → dormant, returns (byte-identical to today: no packs
 * were ever installed, so there is nothing to silently ignore). A store with zero activations
 * also returns — an installed-but-inactive pack contributes nothing to any tenant's catalog
 * either way, so there is nothing to lose. One or more activations throws, UNLESS the operator
 * set the explicit escape hatch `CDK_PARAM_SAAS_IGNORE_PACKS=true`, in which case this logs a
 * loud warning instead so `make destroy-saas` and an intentional SaaS deploy stay unblocked.
 */
export function assertSaasSynthHasNoActivePacks(binDir: string, env: NodeJS.ProcessEnv): void {
  const packStoreDir = path.resolve(binDir, "..", "..", ".tenkacloud", "pack-store");
  if (!fs.existsSync(packStoreDir)) return;

  const activations = new ActivationStore(packStoreDir).list();
  if (activations.length === 0) return;

  if (env.CDK_PARAM_SAAS_IGNORE_PACKS === "true") {
    console.warn(
      `[SaaSPackGuard] CDK_PARAM_SAAS_IGNORE_PACKS=true: proceeding with SaaS synth even though ` +
        `${activations.length} pack activation(s) will NOT appear in any SaaS tenant's catalog.`,
    );
    return;
  }

  const listing = activations
    .map((a) => `  - ${a.packId}@${a.version} (tenant: ${a.tenantId})`)
    .join("\n");
  throw new Error(
    `[SaaSPackGuard] Refusing to synth SaaS mode: ${activations.length} problem pack ` +
      `activation(s) exist and would be silently ignored:\n${listing}\n\n` +
      "Problem packs are Lite-only by design (#2459): the pooled Application Plane shares ONE " +
      "Lambda environment across all tenants, so a per-tenant effective catalog cannot ride the " +
      "synth-time esbuild-define mechanism. Proceeding would silently drop the activations " +
      "listed above from every SaaS tenant's catalog.\n\n" +
      "Remediation — pick one:\n" +
      '  1. Deactivate each pack: make pack-deactivate ARGS="<packId>@<version> --tenant <tenantId>"\n' +
      "  2. Deploy Lite mode instead, which does support packs: make deploy\n" +
      "  3. Proceed anyway: set CDK_PARAM_SAAS_IGNORE_PACKS=true",
  );
}
