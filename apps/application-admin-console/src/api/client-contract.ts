import type { CoreApiClient } from "@tenkacloud/web-kit";
import type { IdTokenClaims, TenantConsoleAccess } from "../auth/claims";

export interface ApiClient extends CoreApiClient {
  readonly tenantAccess?: TenantConsoleAccess;
  readonly organizerRole?: IdTokenClaims["custom:organizerRole"];
}
