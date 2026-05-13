import { describe, expect, it } from "vitest";
import type { DeploymentSummary } from "../../src/api/deploy-client";
import {
  DEPLOYMENT_LIST_PAGE_SIZE,
  DEPLOYMENT_LIST_POLL_INTERVAL_MS,
  deploymentsChanged,
  EMPTY_DEPLOYMENT_ITEMS,
} from "../../src/utils/deployments";

/**
 * `deploymentsChanged` は polling tick の no-op render guard。`Deployments.tsx` と
 * `ProblemDetail.tsx` 両 page から共有される core ロジック。
 */

const baseRow = (over: Partial<DeploymentSummary> = {}): DeploymentSummary => ({
  jobId: "01HABC",
  problemId: "hello-world",
  tenantId: "tenant-acme",
  awsAccountId: "999999999999",
  region: "ap-northeast-1",
  teamName: "alpha",
  namePrefix: "tc-hello-world-alpha",
  status: "COMPLETE",
  createdAt: "2026-05-05T10:00:00.000Z",
  updatedAt: "2026-05-05T10:01:00.000Z",
  expiresAt: 9_999_999_999,
  ...over,
});

describe("deploymentsChanged", () => {
  it("空 → 空 は false", () => {
    expect(deploymentsChanged([], [])).toBe(false);
  });

  it("長さが異なれば true", () => {
    expect(deploymentsChanged([baseRow()], [])).toBe(true);
    expect(deploymentsChanged([], [baseRow()])).toBe(true);
    expect(deploymentsChanged([baseRow()], [baseRow(), baseRow()])).toBe(true);
  });

  it("同じ shape なら false (= polling 結果が変わっていない)", () => {
    expect(deploymentsChanged([baseRow()], [baseRow()])).toBe(false);
  });

  it("jobId が異なれば true", () => {
    expect(deploymentsChanged([baseRow({ jobId: "A" })], [baseRow({ jobId: "B" })])).toBe(true);
  });

  it("status が変わっていれば true", () => {
    expect(
      deploymentsChanged([baseRow({ status: "PENDING" })], [baseRow({ status: "COMPLETE" })]),
    ).toBe(true);
  });

  it("updatedAt が変わっていれば true", () => {
    expect(
      deploymentsChanged(
        [baseRow({ updatedAt: "2026-05-05T10:00:00.000Z" })],
        [baseRow({ updatedAt: "2026-05-05T10:05:00.000Z" })],
      ),
    ).toBe(true);
  });

  it("displayTeamName の有無 / 値変更で true (= 競技者がチーム名を設定したケース)", () => {
    expect(
      deploymentsChanged(
        [baseRow({ displayTeamName: undefined })],
        [baseRow({ displayTeamName: "わたしのチーム" })],
      ),
    ).toBe(true);
    expect(
      deploymentsChanged(
        [baseRow({ displayTeamName: "before" })],
        [baseRow({ displayTeamName: "after" })],
      ),
    ).toBe(true);
  });

  it("createdAt のみ変わっていても false (= 比較対象外)", () => {
    expect(
      deploymentsChanged(
        [baseRow({ createdAt: "2026-05-05T10:00:00.000Z" })],
        [baseRow({ createdAt: "2026-05-05T11:00:00.000Z" })],
      ),
    ).toBe(false);
  });

  it("score / stackOutputs などの未比較フィールドは false", () => {
    expect(
      deploymentsChanged(
        [baseRow({ stackOutputs: '{"FrontendUrl":"http://a"}' })],
        [baseRow({ stackOutputs: '{"FrontendUrl":"http://b"}' })],
      ),
    ).toBe(false);
  });
});

describe("constants", () => {
  it("page size と polling 間隔の妥当性", () => {
    expect(DEPLOYMENT_LIST_PAGE_SIZE).toBe(50);
    expect(DEPLOYMENT_LIST_POLL_INTERVAL_MS).toBe(30_000);
  });

  it("EMPTY_DEPLOYMENT_ITEMS は frozen で同 reference を再利用 (Table prop 安定化)", () => {
    expect(EMPTY_DEPLOYMENT_ITEMS).toEqual([]);
    expect(EMPTY_DEPLOYMENT_ITEMS).toBe(EMPTY_DEPLOYMENT_ITEMS);
    expect(Object.isFrozen(EMPTY_DEPLOYMENT_ITEMS)).toBe(true);
  });
});
