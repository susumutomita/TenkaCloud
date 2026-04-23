import { describe, expect, it } from "vitest";
import { getAllowedOrigins } from "./cors";

describe("getAllowedOrigins", () => {
	it("未指定の場合はローカルの application-plane と control-plane を許可すべき", () => {
		expect(getAllowedOrigins(undefined)).toEqual([
			"http://localhost:13000",
			"http://localhost:13001",
		]);
	});

	it("指定値がある場合は空要素を除去して返すべき", () => {
		expect(
			getAllowedOrigins(" https://example.com, ,http://localhost:9999 "),
		).toEqual(["https://example.com", "http://localhost:9999"]);
	});

	it("空文字列のみの場合はローカル既定値にフォールバックすべき", () => {
		expect(getAllowedOrigins(" , ")).toEqual([
			"http://localhost:13000",
			"http://localhost:13001",
		]);
	});
});
