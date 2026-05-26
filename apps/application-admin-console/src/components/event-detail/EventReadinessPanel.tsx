/**
 * Issue #1350: Event-day organizer readiness panel.
 *
 * Overview tab の冒頭に表示される一目で 「準備完了か」 を判定するパネル。 4 つの check item を
 * チェックボックス風に並べる:
 *   1. 開始時刻 (startsAt) 設定済
 *   2. 問題 deploy 済 (= completeCount === totalDeployCount && totalDeployCount > 0)
 *   3. チーム配布済 (= 全 team に teamLoginKey or AWS Account が紐付いている)
 *   4. 通知の準備 (= DRAFT 以外 = 通知送信が unlock されている)
 *
 * 全 check が ✓ になると 「準備完了」 大 badge を表示する (= 運営者に「これで配信できる」 安心感)。
 *
 * 実装方針:
 *   - 純粋関数 `computeReadinessChecks` で項目を算出 (テスト可能)。
 *   - 表示は Cloudscape `Container` + `Box` で軽量に。 個別 panel 化はしない (Overview の冒頭 1 セクション)。
 *   - すべての status (DRAFT / ENDED / 等) で render される。 不要な item は単に未チェックとして並べる。
 */

import Badge from "@cloudscape-design/components/badge";
import Box from "@cloudscape-design/components/box";
import Container from "@cloudscape-design/components/container";
import Header from "@cloudscape-design/components/header";
import SpaceBetween from "@cloudscape-design/components/space-between";
import StatusIndicator from "@cloudscape-design/components/status-indicator";
import type { EventDetail } from "../../api/events-client";

type Translate = (key: string, params?: Readonly<Record<string, string | number>>) => string;

export interface ReadinessCheck {
  /** stable key (= test 用 / data-testid 接尾辞) */
  readonly key: "starts_at" | "deploy" | "teams" | "notifications";
  readonly ok: boolean;
  /** 未達のとき warning と info の区別。 通知未送信は warning 扱い、 deploy 未完了は info。 */
  readonly severity: "warning" | "info";
}

export interface ReadinessInput {
  readonly detail: EventDetail;
  readonly completeCount: number;
  readonly totalDeployCount: number;
}

/**
 * Event detail と deployment counts から 4 つの readiness check 結果を返す純粋関数。
 *
 * 「starts_at」: detail.startsAt が文字列として存在する
 * 「deploy」: totalDeployCount > 0 かつ completeCount === totalDeployCount
 * 「teams」: 全 team が awsAccountId を持つ (= deploy 経路が成立する)
 * 「notifications」: detail.status !== "DRAFT" (= 通知送信が unlock されている)
 */
export function computeReadinessChecks({
  detail,
  completeCount,
  totalDeployCount,
}: ReadinessInput): readonly ReadinessCheck[] {
  const startsAtOk = typeof detail.startsAt === "string" && detail.startsAt.length > 0;
  const deployOk = totalDeployCount > 0 && completeCount === totalDeployCount;
  const teamsOk = detail.teams.length > 0 && detail.teams.every((team) => !!team.awsAccountId);
  // 通知が unlocked = DRAFT を抜けている。 TEARDOWN / ARCHIVED は終わった Event なので
  // readiness 判定上は warning にせず ok 扱い (= 終了済 event の readiness を毎回 warning と
  // 表示すると noise)。
  const notificationsOk =
    detail.status !== "DRAFT" &&
    detail.status !== "TEARDOWN" &&
    detail.status !== "ARCHIVED" &&
    detail.status !== "DEPLOYING";
  return [
    { key: "starts_at", ok: startsAtOk, severity: "info" },
    { key: "deploy", ok: deployOk, severity: "info" },
    { key: "teams", ok: teamsOk, severity: "info" },
    { key: "notifications", ok: notificationsOk, severity: "warning" },
  ];
}

/** Readiness panel の本体。 4 つの check + 全 ✓ で 「準備完了」 大 badge。 */
export function EventReadinessPanel({
  completeCount,
  detail,
  t,
  totalDeployCount,
}: {
  readonly completeCount: number;
  readonly detail: EventDetail;
  readonly t: Translate;
  readonly totalDeployCount: number;
}) {
  const checks = computeReadinessChecks({ detail, completeCount, totalDeployCount });
  const allReady = checks.every((c) => c.ok);
  return (
    <Container
      data-testid="event-readiness-panel"
      header={
        <Header
          variant="h2"
          description={t("event_detail.readiness_description")}
          actions={
            allReady ? (
              <Badge color="green" data-testid="event-readiness-ready-badge">
                {t("event_detail.readiness_all_ready")}
              </Badge>
            ) : (
              <Badge color="grey" data-testid="event-readiness-pending-badge">
                {t("event_detail.readiness_pending", {
                  done: checks.filter((c) => c.ok).length,
                  total: checks.length,
                })}
              </Badge>
            )
          }
        >
          {t("event_detail.readiness_header")}
        </Header>
      }
    >
      <SpaceBetween size="xs">
        {checks.map((check) => {
          const labelKey = `event_detail.readiness_item_${check.key}_label`;
          const detailKey = `event_detail.readiness_item_${check.key}_${check.ok ? "done" : "todo"}`;
          // pending は warning vs info で見え方を変える (= 通知未送信は警告色)。
          const type = check.ok
            ? ("success" as const)
            : check.severity === "warning"
              ? ("warning" as const)
              : ("pending" as const);
          return (
            <Box key={check.key}>
              <StatusIndicator
                type={type}
                data-testid={`event-readiness-item-${check.key}-${check.ok ? "done" : "todo"}`}
              >
                {t(labelKey)}
              </StatusIndicator>
              <Box variant="small" color="text-body-secondary" margin={{ left: "l" }}>
                {t(detailKey)}
              </Box>
            </Box>
          );
        })}
      </SpaceBetween>
    </Container>
  );
}
