export interface OrganizerContext {
  readonly subject: string;
  readonly organizationId: string;
  readonly tenantId: string;
  readonly roles: readonly string[];
}

export interface TeamContext {
  readonly teamId: string;
  readonly eventId: string;
  readonly displayName: string;
}

/**
 * Secrets are injected with `wrangler secret put`, so the generated `Env` from
 * `wrangler types` cannot include them; they are declared here and optional
 * because a misconfigured deployment must fail loudly at use.
 */
export interface SecretBindings {
  /**
   * ES256 key pair backing the OIDC IdP surface and the command-token mint
   * for AWS commands; only the public half is served from the JWKS route.
   */
  readonly OIDC_SIGNING_PRIVATE_JWK?: string;
  /**
   * System-admin bearer for the tenant-onboarding endpoint (`/v1/system/*`). A Workers
   * secret; optional here because a misconfigured deployment must fail loudly at use.
   */
  readonly SYSTEM_ADMIN_TOKEN?: string;
  /** Bearer for the AWS event-runtime score feed (`/v1/runtime/*`). A Workers secret. */
  readonly RUNTIME_FEED_TOKEN?: string;
}

export type AppEnvironment = {
  Bindings: Env & SecretBindings;
  Variables: {
    jwtPayload: unknown;
    organizer: OrganizerContext;
    team: TeamContext;
  };
};
