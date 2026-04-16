import { describe, it, expect } from "vitest";
import { isBlockedHost } from "./index";

describe("isBlockedHost", () => {
	describe("ブロックすべきホスト", () => {
		it("localhost をブロックすべき", () => {
			expect(isBlockedHost("localhost")).toBe(true);
		});

		it("127.0.0.1 をブロックすべき", () => {
			expect(isBlockedHost("127.0.0.1")).toBe(true);
		});

		it("10.x プライベートレンジをブロックすべき", () => {
			expect(isBlockedHost("10.0.0.1")).toBe(true);
			expect(isBlockedHost("10.255.255.255")).toBe(true);
		});

		it("172.16-31.x プライベートレンジをブロックすべき", () => {
			expect(isBlockedHost("172.16.0.1")).toBe(true);
			expect(isBlockedHost("172.31.255.255")).toBe(true);
		});

		it("192.168.x プライベートレンジをブロックすべき", () => {
			expect(isBlockedHost("192.168.0.1")).toBe(true);
			expect(isBlockedHost("192.168.255.255")).toBe(true);
		});

		it("169.254.x リンクローカルをブロックすべき", () => {
			expect(isBlockedHost("169.254.169.254")).toBe(true);
		});

		it("0.0.0.0 をブロックすべき", () => {
			expect(isBlockedHost("0.0.0.0")).toBe(true);
		});

		it("IPv6 ループバック [::1] をブロックすべき", () => {
			expect(isBlockedHost("[::1]")).toBe(true);
			expect(isBlockedHost("::1")).toBe(true);
		});

		it("IPv6 マップドアドレス ::ffff:127.0.0.1 をブロックすべき", () => {
			expect(isBlockedHost("[::ffff:127.0.0.1]")).toBe(true);
			expect(isBlockedHost("::ffff:127.0.0.1")).toBe(true);
		});

		it("IPv6 マップドアドレス 16進形式 ::ffff:7f00:1 をブロックすべき", () => {
			expect(isBlockedHost("[::ffff:7f00:1]")).toBe(true);
			expect(isBlockedHost("::ffff:c0a8:0101")).toBe(true);
		});

		it("10進数エンコード IP 2130706433 をブロックすべき", () => {
			expect(isBlockedHost("2130706433")).toBe(true);
		});

		it("16進数エンコード IP 0x7f000001 をブロックすべき", () => {
			expect(isBlockedHost("0x7f000001")).toBe(true);
		});

		it("8進数エンコード IP 0177.0.0.1 をブロックすべき", () => {
			expect(isBlockedHost("0177.0.0.1")).toBe(true);
		});

		it("混合形式 0x7f.0.0.1 をブロックすべき", () => {
			expect(isBlockedHost("0x7f.0.0.1")).toBe(true);
		});
	});

	describe("許可すべきホスト", () => {
		it("外部ドメインを許可すべき", () => {
			expect(isBlockedHost("example.com")).toBe(false);
			expect(isBlockedHost("api.github.com")).toBe(false);
		});

		it("パブリック IP を許可すべき", () => {
			expect(isBlockedHost("8.8.8.8")).toBe(false);
			expect(isBlockedHost("203.0.113.1")).toBe(false);
		});

		it("172.32.x（プライベート外）を許可すべき", () => {
			expect(isBlockedHost("172.32.0.1")).toBe(false);
		});
	});
});
