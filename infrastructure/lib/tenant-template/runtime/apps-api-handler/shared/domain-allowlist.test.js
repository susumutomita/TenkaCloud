const {
  DomainAllowlistError,
  normalizeDomainList,
  assertValidDomains,
  assertEmailsInAllowlist,
  emailDomain,
} = require("./domain-allowlist");

describe("domain-allowlist", () => {
  describe("normalizeDomainList", () => {
    describe("array や comma-separated string で受けたとき", () => {
      it("空 / null / undefined では空配列を返すべき", () => {
        expect(normalizeDomainList(null)).toEqual([]);
        expect(normalizeDomainList(undefined)).toEqual([]);
        expect(normalizeDomainList("")).toEqual([]);
        expect(normalizeDomainList([])).toEqual([]);
      });

      it("array は trim + lowercase + 重複除去するべき", () => {
        expect(normalizeDomainList([" Denso.co.jp ", "denso.co.jp", "JAXA.JP"])).toEqual([
          "denso.co.jp",
          "jaxa.jp",
        ]);
      });

      it("カンマ / 空白区切り string も配列同様に正規化するべき", () => {
        expect(normalizeDomainList("denso.co.jp, jaxa.jp\nexample.com")).toEqual([
          "denso.co.jp",
          "jaxa.jp",
          "example.com",
        ]);
      });
    });
  });

  describe("assertValidDomains", () => {
    describe("正規化済み domain 配列を受けたとき", () => {
      it("空配列なら DomainAllowlistError を投げるべき (memory ルール)", () => {
        expect(() => assertValidDomains([])).toThrow(DomainAllowlistError);
        expect(() => assertValidDomains([])).toThrow(/最低 1 つ必要/);
      });

      it("妥当な domain のみなら何も throw しないべき", () => {
        expect(() => assertValidDomains(["denso.co.jp", "jaxa.jp"])).not.toThrow();
      });

      it("@ や / を含む invalid な値があれば error を投げるべき", () => {
        expect(() => assertValidDomains(["denso.co.jp", "alice@x.com"])).toThrow(
          /invalid domain format/,
        );
        expect(() => assertValidDomains(["http://x.com"])).toThrow(/invalid domain format/);
      });

      it("単一ラベル (例: localhost) は invalid 扱いするべき", () => {
        expect(() => assertValidDomains(["localhost"])).toThrow(/invalid domain format/);
      });
    });
  });

  describe("emailDomain", () => {
    describe("email を渡したとき", () => {
      it("@ より後ろを lowercase で返すべき", () => {
        expect(emailDomain("Alice@Example.COM")).toBe("example.com");
      });

      it("@ が無いと空文字を返すべき", () => {
        expect(emailDomain("not-an-email")).toBe("");
      });
    });
  });

  describe("assertEmailsInAllowlist", () => {
    describe("emails が空のとき", () => {
      it("allowedDomains が空でも何も throw しないべき (招待無し作成)", () => {
        expect(() => assertEmailsInAllowlist([], [])).not.toThrow();
      });
    });

    describe("emails あり / allowedDomains 空のとき", () => {
      it("DomainAllowlistError を投げるべき (memory ルール: 空配列は全拒否)", () => {
        expect(() => assertEmailsInAllowlist(["alice@x.com"], [])).toThrow(DomainAllowlistError);
      });
    });

    describe("一部の email が allowlist 外のとき", () => {
      it("該当 email を含む error を投げるべき", () => {
        expect(() =>
          assertEmailsInAllowlist(["alice@denso.co.jp", "bob@evil.com"], ["denso.co.jp"]),
        ).toThrow(/bob@evil\.com/);
      });
    });

    describe("全 email が allowlist 内のとき", () => {
      it("何も throw しないべき", () => {
        expect(() =>
          assertEmailsInAllowlist(["alice@denso.co.jp", "bob@jaxa.jp"], ["denso.co.jp", "jaxa.jp"]),
        ).not.toThrow();
      });
    });
  });
});
