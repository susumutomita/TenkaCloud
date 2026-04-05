import { describe, it, expect } from "vitest";
import {
	isValidTransition,
	getValidTransitions,
	validateTransition,
	InvalidStatusTransitionError,
} from "../services/event-lifecycle";
import type { EventStatus } from "../types";

describe("イベントライフサイクル管理", () => {
	describe("isValidTransition", () => {
		it("draft から scheduled への遷移を許可するべき", () => {
			expect(isValidTransition("draft", "scheduled")).toBe(true);
		});

		it("scheduled から active への遷移を許可するべき", () => {
			expect(isValidTransition("scheduled", "active")).toBe(true);
		});

		it("scheduled から cancelled への遷移を許可するべき", () => {
			expect(isValidTransition("scheduled", "cancelled")).toBe(true);
		});

		it("active から paused への遷移を許可するべき", () => {
			expect(isValidTransition("active", "paused")).toBe(true);
		});

		it("active から completed への遷移を許可するべき", () => {
			expect(isValidTransition("active", "completed")).toBe(true);
		});

		it("paused から active への遷移を許可するべき", () => {
			expect(isValidTransition("paused", "active")).toBe(true);
		});

		it("paused から cancelled への遷移を許可するべき", () => {
			expect(isValidTransition("paused", "cancelled")).toBe(true);
		});

		it("completed から cancelled への遷移を許可するべき", () => {
			expect(isValidTransition("completed", "cancelled")).toBe(true);
		});

		it("draft から active への直接遷移を拒否するべき", () => {
			expect(isValidTransition("draft", "active")).toBe(false);
		});

		it("draft から completed への直接遷移を拒否するべき", () => {
			expect(isValidTransition("draft", "completed")).toBe(false);
		});

		it("cancelled から他のステータスへの遷移を拒否するべき", () => {
			expect(isValidTransition("cancelled", "draft")).toBe(false);
			expect(isValidTransition("cancelled", "scheduled")).toBe(false);
			expect(isValidTransition("cancelled", "active")).toBe(false);
		});

		it("completed から active への逆遷移を拒否するべき", () => {
			expect(isValidTransition("completed", "active")).toBe(false);
		});

		it("active から draft への逆遷移を拒否するべき", () => {
			expect(isValidTransition("active", "draft")).toBe(false);
		});

		it("同じステータスへの遷移を拒否するべき", () => {
			const statuses: EventStatus[] = [
				"draft",
				"scheduled",
				"active",
				"paused",
				"completed",
				"cancelled",
			];
			for (const status of statuses) {
				expect(isValidTransition(status, status)).toBe(false);
			}
		});
	});

	describe("getValidTransitions", () => {
		it("draft の有効な遷移先を返すべき", () => {
			expect(getValidTransitions("draft")).toEqual(["scheduled"]);
		});

		it("scheduled の有効な遷移先を返すべき", () => {
			expect(getValidTransitions("scheduled")).toEqual(["active", "cancelled"]);
		});

		it("active の有効な遷移先を返すべき", () => {
			expect(getValidTransitions("active")).toEqual(["paused", "completed"]);
		});

		it("paused の有効な遷移先を返すべき", () => {
			expect(getValidTransitions("paused")).toEqual(["active", "cancelled"]);
		});

		it("completed の有効な遷移先を返すべき", () => {
			expect(getValidTransitions("completed")).toEqual(["cancelled"]);
		});

		it("cancelled の有効な遷移先は空を返すべき", () => {
			expect(getValidTransitions("cancelled")).toEqual([]);
		});
	});

	describe("validateTransition", () => {
		it("有効な遷移ではエラーを投げないべき", () => {
			expect(() => validateTransition("draft", "scheduled")).not.toThrow();
			expect(() => validateTransition("scheduled", "active")).not.toThrow();
			expect(() => validateTransition("active", "completed")).not.toThrow();
		});

		it("無効な遷移では InvalidStatusTransitionError を投げるべき", () => {
			expect(() => validateTransition("draft", "active")).toThrow(
				InvalidStatusTransitionError,
			);
		});

		it("エラーに現在のステータスと遷移先を含むべき", () => {
			try {
				validateTransition("draft", "completed");
				expect.fail("エラーが発生するべき");
			} catch (error) {
				expect(error).toBeInstanceOf(InvalidStatusTransitionError);
				const e = error as InvalidStatusTransitionError;
				expect(e.currentStatus).toBe("draft");
				expect(e.targetStatus).toBe("completed");
				expect(e.message).toContain("draft");
				expect(e.message).toContain("completed");
			}
		});
	});
});
