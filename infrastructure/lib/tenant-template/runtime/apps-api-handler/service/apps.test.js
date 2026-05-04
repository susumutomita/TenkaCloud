/**
 * apps service の workflow テスト。SDK client (ddb / lambda / cognito / ssm) の `send`
 * を mock することで、Context 経由で stub を注入する。Repository 層の実装はそのまま
 * 通る (実 AWS には繋がらない、send が mock を返すだけ)。
 *
 * vi.mock の hoisting に頼らず Context injection だけで成立する設計の妥当性確認。
 */

const { createAppsService, CreateAppValidationError } = require("./apps");

function makeMockClient() {
  return { send: vi.fn().mockResolvedValue({}) };
}

function makeCtx(overrides = {}) {
  return {
    ddb: makeMockClient(),
    lambda: makeMockClient(),
    cognito: makeMockClient(),
    ssm: makeMockClient(),
    env: {
      appsTableName: "AppsTable",
      authProxyBucket: "bucket",
      authProxyKey: "key.zip",
      perAppRoleArn: "arn:iam::role",
      cognitoDomain: "https://example.auth.ap-northeast-1.amazoncognito.com",
      cognitoClientId: "client-id",
      userPoolId: "ap-northeast-1_ABC",
      brokerEntraGraphParameterName: undefined,
      brokerEntraTenantConfigPrefix: "/TenkaCloud/tenants",
      brokerEntraApplicationTemplateId: undefined,
      ...overrides.env,
    },
  };
}

// SSM ParameterNotFound を模す (AWS SDK の error name)
function ssmParameterNotFound() {
  const err = new Error("Parameter not found");
  err.name = "ParameterNotFound";
  return err;
}

describe("apps service", () => {
  describe("createApp", () => {
    describe("body に name が無いとき", () => {
      it("CreateAppValidationError を投げて Lambda 作成を呼ばないべき", async () => {
        const ctx = makeCtx();
        const service = createAppsService(ctx);

        await expect(
          service.createApp("tenant-1", { upstreamUrl: "https://x" }),
        ).rejects.toBeInstanceOf(CreateAppValidationError);
        expect(ctx.lambda.send).not.toHaveBeenCalled();
      });
    });

    describe("body に upstreamUrl が無いとき", () => {
      it("CreateAppValidationError を投げるべき", async () => {
        const ctx = makeCtx();
        const service = createAppsService(ctx);

        await expect(service.createApp("tenant-1", { name: "X" })).rejects.toBeInstanceOf(
          CreateAppValidationError,
        );
      });
    });

    describe("allowedEmailDomains が空 / 未指定のとき", () => {
      it("CreateAppValidationError (memory: 空配列は全拒否) を投げるべき", async () => {
        const ctx = makeCtx();
        const service = createAppsService(ctx);

        await expect(
          service.createApp("tenant-1", { name: "X", upstreamUrl: "https://x" }),
        ).rejects.toBeInstanceOf(CreateAppValidationError);
        await expect(
          service.createApp("tenant-1", {
            name: "X",
            upstreamUrl: "https://x",
            allowedEmailDomains: [],
          }),
        ).rejects.toBeInstanceOf(CreateAppValidationError);
        expect(ctx.lambda.send).not.toHaveBeenCalled();
      });
    });

    describe("allowedEmailDomains に invalid フォーマット (URL 等) が含まれるとき", () => {
      it("CreateAppValidationError を投げるべき", async () => {
        const ctx = makeCtx();
        const service = createAppsService(ctx);

        await expect(
          service.createApp("tenant-1", {
            name: "X",
            upstreamUrl: "https://x",
            allowedEmailDomains: ["http://denso.co.jp"],
          }),
        ).rejects.toBeInstanceOf(CreateAppValidationError);
      });
    });

    describe("guestEmails に @ 無しの不正 email が含まれるとき", () => {
      it("invalid 文字列を含む error を投げて Lambda 作成を呼ばないべき", async () => {
        const ctx = makeCtx();
        const service = createAppsService(ctx);

        await expect(
          service.createApp("tenant-1", {
            name: "X",
            upstreamUrl: "https://x",
            allowedEmailDomains: ["denso.co.jp"],
            guestEmails: ["broken"],
          }),
        ).rejects.toThrow(/invalid guest email address.*broken/);
        expect(ctx.lambda.send).not.toHaveBeenCalled();
      });
    });

    describe("guestEmails の domain が allowedEmailDomains に含まれないとき", () => {
      it("CreateAppValidationError を投げて fail-fast (Lambda 作成前) にするべき", async () => {
        const ctx = makeCtx();
        const service = createAppsService(ctx);

        await expect(
          service.createApp("tenant-1", {
            name: "X",
            upstreamUrl: "https://x",
            allowedEmailDomains: ["denso.co.jp"],
            guestEmails: ["bob@evil.com"],
          }),
        ).rejects.toBeInstanceOf(CreateAppValidationError);
        expect(ctx.lambda.send).not.toHaveBeenCalled();
      });
    });

    describe("guestEmails ありで broker 未設定 (SSM ParameterNotFound + env 未設定) のとき", () => {
      it("「broker Entra profile is not configured」error を投げるべき", async () => {
        const ctx = makeCtx();
        ctx.ssm.send.mockRejectedValueOnce(ssmParameterNotFound());
        const service = createAppsService(ctx);

        await expect(
          service.createApp("tenant-1", {
            name: "X",
            upstreamUrl: "https://x",
            allowedEmailDomains: ["example.com"],
            guestEmails: ["alice@example.com"],
          }),
        ).rejects.toThrow(/broker Entra profile is not configured/);
        expect(ctx.lambda.send).not.toHaveBeenCalled();
      });
    });
  });

  describe("listApps", () => {
    describe("DDB Query が複数 item を返すとき", () => {
      it("apps 配列で返すべき", async () => {
        const ctx = makeCtx();
        ctx.ddb.send.mockResolvedValueOnce({ Items: [{ appId: "a" }, { appId: "b" }] });
        const service = createAppsService(ctx);

        const result = await service.listApps("tenant-1");
        expect(result.apps).toHaveLength(2);
        expect(result.apps.map((i) => i.appId)).toEqual(["a", "b"]);
      });
    });

    describe("DDB Query が 1 件も返さないとき", () => {
      it("空配列を返すべき", async () => {
        const ctx = makeCtx();
        ctx.ddb.send.mockResolvedValueOnce({ Items: undefined });
        const service = createAppsService(ctx);

        const result = await service.listApps("tenant-1");
        expect(result.apps).toEqual([]);
      });
    });
  });

  describe("deleteApp", () => {
    describe("DDB Get が item を返さないとき", () => {
      it("notFound: true を返して Lambda / Cognito を一切呼ばないべき", async () => {
        const ctx = makeCtx();
        ctx.ddb.send.mockResolvedValueOnce({ Item: undefined });
        const service = createAppsService(ctx);

        const result = await service.deleteApp("tenant-1", "missing-app");
        expect(result).toEqual({ notFound: true });
        expect(ctx.lambda.send).not.toHaveBeenCalled();
        expect(ctx.cognito.send).not.toHaveBeenCalled();
      });
    });

    describe("functionUrl ありの item があるとき", () => {
      it("Lambda 削除 (URL config + function) と Cognito callback 除外を呼んでから DDB を消すべき", async () => {
        const ctx = makeCtx();
        ctx.ddb.send
          .mockResolvedValueOnce({
            Item: {
              tenantId: "tenant-1",
              appId: "app-1",
              functionName: "TenkaCloud-app-tenant-1-app-1",
              functionUrl: "https://abc.lambda-url.ap-northeast-1.on.aws/",
            },
          }) // Get
          .mockResolvedValueOnce({}); // Delete
        ctx.cognito.send.mockResolvedValue({ UserPoolClient: {} });
        const service = createAppsService(ctx);

        const result = await service.deleteApp("tenant-1", "app-1");
        expect(result).toEqual({ notFound: false });
        expect(ctx.lambda.send).toHaveBeenCalledTimes(2);
        expect(ctx.cognito.send).toHaveBeenCalled();
        expect(ctx.ddb.send).toHaveBeenCalledTimes(2);
      });
    });

    describe("Lambda 削除が ResourceNotFoundException で失敗するとき (best-effort)", () => {
      it("warn を出して DDB 削除まで進めるべき", async () => {
        const ctx = makeCtx();
        ctx.ddb.send
          .mockResolvedValueOnce({
            Item: {
              tenantId: "tenant-1",
              appId: "app-1",
              functionName: "TenkaCloud-app-tenant-1-app-1",
            },
          }) // Get
          .mockResolvedValueOnce({}); // Delete
        const notFoundErr = Object.assign(new Error("not found"), {
          name: "ResourceNotFoundException",
        });
        ctx.lambda.send.mockRejectedValue(notFoundErr);
        const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const service = createAppsService(ctx);

        const result = await service.deleteApp("tenant-1", "app-1");
        expect(result).toEqual({ notFound: false });
        expect(consoleWarn).toHaveBeenCalled();
        expect(ctx.ddb.send).toHaveBeenCalledTimes(2);
        consoleWarn.mockRestore();
      });
    });
  });
});
