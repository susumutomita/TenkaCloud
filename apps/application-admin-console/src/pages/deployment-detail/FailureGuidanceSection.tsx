/**
 * Issue #1350: Deployment failure 時の 「次の手順」 ガイダンス section。
 *
 * 既存の failure_reason Alert は CFn の raw エラーメッセージを表示するだけで、 organizer が
 * 「次に何をすればいいか」 を判断できなかった。 本 section は失敗時に表示し、
 *
 *   1. Retry を試す (= EventDetail の 「失敗分を再実行」 / DeploymentDetail のヘッダー reload)
 *   2. Account を verify し直す (= Competitor Accounts page へリンク)
 *   3. 問題 author に連絡 (= problems repo の issue 起票導線)
 *
 * を順序付きで示す。 これは static (= API call なし) で、 link だけ提示する read-only パネル。
 */

import Box from "@cloudscape-design/components/box";
import Container from "@cloudscape-design/components/container";
import Header from "@cloudscape-design/components/header";
import Link from "@cloudscape-design/components/link";
import SpaceBetween from "@cloudscape-design/components/space-between";
import type { TFn } from "./types";

/**
 * Failure guidance を出すかどうかの判定。 status==FAILED || status==EXPIRED で表示する。
 *
 * EXPIRED は CFn が長時間動かなかった場合の expiry。 organizer 視点では FAILED と同じ次手順
 * (retry / verify / 問い合わせ) で良いので一緒に扱う。
 */
export function shouldShowFailureGuidance(status: string): boolean {
  return status === "FAILED" || status === "EXPIRED";
}

export function FailureGuidanceSection({
  problemId,
  t,
}: {
  readonly problemId: string;
  readonly t: TFn;
}) {
  return (
    <Container
      data-testid="deployment-failure-guidance"
      header={
        <Header variant="h2" description={t("deployment_detail.failure_guidance_description")}>
          {t("deployment_detail.failure_guidance_header")}
        </Header>
      }
    >
      <SpaceBetween size="s">
        <Box>
          <Box variant="awsui-key-label" display="inline">
            1.
          </Box>{" "}
          {t("deployment_detail.failure_guidance_step_retry")}
        </Box>
        <Box>
          <Box variant="awsui-key-label" display="inline">
            2.
          </Box>{" "}
          {t("deployment_detail.failure_guidance_step_verify_pre")}{" "}
          <Link href="/competitor-accounts" data-testid="deployment-failure-guidance-link-accounts">
            {t("deployment_detail.failure_guidance_step_verify_link")}
          </Link>{" "}
          {t("deployment_detail.failure_guidance_step_verify_post")}
        </Box>
        <Box>
          <Box variant="awsui-key-label" display="inline">
            3.
          </Box>{" "}
          {t("deployment_detail.failure_guidance_step_contact_pre")}{" "}
          <Link
            external
            href={`https://github.com/susumutomita/TenkaCloudChallenge/issues/new?title=${encodeURIComponent(
              `[${problemId}] deploy failure`,
            )}`}
            data-testid="deployment-failure-guidance-link-issue"
          >
            {t("deployment_detail.failure_guidance_step_contact_link")}
          </Link>
        </Box>
      </SpaceBetween>
    </Container>
  );
}
