/**
 * Prisma Client Tests
 *
 * @prisma/client が利用不可でもモジュールがクラッシュしないことを検証
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("prisma-client", () => {
	const originalEnv = process.env;

	beforeEach(() => {
		vi.resetModules();
		process.env = { ...originalEnv };
	});

	afterEach(() => {
		process.env = originalEnv;
	});

	it("モジュールが正常にインポートできるべき", async () => {
		const { prisma } = await import("../repositories/prisma-client");
		// prisma は null（@prisma/client 未生成時）または PrismaClient インスタンス
		expect(prisma === null || prisma !== undefined).toBe(true);
	});

	it("prisma エクスポートが定義されているべき", async () => {
		const mod = await import("../repositories/prisma-client");
		expect(mod).toHaveProperty("prisma");
		expect(mod).toHaveProperty("default");
	});

	it("@prisma/client 未生成時は null を返すべき", async () => {
		// テスト環境では @prisma/client が生成されていないため null になる
		const { prisma } = await import("../repositories/prisma-client");
		expect(prisma).toBeNull();
	});

	it("@prisma/client 未生成時に警告メッセージを出力すべき", async () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.resetModules();

		await import("../repositories/prisma-client");

		const warnCalls = warnSpy.mock.calls.flat().join(" ");
		expect(warnCalls).toContain("@prisma/client is not available");
		expect(warnCalls).toContain("bunx prisma generate");

		warnSpy.mockRestore();
	});

	it("named export と default export が同じ値を返すべき", async () => {
		const mod = await import("../repositories/prisma-client");
		expect(mod.prisma).toBe(mod.default);
	});
});
