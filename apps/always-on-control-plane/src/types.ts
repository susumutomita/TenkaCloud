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
 * `INTENT_SIGNING_SECRET` is a Workers secret (injected with `wrangler secret put`),
 * so the generated `Env` from `wrangler types` cannot include it; it is declared
 * here and optional because a misconfigured deployment must fail loudly at use.
 */
export interface SecretBindings {
  readonly INTENT_SIGNING_SECRET?: string;
}

export type AppEnvironment = {
  Bindings: Env & SecretBindings;
  Variables: {
    jwtPayload: unknown;
    organizer: OrganizerContext;
    team: TeamContext;
  };
};
