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

export type AppEnvironment = {
  Bindings: Env;
  Variables: {
    jwtPayload: unknown;
    organizer: OrganizerContext;
    team: TeamContext;
  };
};
