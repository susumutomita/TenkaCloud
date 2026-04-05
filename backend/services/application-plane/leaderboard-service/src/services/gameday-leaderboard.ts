import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import { getDocClient, getTableName } from "@tenkacloud/dynamodb";

export interface GameDayLeaderboardEntry {
	rank: number;
	teamId: string;
	teamName: string;
	score: number;
}

export interface GameDayLeaderboardResult {
	eventId: string;
	entries: GameDayLeaderboardEntry[];
}

interface TeamStateItem {
	PK: string;
	SK: string;
	EntityType: string;
	eventId: string;
	teamId: string;
	teamName: string;
	score: number;
}

export interface GameDayLeaderboardRepository {
	listTeams(eventId: string): Promise<TeamStateItem[]>;
}

export class DynamoDBGameDayLeaderboardRepository
	implements GameDayLeaderboardRepository
{
	async listTeams(eventId: string): Promise<TeamStateItem[]> {
		const client = getDocClient();
		const tableName = getTableName();
		const allItems: TeamStateItem[] = [];
		let exclusiveStartKey: Record<string, unknown> | undefined;

		do {
			const result = await client.send(
				new QueryCommand({
					TableName: tableName,
					KeyConditionExpression: "PK = :pk AND begins_with(SK, :skPrefix)",
					ExpressionAttributeValues: {
						":pk": `GAMEDAY#${eventId}`,
						":skPrefix": "TEAM#",
					},
					ExclusiveStartKey: exclusiveStartKey,
				}),
			);

			for (const item of result.Items ?? []) {
				const sk = item.SK as string;
				if (sk.startsWith("TEAM#") && !sk.includes("#", 5)) {
					allItems.push(item as TeamStateItem);
				}
			}

			exclusiveStartKey = result.LastEvaluatedKey as
				| Record<string, unknown>
				| undefined;
		} while (exclusiveStartKey);

		return allItems;
	}
}

export function buildGameDayLeaderboard(
	teams: TeamStateItem[],
): GameDayLeaderboardEntry[] {
	const sorted = [...teams].sort((a, b) => b.score - a.score);

	return sorted.map((t, index) => ({
		rank: index + 1,
		teamId: t.teamId,
		teamName: t.teamName,
		score: t.score,
	}));
}

export async function getGameDayLeaderboard(
	eventId: string,
	repository: GameDayLeaderboardRepository,
): Promise<GameDayLeaderboardResult> {
	const teams = await repository.listTeams(eventId);
	const entries = buildGameDayLeaderboard(teams);

	return {
		eventId,
		entries,
	};
}
