import { StatusCodes } from "http-status-codes";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  registerEndpoint: vi.fn(),
  listEndpoints: vi.fn(),
}));

vi.mock(
  "../../lib/problem-deploy/handlers/microservice-migration-registration-handler/shared",
  () => ({
    buildMicroserviceMigrationRegistrationSharedResources: () => ({
      tableName: "TestMicroserviceMigrationScores",
      ddb: { send: vi.fn() },
    }),
  }),
);

vi.mock(
  "../../lib/problem-deploy/handlers/microservice-migration-registration-handler/store",
  () => ({
    registerEndpoint: mocks.registerEndpoint,
    listEndpoints: mocks.listEndpoints,
  }),
);

const { app } = await import(
  "../../lib/problem-deploy/handlers/microservice-migration-registration-handler/index"
);

describe("POST /problems/microservice-migration-battle/endpoints", () => {
  beforeEach(() => vi.clearAllMocks());

  it("200 で登録 slot を返すべき", async () => {
    mocks.registerEndpoint.mockResolvedValueOnce({
      slot: "users",
      registeredUrl: "https://users.example.com",
      registeredAt: "2026-05-12T10:00:00.000Z",
    });
    const res = await app.request("/problems/microservice-migration-battle/endpoints", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ slot: "users", url: "https://users.example.com" }),
    });
    expect(res.status).toBe(StatusCodes.OK);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.slot).toBe("users");
    expect(body.registeredUrl).toBe("https://users.example.com");
    expect(mocks.registerEndpoint).toHaveBeenCalledTimes(1);
  });

  it("slot が想定外なら 400 を返すべき", async () => {
    const res = await app.request("/problems/microservice-migration-battle/endpoints", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ slot: "payments", url: "https://x.example.com" }),
    });
    expect(res.status).toBe(StatusCodes.BAD_REQUEST);
    expect(mocks.registerEndpoint).not.toHaveBeenCalled();
  });

  it("URL が http(s) prefix でないなら 400 を返すべき", async () => {
    const res = await app.request("/problems/microservice-migration-battle/endpoints", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ slot: "users", url: "ftp://x.example.com" }),
    });
    expect(res.status).toBe(StatusCodes.BAD_REQUEST);
    expect(mocks.registerEndpoint).not.toHaveBeenCalled();
  });

  it("body が JSON でないなら 400 を返すべき", async () => {
    const res = await app.request("/problems/microservice-migration-battle/endpoints", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not-json",
    });
    expect(res.status).toBe(StatusCodes.BAD_REQUEST);
  });

  it("store が throw したら 500 を返すべき", async () => {
    mocks.registerEndpoint.mockRejectedValueOnce(new Error("ddb down"));
    const res = await app.request("/problems/microservice-migration-battle/endpoints", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ slot: "orders", url: "https://orders.example.com" }),
    });
    expect(res.status).toBe(StatusCodes.INTERNAL_SERVER_ERROR);
  });
});

describe("GET /problems/microservice-migration-battle/endpoints", () => {
  beforeEach(() => vi.clearAllMocks());

  it("登録済 slot 一覧を返すべき", async () => {
    mocks.listEndpoints.mockResolvedValueOnce({
      items: [
        {
          slot: "users",
          registeredUrl: "https://users.example.com",
          registeredAt: "2026-05-12T10:00:00.000Z",
          platform: "lambda",
          lastResult: "ok",
          lastProbeAt: "2026-05-12T10:01:00.000Z",
          lastPoints: 1000,
          lastResponseTimeMs: 50,
        },
      ],
    });
    const res = await app.request("/problems/microservice-migration-battle/endpoints");
    expect(res.status).toBe(StatusCodes.OK);
    const body = (await res.json()) as { items: Array<Record<string, unknown>> };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.platform).toBe("lambda");
  });
});
