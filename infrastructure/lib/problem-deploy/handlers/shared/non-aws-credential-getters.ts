import { getAzureCredential } from "./azure-credential-store.js";
import { getGcpCredential } from "./gcp-credential-store.js";
import type { ReservedProvider } from "./runtime/index.js";
import { getSakuraCredential } from "./sakura-credential-store.js";
import type { SecureJsonStoreDeps } from "./secure-json-store.js";

/**
 * [Issue #2571 review-fix] non-AWS single-provider (gcp/azure/sakura) の per-team credential
 * getter を provider キーで引く共有 map。
 *
 * かつては `deploy-handler/composite-target-connection.ts` (Composite Runtime 専用) と
 * `event-handler/bulk-deploy/verified-accounts.ts` (bulk-deploy 専用) がそれぞれ独立に
 * 「provider → getter」の dispatch (map / if-chain) を持っていた — 2 箇所が別々に provider を
 * 追加すると、どちらかが更新漏れで drift しうる。ここに 1 度だけ定義し、両 caller が import する
 * (= single source of truth、#2562 の `RESERVED_RUNTIMES` 集約と同じ狙い)。
 */
export const NON_AWS_CONFIG_GETTERS: Record<
  ReservedProvider,
  (deps: SecureJsonStoreDeps, tenantId: string, teamSlug: string) => Promise<unknown>
> = {
  gcp: getGcpCredential,
  azure: getAzureCredential,
  sakura: getSakuraCredential,
};
