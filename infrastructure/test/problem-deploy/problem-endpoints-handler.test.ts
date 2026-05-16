import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  deleteProblemEndpointOverride,
  listProblemEndpoints,
  upsertProblemEndpointOverride,
} from "../../lib/problem-deploy/handlers/problem-endpoints-handler/endpoints";
import type { ProblemEndpointSlot } from "../../lib/utils/endpoints-metadata";

/**
 * problem-endpoints-handler の business logic 単体テスト。`queryTeamItems` は
 * `participant-handler/shared` の export を vi.mock で差し替えて DDB を叩かない。
 *
 * 設計上 store.ts は ddb client を呼ぶが、本テストでは shared.ddb をモック object に
 * 差し替えるので実 SDK は不要。
 */

vi.mock("../../lib/problem-deploy/handlers/participant-handler/shared", () => ({
  queryTeamItems: vi.fn(),
}));

import { queryTeamItems } from "../../lib/problem-deploy/handlers/participant-handler/shared";

const mockedQueryTeamItems = queryTeamItems as unknown as ReturnType<typeof vi.fn>;

function buildShared(opts: {
  endpointsTableName?: string;
  problemsEndpoints?: Record<string, readonly ProblemEndpointSlot[]>;
  ddbSend?: ReturnType<typeof vi.fn>;
}) {
  return {
    tableName: "Deployments",
    eventsTableName: "Events",
    endpointsTableName: opts.endpointsTableName ?? "ProblemEndpoints",
    ddb: { send: opts.ddbSend ?? vi.fn() } as never,
    problemsScoring: {},
    problemsEndpoints: opts.problemsEndpoints ?? {},
  };
}

const SLOT_FRONTEND: ProblemEndpointSlot = {
  slot: "frontend",
  default: { from: "cfn-output", key: "FrontendUrl" },
  overridable: true,
};
const SLOT_API: ProblemEndpointSlot = {
  slot: "api",
  default: { from: "cfn-output", key: "ApiUrl" },
  overridable: false,
};

const teamRow = {
  PK: "DEPLOYMENT#job-1",
  problemId: "battle-1",
  tenantId: "tenant-x",
  teamId: "team-y",
  stackOutputs: JSON.stringify([
    { OutputKey: "FrontendUrl", OutputValue: "https://front.example.com/" },
    { OutputKey: "ApiUrl", OutputValue: "https://api.example.com/" },
  ]),
};

beforeEach(() => {
  mockedQueryTeamItems.mockReset();
});

describe("listProblemEndpoints", () => {
  it("team の deployment が無いときは unauthorized を返すべき", async () => {
    mockedQueryTeamItems.mockResolvedValueOnce([]);
    const shared = buildShared({ problemsEndpoints: { "battle-1": [SLOT_FRONTEND] } });
    const r = await listProblemEndpoints(shared, "key", "battle-1");
    expect(r.kind).toBe("unauthorized");
  });

  it("team に該当 problemId が無いときも unauthorized を返すべき", async () => {
    mockedQueryTeamItems.mockResolvedValueOnce([{ ...teamRow, problemId: "other-problem" }]);
    const shared = buildShared({ problemsEndpoints: { "battle-1": [SLOT_FRONTEND] } });
    const r = await listProblemEndpoints(shared, "key", "battle-1");
    expect(r.kind).toBe("unauthorized");
  });

  it("metadata.endpoints[] が空 (= flag-only 問題) は no_endpoints を返すべき", async () => {
    mockedQueryTeamItems.mockResolvedValueOnce([teamRow]);
    const shared = buildShared({ problemsEndpoints: {} });
    const r = await listProblemEndpoints(shared, "key", "battle-1");
    expect(r.kind).toBe("no_endpoints");
  });

  it("override 無しで slot 一覧と default URL を返すべき", async () => {
    mockedQueryTeamItems.mockResolvedValueOnce([teamRow]);
    const ddbSend = vi.fn().mockResolvedValueOnce({ Items: [] });
    const shared = buildShared({
      problemsEndpoints: { "battle-1": [SLOT_FRONTEND, SLOT_API] },
      ddbSend,
    });
    const r = await listProblemEndpoints(shared, "key", "battle-1");
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") return;
    expect(r.teamId).toBe("team-y");
    expect(r.endpoints).toHaveLength(2);
    expect(r.endpoints[0]).toMatchObject({
      slot: "frontend",
      defaultUrl: "https://front.example.com/",
      effectiveUrl: "https://front.example.com/",
      overridable: true,
    });
  });

  it("override 行がある slot は effectiveUrl が override で埋まるべき", async () => {
    mockedQueryTeamItems.mockResolvedValueOnce([teamRow]);
    const ddbSend = vi.fn().mockResolvedValueOnce({
      Items: [
        {
          PK: "TENANT#tenant-x#TEAM#team-y#PROBLEM#battle-1",
          SK: "SLOT#frontend",
          slot: "frontend",
          tenantId: "tenant-x",
          teamId: "team-y",
          problemId: "battle-1",
          overrideUrl: "https://my-host.example.com/",
          updatedAt: "2026-05-12T00:00:00.000Z",
        },
      ],
    });
    const shared = buildShared({
      problemsEndpoints: { "battle-1": [SLOT_FRONTEND] },
      ddbSend,
    });
    const r = await listProblemEndpoints(shared, "key", "battle-1");
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") return;
    expect(r.endpoints[0]).toMatchObject({
      defaultUrl: "https://front.example.com/",
      overrideUrl: "https://my-host.example.com/",
      effectiveUrl: "https://my-host.example.com/",
    });
  });

  it("endpointsTableName が未配線なら misconfigured を返すべき", async () => {
    const shared = buildShared({ endpointsTableName: "" });
    const r = await listProblemEndpoints(shared, "key", "battle-1");
    expect(r.kind).toBe("misconfigured");
    expect(mockedQueryTeamItems).not.toHaveBeenCalled();
  });

  it("#703: defaultKey は常に metadata の default.key で埋まり、stackOutputs 無しでも UI が hint を出せるべき", async () => {
    mockedQueryTeamItems.mockResolvedValueOnce([
      { ...teamRow, stackOutputs: undefined, problemId: "battle-1" },
    ]);
    const ddbSend = vi.fn().mockResolvedValueOnce({ Items: [] });
    const shared = buildShared({
      problemsEndpoints: { "battle-1": [SLOT_FRONTEND, SLOT_API] },
      ddbSend,
    });
    const r = await listProblemEndpoints(shared, "key", "battle-1");
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") return;
    expect(r.endpoints[0]).toMatchObject({
      slot: "frontend",
      defaultKey: "FrontendUrl",
      overridable: true,
    });
    // defaultUrl / effectiveUrl は stackOutputs 不在のため undefined
    expect(r.endpoints[0]?.defaultUrl).toBeUndefined();
    expect(r.endpoints[0]?.effectiveUrl).toBeUndefined();
    expect(r.endpoints[1]?.defaultKey).toBe("ApiUrl");
  });
});

describe("upsertProblemEndpointOverride", () => {
  it("override 不可 slot は slot_not_overridable を返し DDB Put しないべき", async () => {
    mockedQueryTeamItems.mockResolvedValueOnce([teamRow]);
    const ddbSend = vi.fn();
    const shared = buildShared({
      problemsEndpoints: { "battle-1": [SLOT_API] },
      ddbSend,
    });
    const r = await upsertProblemEndpointOverride(
      shared,
      "key",
      "battle-1",
      "api",
      "https://new.example.com/",
      "2026-05-12T00:00:00.000Z",
    );
    expect(r.kind).toBe("slot_not_overridable");
    expect(ddbSend).not.toHaveBeenCalled();
  });

  it("URL が不正なら invalid_url を返し DDB Put しないべき", async () => {
    mockedQueryTeamItems.mockResolvedValueOnce([teamRow]);
    const ddbSend = vi.fn();
    const shared = buildShared({
      problemsEndpoints: { "battle-1": [SLOT_FRONTEND] },
      ddbSend,
    });
    const r = await upsertProblemEndpointOverride(
      shared,
      "key",
      "battle-1",
      "frontend",
      "not a url",
      "2026-05-12T00:00:00.000Z",
    );
    expect(r.kind).toBe("invalid_url");
    expect(ddbSend).not.toHaveBeenCalled();
  });

  it("ftp:// など http(s) 以外の scheme は invalid_url を返すべき", async () => {
    mockedQueryTeamItems.mockResolvedValueOnce([teamRow]);
    const shared = buildShared({
      problemsEndpoints: { "battle-1": [SLOT_FRONTEND] },
      ddbSend: vi.fn(),
    });
    const r = await upsertProblemEndpointOverride(
      shared,
      "key",
      "battle-1",
      "frontend",
      "ftp://example.com/",
      "2026-05-12T00:00:00.000Z",
    );
    expect(r.kind).toBe("invalid_url");
  });

  // SSRF defense-in-depth: metadata service / loopback literal を write 時に拒否する。
  // Phase 3.B fetcher で DNS-rebinding-safe resolve-then-connect を行うまでの blocklist。
  // Issue #863: IPv6-mapped IPv4 / IMDS v6 expanded form bypass を追加検証。
  it.each([
    ["AWS IMDS v4", "http://169.254.169.254/latest/meta-data/iam/security-credentials/"],
    ["AWS IMDS v6", "http://[fd00:ec2::254]/latest/meta-data/"],
    ["AWS IMDS v6 expanded", "http://[fd00:ec2:0:0:0:0:0:254]/latest/meta-data/"],
    ["GCE metadata", "http://metadata.google.internal/computeMetadata/v1/"],
    ["loopback IPv4", "http://127.0.0.1:9001/admin"],
    ["loopback all-zero IPv4", "http://0.0.0.0:9001/admin"],
    ["loopback IPv6", "http://[::1]/"],
    ["loopback IPv6 expanded", "http://[0:0:0:0:0:0:0:1]/"],
    ["localhost literal", "http://localhost/"],
    ["IPv6-mapped IMDS (dotted)", "http://[::ffff:169.254.169.254]/latest/meta-data/"],
    ["IPv6-mapped IMDS (hex)", "http://[::ffff:a9fe:a9fe]/latest/meta-data/"],
    ["IPv6-mapped loopback", "http://[::ffff:127.0.0.1]/admin"],
  ])("SSRF blocklist: %s host は invalid_url を返すべき", async (_, url) => {
    mockedQueryTeamItems.mockResolvedValueOnce([teamRow]);
    const ddbSend = vi.fn();
    const shared = buildShared({
      problemsEndpoints: { "battle-1": [SLOT_FRONTEND] },
      ddbSend,
    });
    const r = await upsertProblemEndpointOverride(
      shared,
      "key",
      "battle-1",
      "frontend",
      url,
      "2026-05-12T00:00:00.000Z",
    );
    expect(r.kind).toBe("invalid_url");
    expect(ddbSend).not.toHaveBeenCalled();
  });

  it("metadata に無い slot は unknown_slot を返すべき", async () => {
    mockedQueryTeamItems.mockResolvedValueOnce([teamRow]);
    const shared = buildShared({
      problemsEndpoints: { "battle-1": [SLOT_FRONTEND] },
      ddbSend: vi.fn(),
    });
    const r = await upsertProblemEndpointOverride(
      shared,
      "key",
      "battle-1",
      "nonexistent",
      "https://x.example.com/",
      "2026-05-12T00:00:00.000Z",
    );
    expect(r.kind).toBe("unknown_slot");
  });

  it("成功時は DDB Put して view を返すべき", async () => {
    mockedQueryTeamItems.mockResolvedValueOnce([teamRow]);
    const ddbSend = vi
      .fn()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        Items: [
          {
            slot: "frontend",
            overrideUrl: "https://new.example.com/",
            tenantId: "tenant-x",
            teamId: "team-y",
            problemId: "battle-1",
            updatedAt: "2026-05-12T00:00:00.000Z",
          },
        ],
      });
    const shared = buildShared({
      problemsEndpoints: { "battle-1": [SLOT_FRONTEND] },
      ddbSend,
    });
    const r = await upsertProblemEndpointOverride(
      shared,
      "key",
      "battle-1",
      "frontend",
      "https://new.example.com/",
      "2026-05-12T00:00:00.000Z",
    );
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") return;
    expect(r.endpoints[0]?.overrideUrl).toBe("https://new.example.com/");
    expect(r.endpoints[0]?.effectiveUrl).toBe("https://new.example.com/");
    // 1 回目: PutCommand
    expect(ddbSend.mock.calls[0]?.[0]).toMatchObject({
      input: expect.objectContaining({
        TableName: "ProblemEndpoints",
        Item: expect.objectContaining({
          PK: "TENANT#tenant-x#TEAM#team-y#PROBLEM#battle-1",
          SK: "SLOT#frontend",
          overrideUrl: "https://new.example.com/",
        }),
      }),
    });
  });
});

describe("deleteProblemEndpointOverride", () => {
  it("metadata に無い slot は unknown_slot を返すべき", async () => {
    mockedQueryTeamItems.mockResolvedValueOnce([teamRow]);
    const shared = buildShared({
      problemsEndpoints: { "battle-1": [SLOT_FRONTEND] },
      ddbSend: vi.fn(),
    });
    const r = await deleteProblemEndpointOverride(shared, "key", "battle-1", "nonexistent");
    expect(r.kind).toBe("unknown_slot");
  });

  it("成功時は DDB DeleteItem を発行して view を返すべき", async () => {
    mockedQueryTeamItems.mockResolvedValueOnce([teamRow]);
    const ddbSend = vi.fn().mockResolvedValueOnce({}).mockResolvedValueOnce({ Items: [] });
    const shared = buildShared({
      problemsEndpoints: { "battle-1": [SLOT_FRONTEND] },
      ddbSend,
    });
    const r = await deleteProblemEndpointOverride(shared, "key", "battle-1", "frontend");
    expect(r.kind).toBe("ok");
    // 1 回目: DeleteCommand
    expect(ddbSend.mock.calls[0]?.[0]).toMatchObject({
      input: expect.objectContaining({
        TableName: "ProblemEndpoints",
        Key: {
          PK: "TENANT#tenant-x#TEAM#team-y#PROBLEM#battle-1",
          SK: "SLOT#frontend",
        },
      }),
    });
  });
});
