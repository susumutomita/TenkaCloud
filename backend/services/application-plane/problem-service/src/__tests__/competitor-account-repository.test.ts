/**
 * CompetitorAccountRepository Tests
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

const mockSend = vi.fn();
vi.mock("@tenkacloud/dynamodb", () => ({
	getDocClient: () => ({ send: mockSend }),
	getTableName: () => "TestTable",
}));

// ulid をモック
vi.mock("ulid", () => ({
	ulid: () => "test-ulid-001",
}));

import { CompetitorAccountRepository } from "../repositories/competitor-account-repository";

describe("CompetitorAccountRepository", () => {
	let repo: CompetitorAccountRepository;

	beforeEach(() => {
		vi.clearAllMocks();
		repo = new CompetitorAccountRepository();
	});

	describe("create", () => {
		it("競技アカウントを作成できるべき", async () => {
			mockSend.mockResolvedValueOnce({});

			const result = await repo.create({
				eventId: "event-1",
				name: "team01",
				provider: "aws",
				accountId: "123456789012",
				region: "ap-northeast-1",
				roleArn: "arn:aws:iam::123456789012:role/DeployRole",
			});

			expect(result.id).toBe("test-ulid-001");
			expect(result.eventId).toBe("event-1");
			expect(result.name).toBe("team01");
			expect(result.accountId).toBe("123456789012");
			expect(result.status).toBe("pending");
			expect(mockSend).toHaveBeenCalledTimes(1);
		});

		it("roleArn なしで作成できるべき", async () => {
			mockSend.mockResolvedValueOnce({});

			const result = await repo.create({
				eventId: "event-1",
				name: "team02",
				provider: "aws",
				accountId: "987654321098",
				region: "us-east-1",
			});

			expect(result.roleArn).toBeUndefined();
		});
	});

	describe("findById", () => {
		it("存在するアカウントを取得できるべき", async () => {
			const mockItem = {
				PK: "EVENT#event-1",
				SK: "COMPETITOR_ACCOUNT#test-ulid-001",
				EntityType: "COMPETITOR_ACCOUNT",
				CreatedAt: new Date().toISOString(),
				UpdatedAt: new Date().toISOString(),
				id: "test-ulid-001",
				eventId: "event-1",
				name: "team01",
				provider: "aws",
				accountId: "123456789012",
				region: "ap-northeast-1",
				status: "ready",
			};
			mockSend.mockResolvedValueOnce({ Item: mockItem });

			const result = await repo.findById("event-1", "test-ulid-001");

			expect(result).not.toBeNull();
			expect(result?.id).toBe("test-ulid-001");
			expect(result?.name).toBe("team01");
		});

		it("存在しないアカウントは null を返すべき", async () => {
			mockSend.mockResolvedValueOnce({ Item: undefined });

			const result = await repo.findById("event-1", "non-existent");

			expect(result).toBeNull();
		});
	});

	describe("findByEventId", () => {
		it("イベントの全アカウントを取得できるべき", async () => {
			const mockItems = [
				{
					PK: "EVENT#event-1",
					SK: "COMPETITOR_ACCOUNT#id-1",
					EntityType: "COMPETITOR_ACCOUNT",
					CreatedAt: new Date().toISOString(),
					UpdatedAt: new Date().toISOString(),
					id: "id-1",
					eventId: "event-1",
					name: "team01",
					provider: "aws",
					accountId: "111111111111",
					region: "ap-northeast-1",
					status: "pending",
				},
				{
					PK: "EVENT#event-1",
					SK: "COMPETITOR_ACCOUNT#id-2",
					EntityType: "COMPETITOR_ACCOUNT",
					CreatedAt: new Date().toISOString(),
					UpdatedAt: new Date().toISOString(),
					id: "id-2",
					eventId: "event-1",
					name: "team02",
					provider: "aws",
					accountId: "222222222222",
					region: "ap-northeast-1",
					status: "pending",
				},
			];
			mockSend.mockResolvedValueOnce({ Items: mockItems });

			const result = await repo.findByEventId("event-1");

			expect(result).toHaveLength(2);
			expect(result[0].name).toBe("team01");
			expect(result[1].name).toBe("team02");
		});

		it("アカウントがない場合は空配列を返すべき", async () => {
			mockSend.mockResolvedValueOnce({ Items: [] });

			const result = await repo.findByEventId("event-empty");

			expect(result).toEqual([]);
		});
	});

	describe("updateStatus", () => {
		it("ステータスを更新できるべき", async () => {
			mockSend.mockResolvedValueOnce({});

			await repo.updateStatus("event-1", "test-ulid-001", "ready");

			expect(mockSend).toHaveBeenCalledTimes(1);
		});
	});

	describe("delete", () => {
		it("アカウントを削除できるべき", async () => {
			mockSend.mockResolvedValueOnce({});

			await repo.delete("event-1", "test-ulid-001");

			expect(mockSend).toHaveBeenCalledTimes(1);
		});
	});
});
