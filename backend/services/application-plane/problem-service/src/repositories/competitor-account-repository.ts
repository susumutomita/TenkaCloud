/**
 * CompetitorAccount Repository (DynamoDB)
 *
 * GameDay の各チーム AWS アカウント情報の永続化
 *
 * DynamoDB キー設計:
 *   PK = EVENT#{eventId}
 *   SK = COMPETITOR_ACCOUNT#{accountId}
 */

import {
	PutCommand,
	GetCommand,
	QueryCommand,
	DeleteCommand,
	UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { ulid } from "ulid";
import { getDocClient, getTableName } from "@tenkacloud/dynamodb";
import type { CompetitorAccount } from "../types";

const ENTITY_TYPE = "COMPETITOR_ACCOUNT" as const;

interface CompetitorAccountItem {
	PK: string;
	SK: string;
	EntityType: typeof ENTITY_TYPE;
	CreatedAt: string;
	UpdatedAt: string;
	id: string;
	eventId: string;
	name: string;
	provider: string;
	accountId: string;
	region: string;
	roleArn?: string;
	externalId?: string;
	status: string;
}

const buildPK = (eventId: string) => `EVENT#${eventId}`;
const buildSK = (accountId: string) => `COMPETITOR_ACCOUNT#${accountId}`;

function toDomain(item: CompetitorAccountItem): CompetitorAccount & {
	eventId: string;
	roleArn?: string;
} {
	return {
		id: item.id,
		eventId: item.eventId,
		name: item.name,
		provider: item.provider as CompetitorAccount["provider"],
		accountId: item.accountId,
		region: item.region,
		roleArn: item.roleArn,
		externalId: item.externalId,
		status: item.status as CompetitorAccount["status"],
	};
}

export type CompetitorAccountWithMeta = CompetitorAccount & {
	eventId: string;
	roleArn?: string;
};

export interface CreateCompetitorAccountInput {
	eventId: string;
	name: string;
	provider: string;
	accountId: string;
	region: string;
	roleArn?: string;
	externalId?: string;
}

export class CompetitorAccountRepository {
	async create(
		input: CreateCompetitorAccountInput,
	): Promise<CompetitorAccountWithMeta> {
		const client = getDocClient();
		const tableName = getTableName();
		const now = new Date().toISOString();
		const id = ulid();

		const item: CompetitorAccountItem = {
			PK: buildPK(input.eventId),
			SK: buildSK(id),
			EntityType: ENTITY_TYPE,
			CreatedAt: now,
			UpdatedAt: now,
			id,
			eventId: input.eventId,
			name: input.name,
			provider: input.provider,
			accountId: input.accountId,
			region: input.region,
			roleArn: input.roleArn,
			externalId: input.externalId,
			status: "pending",
		};

		await client.send(
			new PutCommand({
				TableName: tableName,
				Item: item,
				ConditionExpression: "attribute_not_exists(PK)",
			}),
		);

		return toDomain(item);
	}

	async findById(
		eventId: string,
		id: string,
	): Promise<CompetitorAccountWithMeta | null> {
		const client = getDocClient();
		const tableName = getTableName();

		const result = await client.send(
			new GetCommand({
				TableName: tableName,
				Key: {
					PK: buildPK(eventId),
					SK: buildSK(id),
				},
			}),
		);

		if (!result.Item) return null;
		return toDomain(result.Item as CompetitorAccountItem);
	}

	async findByEventId(
		eventId: string,
	): Promise<CompetitorAccountWithMeta[]> {
		const client = getDocClient();
		const tableName = getTableName();

		const result = await client.send(
			new QueryCommand({
				TableName: tableName,
				KeyConditionExpression:
					"PK = :pk AND begins_with(SK, :skPrefix)",
				ExpressionAttributeValues: {
					":pk": buildPK(eventId),
					":skPrefix": "COMPETITOR_ACCOUNT#",
				},
			}),
		);

		return (result.Items ?? []).map((item) =>
			toDomain(item as CompetitorAccountItem),
		);
	}

	async updateStatus(
		eventId: string,
		id: string,
		status: CompetitorAccount["status"],
	): Promise<void> {
		const client = getDocClient();
		const tableName = getTableName();
		const now = new Date().toISOString();

		await client.send(
			new UpdateCommand({
				TableName: tableName,
				Key: {
					PK: buildPK(eventId),
					SK: buildSK(id),
				},
				UpdateExpression: "SET #status = :status, UpdatedAt = :updatedAt",
				ExpressionAttributeNames: { "#status": "status" },
				ExpressionAttributeValues: {
					":status": status,
					":updatedAt": now,
				},
				ConditionExpression: "attribute_exists(PK)",
			}),
		);
	}

	async delete(eventId: string, id: string): Promise<void> {
		const client = getDocClient();
		const tableName = getTableName();

		await client.send(
			new DeleteCommand({
				TableName: tableName,
				Key: {
					PK: buildPK(eventId),
					SK: buildSK(id),
				},
			}),
		);
	}
}
