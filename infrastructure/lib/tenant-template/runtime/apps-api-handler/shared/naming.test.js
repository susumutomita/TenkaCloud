const {
  makeFunctionName,
  normalizeGuestEmails,
  assertGuestEmails,
  makeBrokerProviderName,
  getCognitoSamlValues,
} = require("./naming");

describe("apps-api-handler/naming", () => {
  describe("makeFunctionName", () => {
    describe("tenantId と appId を渡したとき", () => {
      it("`TenkaCloud-app-{tenantId}-{appId}` 形式を返すべき", () => {
        expect(makeFunctionName("pooled", "abc123")).toBe("TenkaCloud-app-pooled-abc123");
      });

      it("64 文字を超える場合は 64 文字で truncate するべき", () => {
        const long = makeFunctionName("01abcdefghijklmnopqrstuvwx", "01abcdefghijklmnopqrstuvwx");
        expect(long.length).toBe(64);
        expect(long.startsWith("TenkaCloud-app-")).toBe(true);
      });
    });
  });

  describe("normalizeGuestEmails", () => {
    describe("array や string で受けたとき", () => {
      it("空 / null / undefined では空配列を返すべき", () => {
        expect(normalizeGuestEmails(null)).toEqual([]);
        expect(normalizeGuestEmails(undefined)).toEqual([]);
        expect(normalizeGuestEmails("")).toEqual([]);
        expect(normalizeGuestEmails([])).toEqual([]);
      });

      it("array は trim + lowercase + 重複除去するべき", () => {
        expect(
          normalizeGuestEmails([" Alice@Example.com ", "alice@example.com", "BOB@example.com"]),
        ).toEqual(["alice@example.com", "bob@example.com"]);
      });

      it("カンマ / 空白区切り string も配列同様に正規化するべき", () => {
        expect(normalizeGuestEmails("alice@x.com, bob@x.com\ncarol@x.com")).toEqual([
          "alice@x.com",
          "bob@x.com",
          "carol@x.com",
        ]);
      });
    });
  });

  describe("assertGuestEmails", () => {
    describe("正規化済み email 配列を受けたとき", () => {
      it("妥当な email のみなら何も throw しないべき", () => {
        expect(() => assertGuestEmails(["alice@example.com", "bob@x.co.jp"])).not.toThrow();
      });

      it("`@` が無い文字列があれば error を throw するべき", () => {
        expect(() => assertGuestEmails(["not-an-email"])).toThrow(/invalid guest email address/);
      });

      it("複数 invalid な場合は全部含めて error message に出すべき", () => {
        expect(() => assertGuestEmails(["alice@x.com", "broken", "also broken"])).toThrow(
          /broken.*also broken/,
        );
      });
    });
  });

  describe("makeBrokerProviderName", () => {
    describe("brokerConfig を受けたとき", () => {
      it("graphParameterName から決定論的に同じ値を返すべき (idempotency)", () => {
        const cfg = {
          graphParameterName: "/TenkaCloud/broker-entra/profiles/default/graph-credentials",
        };
        expect(makeBrokerProviderName(cfg)).toBe(makeBrokerProviderName(cfg));
      });

      it("`EntraBroker-{10 桁 hex}` 形式を返すべき", () => {
        const cfg = {
          graphParameterName: "/TenkaCloud/broker-entra/profiles/default/graph-credentials",
        };
        expect(makeBrokerProviderName(cfg)).toMatch(/^EntraBroker-[0-9a-f]{10}$/);
      });

      it("graphParameterName が違えば別の値を返すべき", () => {
        const a = makeBrokerProviderName({
          graphParameterName: "/TenkaCloud/broker-entra/profiles/a/graph-credentials",
        });
        const b = makeBrokerProviderName({
          graphParameterName: "/TenkaCloud/broker-entra/profiles/b/graph-credentials",
        });
        expect(a).not.toBe(b);
      });

      it("graphParameterName 未指定なら profileId で fallback するべき", () => {
        const a = makeBrokerProviderName({ profileId: "acme" });
        expect(a).toMatch(/^EntraBroker-[0-9a-f]{10}$/);
      });
    });
  });

  describe("getCognitoSamlValues", () => {
    describe("cognitoDomain と userPoolId を受けたとき", () => {
      it("spEntityId と acsUrl を返すべき", () => {
        expect(
          getCognitoSamlValues(
            "https://example.auth.ap-northeast-1.amazoncognito.com",
            "ap-northeast-1_ABC",
          ),
        ).toEqual({
          spEntityId: "urn:amazon:cognito:sp:ap-northeast-1_ABC",
          acsUrl: "https://example.auth.ap-northeast-1.amazoncognito.com/saml2/idpresponse",
        });
      });

      it("片方が空なら error を throw するべき", () => {
        expect(() => getCognitoSamlValues("", "ap-northeast-1_ABC")).toThrow();
        expect(() => getCognitoSamlValues("https://example", "")).toThrow();
      });
    });
  });
});
