import type { SSMClient } from "@aws-sdk/client-ssm";
import type { Client } from "@libsql/client/http";
import type { RuntimeEnvironment } from "../../../lib/problem-deploy/control-data/backend-config";
import {
  type ControlDataRuntime,
  createControlDataRuntime,
} from "../../../lib/problem-deploy/control-data/runtime-repositories";

/**
 * [#2527 Slice 4] Explicit test runtime for handler suites.
 *
 * The default (empty env) selects the `dynamodb` backend, so every resolver
 * wraps whatever fake `ddb` the test passes through the shared resources —
 * byte-identical to the pre-DI behavior where the module-global singleton read
 * an unset `CONTROL_DATA_BACKEND`, minus the hidden dependency on the test
 * process's real environment. Pass an env override (e.g.
 * `{ CONTROL_DATA_BACKEND: "turso" }`) to exercise non-default backends; the
 * SSM / libSQL stubs fail loudly if a test reaches them unintentionally.
 */
export function makeTestControlDataRuntime(
  env: RuntimeEnvironment = {},
  overrides: {
    ssm?: Pick<SSMClient, "send">;
    createClient?: (config: { readonly url: string; readonly authToken: string }) => Client;
  } = {},
): ControlDataRuntime {
  return createControlDataRuntime({
    env,
    ssm:
      overrides.ssm ??
      ({
        send: () => Promise.reject(new Error("SSM is not available in unit tests")),
      } as unknown as Pick<SSMClient, "send">),
    createClient:
      overrides.createClient ??
      (() => {
        throw new Error("libSQL client is not available in unit tests");
      }),
  });
}
