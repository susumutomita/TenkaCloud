/** Curated local-host contract. service.ts remains the routing/validation authority. */
const string = { type: "string" };
const object = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  properties,
  required,
});
const array = (items: unknown) => ({ type: "array", items });
const eventId = { name: "eventId", in: "path", required: true, schema: string };
const error = { description: "Request rejected; JSON error, kind and message." };
function operation(
  id: string,
  summary: string,
  status = 200,
  schema?: unknown,
  parameters: unknown[] = [],
) {
  return {
    operationId: id,
    summary,
    parameters,
    ...(schema
      ? { requestBody: { required: true, content: { "application/json": { schema } } } }
      : {}),
    responses: {
      [status]: {
        description: "Successful operation; response fields depend on runtime and event state.",
        content: { "application/json": { schema: { type: "object" } } },
      },
      400: error,
      401: error,
      403: error,
      404: error,
      409: error,
      422: error,
    },
  };
}
export function localOpenApi(role: "admin" | "participant") {
  const paths: Record<
    string,
    Record<string, ReturnType<typeof operation> & { description?: string; security?: unknown[] }>
  > = role === "admin"
    ? {
        "/host/login": {
          post: {
            ...operation(
              "loginHost",
              "Exchange local organizer key for an eight-hour session",
              200,
              object({ key: { ...string, format: "password", writeOnly: true } }, ["key"]),
            ),
            security: [],
            description:
              "Local key mode only. Copy idToken to Authorize. Do not use a team key here. Credentials stay in this page's memory; refresh clears authorization.",
          },
        },
        "/host/catalog": { get: operation("hostCatalog", "List supported problems") },
        "/events": {
          get: operation("listEvents", "List events"),
          post: {
            ...operation(
              "createEvent",
              "Create event and issue team keys",
              201,
              object(
                {
                  name: string,
                  teams: {
                    ...array(
                      object(
                        {
                          internalSlug: {
                            type: "string",
                            maxLength: 40,
                            pattern: "^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$",
                          },
                        },
                        ["internalSlug"],
                      ),
                    ),
                    minItems: 1,
                    maxItems: 40,
                  },
                  problems: {
                    ...array(object({ problemId: string }, ["problemId"])),
                    minItems: 1,
                  },
                },
                ["name", "teams", "problems"],
              ),
            ),
            description:
              "Select problemId from host/catalog. This minimal reference describes local problems only; AWS account configuration is outside its scope. Response includes eventId and teams[].teamLoginKey. Keep those keys private.",
          },
        },
        "/events/{eventId}": {
          get: {
            ...operation("eventStatus", "Read event state, jobs and results", 200, undefined, [
              eventId,
              {
                name: "withTeamLoginKeys",
                in: "query",
                schema: { type: "boolean", default: false },
              },
            ]),
            description:
              "Poll deploymentsByProblem for job status/operation/error and teams for results. Identifiers are not capabilities; authorization and event ownership still apply. Team keys require reveal-team-keys permission.",
          },
        },
        "/events/{eventId}/deploy": {
          post: {
            ...operation(
              "prepareEvent",
              "Accept environment preparation",
              202,
              {
                ...object({ retryFailedOnly: { type: "boolean", enum: [true] } }),
                additionalProperties: false,
              },
              [eventId],
            ),
            description:
              "Asynchronous acceptance, not completion. Poll GET /events/{eventId} until READY or inspect failed jobs. While DEPLOYING, repeated preparation reuses existing jobs. A READY event rejects preparation; use retryFailedOnly for failed jobs before readiness. No new deployment engine is introduced.",
          },
        },
        "/events/{eventId}/schedule": {
          patch: {
            ...operation(
              "startEvent",
              "Start or schedule a prepared event",
              200,
              {
                additionalProperties: false,
                ...object({
                  startNow: { type: "boolean", enum: [true] },
                  startsAt: { type: "string", format: "date-time" },
                  endsAt: { type: "string", format: "date-time" },
                  scoreboardFreezeMinutes: { type: "integer", minimum: 0, maximum: 180 },
                }),
              },
              [eventId],
            ),
            description:
              "Requires READY. Use startNow:true or startsAt, never both. endsAt must follow startsAt. Participation is controlled by this schedule.",
          },
        },
        "/events/{eventId}/end": {
          post: operation("endEvent", "End competition and settle scoring", 200, undefined, [
            eventId,
          ]),
        },
      }
    : {
        "/portal/me": {
          get: {
            ...operation("joinEvent", "Authenticate team and read competition state"),
            description:
              "Authorize with the team's teamLoginKey. There is no separate participant login or join mutation. Host session tokens are not team credentials.",
          },
        },
        "/portal/me/score-events": {
          get: operation("teamResults", "Read this team's score events"),
        },
        "/portal/me/submit-flag": {
          post: {
            ...operation(
              "submitFlag",
              "Submit a flag for this authenticated team",
              200,
              object(
                { problemId: string, flag: { ...string, format: "password", writeOnly: true } },
                ["problemId", "flag"],
              ),
              [
                {
                  name: "Idempotency-Key",
                  in: "header",
                  schema: { type: "string", pattern: "^[A-Za-z0-9_-]{8,128}$" },
                },
              ],
            ),
            description:
              "Team/event identity comes from the bearer credential. Do not include teamId or eventId. Reuse the same Idempotency-Key only for the identical submission; a changed body conflicts. Event schedule and scoring gates apply.",
          },
        },
      };
  return {
    openapi: "3.0.3",
    info: {
      title: `TenkaCloud local ${role} API`,
      version: "1.0.0",
      description:
        "Minimal local event lifecycle reference, not all API routes. Served by make local on this listener only. Cloud Cognito/CORS/API URL configuration is separate and Cloud Try It is not supported here.",
    },
    servers: [{ url: "/api", description: "This listener only" }],
    security: [{ [role === "admin" ? "hostSession" : "teamKey"]: [] }],
    components: {
      securitySchemes: {
        [role === "admin" ? "hostSession" : "teamKey"]: {
          type: "http",
          scheme: "bearer",
          description:
            role === "admin"
              ? "idToken from local host/login; expires after eight hours"
              : "Team login key issued by the host",
        },
      },
    },
    paths,
  };
}
