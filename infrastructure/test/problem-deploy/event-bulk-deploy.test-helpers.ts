/**
 * Shared fixtures and DDB mock factory for `event-bulk-deploy-*.test.ts`.
 *
 * Phase 2.2 (Issue #459): bulk-deploy が CompetitorAccounts table を引いて verified=true
 * のみ許可するようになった。test helper 側で「verified account の集合」を default で
 * 「全 awsAccountId を許可」に倒し、unverified を試す test だけ override する形にする。
 *
 * 既存 test の `mockResolvedValueOnce` で順次 Event Get / Teams Query / 既存 deployments
 * Query / TransactWrite / UpdateCommand を返す順序は保てない (CompetitorAccounts Get が
 * Promise.all で並列に挟まる)。helper で `mockImplementation` を 1 度だけ仕掛け、
 * Command 種別 + TableName で振り分ける形に切り替える。
 *
 * Issue #1233: 856-line / 115-expect monolith を scenario ごとに分割する際に、
 * 共通 setup を test-helpers として抽出。
 */
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { vi } from "vitest";
import type { EventSharedResources } from "../../lib/problem-deploy/handlers/event-handler/shared";
import { makeTestControlDataRuntime } from "./control-data/runtime.test-helpers";

export const NOW_MS = 1_700_000_000_000;

const VERIFIED_ALL = Symbol("verified-all");
export type VerifiedSet = Set<string> | typeof VERIFIED_ALL;
export const VERIFIED_ALL_ACCOUNTS: VerifiedSet = VERIFIED_ALL;

export function buildShared(
  over: Partial<EventSharedResources> = {},
  verifiedAccounts: VerifiedSet = VERIFIED_ALL,
): {
  shared: EventSharedResources;
  ddbSend: ReturnType<typeof vi.fn>;
  eventsSend: ReturnType<typeof vi.fn>;
  setVerifiedAccounts: (next: VerifiedSet) => void;
} {
  const ddbSend = vi.fn();
  const eventsSend = vi.fn();
  let verified = verifiedAccounts;
  // CompetitorAccounts Get を `mockResolvedValueOnce` queue とは別経路で処理する。
  // ddbSend の queue が空 or 一致しない場合は CompetitorAccounts 用の verified record を返す。
  const originalSend = ddbSend;
  const wrappedSend = vi.fn(async (cmd: unknown) => {
    if (cmd instanceof GetCommand) {
      const tn = (cmd as GetCommand).input.TableName;
      if (tn === "TestCompetitorAccounts") {
        const key = (cmd as GetCommand).input.Key ?? {};
        const sk = String(key.SK ?? "");
        const awsAccountId = sk.replace(/^ACCOUNT#/, "");
        const isVerified = verified === VERIFIED_ALL || verified.has(awsAccountId);
        if (!isVerified) return { Item: undefined };
        return {
          Item: {
            PK: key.PK,
            SK: key.SK,
            awsAccountId,
            region: "ap-northeast-1",
            competitorRoleName: "TenkaCloud-CompetitorDeploy-Role",
            verified: true,
          },
        };
      }
    }
    return originalSend(cmd);
  });
  const shared: EventSharedResources = {
    runtime: makeTestControlDataRuntime(),
    eventsTableName: "TestEvents",
    teamsTableName: "TestTeams",
    deploymentsTableName: "TestDeployments",
    competitorAccountsTableName: "TestCompetitorAccounts",
    eventBusName: "test-bus",
    env: "development",
    ddb: { send: wrappedSend } as unknown as EventSharedResources["ddb"],
    events: { send: eventsSend } as unknown as EventSharedResources["events"],
    problemsCatalog: {
      "hello-world": "problems/challenges/hello-world",
      "hello-world-battle": "problems/battles/hello-world-battle",
    },
    // [Issue #3169] Declared explicitly rather than left off: neither fixture
    // problem declares a coordination state budget, so the capacity preflight
    // has nothing to check and every suite here keeps its existing behaviour.
    // A suite that wants the preflight to fire overrides this through `over`.
    problemsCoordination: {},
    ...over,
  };
  return {
    shared,
    ddbSend,
    eventsSend,
    setVerifiedAccounts: (next) => {
      verified = next;
    },
  };
}

export const sampleEvent = (over: Record<string, unknown> = {}) => ({
  eventId: "EV1",
  tenantId: "tenant-acme",
  name: "Spring 2026",
  status: "DRAFT",
  problems: [
    {
      problemId: "hello-world",
      defaultAwsAccountId: "999999999999",
      defaultRegion: "ap-northeast-1",
    },
    {
      problemId: "hello-world-battle",
      defaultAwsAccountId: "999999999999",
      defaultRegion: "us-east-1",
    },
  ],
  ...over,
});

export const sampleTeams = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    eventId: "EV1",
    teamId: `T${i + 1}`,
    tenantId: "tenant-acme",
    internalSlug: `team-${i + 1}`,
    teamLoginKey: `key-${i + 1}`,
    // #528: 各 team に独自 awsAccountId。test は 12 桁数字で 111... / 222... / ... と
    // pad して別 account を pin する。fallback test では明示的に外す。
    awsAccountId: `${i + 1}`.repeat(12).slice(0, 12),
  }));
