import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockFetch = vi.fn();
global.fetch = mockFetch;

import {
	initGameState,
	seedAttackCatalog,
	initializeGamedayService,
} from "../lib/gameday-client";

describe("GameDay クライアント", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe("initGameState", () => {
		it("ゲーム状態を初期化して結果を返すべき", async () => {
			const mockResponse = {
				eventId: "event-1",
				tenantId: "tenant-1",
				isRunning: false,
				startedAt: null,
				scoreWeight: "normal",
				blackout: false,
				durationMinutes: 240,
			};
			mockFetch.mockResolvedValue({
				ok: true,
				json: () => Promise.resolve(mockResponse),
			});

			const result = await initGameState({
				eventId: "event-1",
				tenantId: "tenant-1",
			});

			expect(result).toEqual(mockResponse);
			expect(mockFetch).toHaveBeenCalledWith(
				"http://localhost:3020/api/gameday/admin/game/init",
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						eventId: "event-1",
						tenantId: "tenant-1",
						durationMinutes: 240,
					}),
				},
			);
		});

		it("カスタム durationMinutes を渡せるべき", async () => {
			mockFetch.mockResolvedValue({
				ok: true,
				json: () =>
					Promise.resolve({
						eventId: "event-1",
						tenantId: "tenant-1",
						isRunning: false,
						startedAt: null,
						scoreWeight: "normal",
						blackout: false,
						durationMinutes: 120,
					}),
			});

			await initGameState({
				eventId: "event-1",
				tenantId: "tenant-1",
				durationMinutes: 120,
			});

			expect(mockFetch).toHaveBeenCalledWith(
				expect.any(String),
				expect.objectContaining({
					body: JSON.stringify({
						eventId: "event-1",
						tenantId: "tenant-1",
						durationMinutes: 120,
					}),
				}),
			);
		});

		it("レスポンスがエラーの場合に例外を投げるべき", async () => {
			mockFetch.mockResolvedValue({
				ok: false,
				status: 500,
				text: () => Promise.resolve("Internal Server Error"),
			});

			await expect(
				initGameState({ eventId: "event-1", tenantId: "tenant-1" }),
			).rejects.toThrow(
				"GameDay サービスのゲーム初期化に失敗しました: 500 Internal Server Error",
			);
		});
	});

	describe("seedAttackCatalog", () => {
		it("攻撃カタログをシードして結果を返すべき", async () => {
			const mockResponse = { seeded: 12 };
			mockFetch.mockResolvedValue({
				ok: true,
				json: () => Promise.resolve(mockResponse),
			});

			const result = await seedAttackCatalog({
				eventId: "event-1",
				tenantId: "tenant-1",
			});

			expect(result).toEqual(mockResponse);
			expect(mockFetch).toHaveBeenCalledWith(
				"http://localhost:3020/api/gameday/admin/attacks/seed",
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ eventId: "event-1" }),
				},
			);
		});

		it("レスポンスがエラーの場合に例外を投げるべき", async () => {
			mockFetch.mockResolvedValue({
				ok: false,
				status: 404,
				text: () => Promise.resolve("Not Found"),
			});

			await expect(
				seedAttackCatalog({ eventId: "event-1", tenantId: "tenant-1" }),
			).rejects.toThrow(
				"GameDay サービスの攻撃カタログシードに失敗しました: 404 Not Found",
			);
		});
	});

	describe("initializeGamedayService", () => {
		it("初期化と攻撃カタログシードの両方を実行すべき", async () => {
			mockFetch
				.mockResolvedValueOnce({
					ok: true,
					json: () =>
						Promise.resolve({
							eventId: "event-1",
							tenantId: "tenant-1",
							isRunning: false,
							startedAt: null,
							scoreWeight: "normal",
							blackout: false,
							durationMinutes: 240,
						}),
				})
				.mockResolvedValueOnce({
					ok: true,
					json: () => Promise.resolve({ seeded: 12 }),
				});

			const result = await initializeGamedayService({
				eventId: "event-1",
				tenantId: "tenant-1",
			});

			expect(result).toEqual({ success: true });
			expect(mockFetch).toHaveBeenCalledTimes(2);
		});

		it("エラーが発生しても success: false を返してクラッシュしないべき", async () => {
			mockFetch.mockResolvedValue({
				ok: false,
				status: 500,
				text: () => Promise.resolve("Internal Server Error"),
			});

			const consoleSpy = vi
				.spyOn(console, "error")
				.mockImplementation(() => {});
			const result = await initializeGamedayService({
				eventId: "event-1",
				tenantId: "tenant-1",
			});

			expect(result.success).toBe(false);
			expect(result.error).toBeDefined();
			consoleSpy.mockRestore();
		});

		it("ネットワークエラーでも success: false を返すべき", async () => {
			mockFetch.mockRejectedValue(new Error("Connection refused"));

			const consoleSpy = vi
				.spyOn(console, "error")
				.mockImplementation(() => {});
			const result = await initializeGamedayService({
				eventId: "event-1",
				tenantId: "tenant-1",
			});

			expect(result.success).toBe(false);
			expect(result.error).toBe("Connection refused");
			consoleSpy.mockRestore();
		});
	});
});
