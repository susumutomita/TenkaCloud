import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { getEnv } from "../helper-functions.js";
import { defaultS3PluginImporter } from "./handlers/coordination-dispatcher-handler/s3-plugin-importer.js";
import { tickCoordinationState } from "./handlers/generic-scoring-handler/coordination-tick.js";
import { parseCoordinationConfig } from "./handlers/participant-handler/coordination-handler.js";
import { forEachScanPage } from "./handlers/shared/ddb-paginate.js";

interface CoordinationDeployment {
  readonly tenantId?: string;
  readonly eventId?: string;
  readonly problemId?: string;
}

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

/** Runs every configured event once, using the same optimistic coordination row as participant ops. */
export async function runCoordinationTick(nowMs = Date.now()): Promise<void> {
  const deploymentsTable = getEnv("DEPLOYMENTS_TABLE_NAME");
  const teamsTable = getEnv("TEAMS_TABLE_NAME");
  const bucket = getEnv("COORDINATION_PLUGIN_BUCKET");
  const config = parseCoordinationConfig(process.env.PROBLEM_COORDINATION);
  const importer = defaultS3PluginImporter(bucket);
  const claimedEvents = new Set<string>();
  const nowIso = new Date(nowMs).toISOString();

  await forEachScanPage(
    ddb,
    {
      TableName: deploymentsTable,
      FilterExpression: "#status = :complete",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: { ":complete": "COMPLETE" },
      ProjectionExpression: "tenantId, eventId, problemId",
      Limit: 200,
    },
    async (page) => {
      await Promise.all(
        (page as CoordinationDeployment[]).map((deployment) =>
          tickDeployment(deployment, {
            deploymentsTable,
            teamsTable,
            config,
            importer,
            claimedEvents,
            nowMs,
            nowIso,
          }),
        ),
      );
    },
  );
}

interface TickRuntime {
  readonly deploymentsTable: string;
  readonly teamsTable: string;
  readonly config: ReturnType<typeof parseCoordinationConfig>;
  readonly importer: ReturnType<typeof defaultS3PluginImporter>;
  readonly claimedEvents: Set<string>;
  readonly nowMs: number;
  readonly nowIso: string;
}

async function tickDeployment(
  { tenantId, eventId, problemId }: CoordinationDeployment,
  runtime: TickRuntime,
): Promise<void> {
  if (!tenantId || !eventId || !problemId || !runtime.config[problemId]) return;
  const scopeKey = `${tenantId}#${eventId}`;
  if (runtime.claimedEvents.has(scopeKey)) return;
  runtime.claimedEvents.add(scopeKey);

  try {
    const teamIds = await listTeamIds(runtime.teamsTable, eventId);
    if (teamIds.length === 0) return;
    await tickCoordinationState(
      runtime.importer,
      { ddb, tableName: runtime.deploymentsTable },
      {
        tenantId,
        eventId,
        moduleRef: problemId,
        ctx: { eventId, teamIds },
        eventNowMs: runtime.nowMs,
        nowIso: runtime.nowIso,
      },
    );
  } catch (error) {
    console.warn(`[coordination-tick] eventId=${eventId} failed`, {
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

async function listTeamIds(tableName: string, eventId: string): Promise<readonly string[]> {
  const out = await ddb.send(
    new QueryCommand({
      TableName: tableName,
      KeyConditionExpression: "PK = :pk AND begins_with(SK, :team)",
      ExpressionAttributeValues: { ":pk": `EVENT#${eventId}`, ":team": "TEAM#" },
      ProjectionExpression: "teamId",
    }),
  );
  return (out.Items ?? [])
    .map((row) => row.teamId)
    .filter((teamId): teamId is string => typeof teamId === "string" && teamId.length > 0);
}
