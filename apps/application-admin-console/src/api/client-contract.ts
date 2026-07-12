import type { CoreApiClient } from "@tenkacloud/web-kit";
import type { TenantConsoleAccess } from "../auth/claims";

export interface ApiClient extends CoreApiClient {
  readonly tenantAccess?: TenantConsoleAccess;
}
