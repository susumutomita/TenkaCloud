import Badge from "@cloudscape-design/components/badge";
import type * as React from "react";
import type { ParticipantScoringInfo } from "../api/portal-client";
import { findProblemMetadata } from "../data/problems";
import { categoryOf } from "../lib/category";
import type { TFn } from "./Quests.submission-state";

export function categoryBadge(
  scoring: ParticipantScoringInfo | undefined,
  uncategorizedLabel: string,
) {
  const cat = categoryOf(scoring);
  if (cat === "battle") return <Badge color="red">Battle</Badge>;
  if (cat === "challenge") return <Badge color="blue">Challenge</Badge>;
  return <Badge color="grey">{uncategorizedLabel}</Badge>;
}

/**
 * issue #4 (audit table): 一覧カードに見せるのは **タイトル / 難易度 / カテゴリ + 解答状態 icon** だけ。
 * Score / Region / NamePrefix / ParticipantViewerRoleArn / ParameterName / AWS Console ボタンは
 * 詳細画面に集約。 大会の戦略決定はカードを並べて 「どれをやるか」 を決める用途なので、 過剰な
 * 詳細を出すと逆に「どれを見ればよいかわからない」 を生む (= image #35 の指摘)。
 */
/**
 * Issue #2189: the quest list card was showing the raw problem id instead of
 * its display name (the detail screen already shows the name). Falls back to
 * the id when the catalog has no metadata for it (e.g. a stale/removed problem).
 */
export function questCardTitle(problemId: string): string {
  return findProblemMetadata(problemId)?.name ?? problemId;
}

export function difficultyBadge(problemId: string, t: TFn): React.ReactElement | null {
  const meta = findProblemMetadata(problemId);
  if (!meta) return null;
  return (
    <Badge color="grey">
      {t("quests.difficulty_label", { label: t(`quests.difficulty_${meta.difficulty}`) })}
    </Badge>
  );
}

/**
 * [TenkaCloudChallenge #402] local play では起動できない問題に印を付ける。
 *
 * カタログからは消さない — #2926 が「学習パスの先が見えること」を理由に AWS 専用問題を
 * 意図的に含めている。ただし印が無いと、開いて行き止まりに当たるまで分からなかった。
 *
 * `localPlayable !== false` で判定する。`undefined` は「判定していない」(AWS mode の投影は
 * `local/` を見られない) であって「起動できない」ではないので、AWS mode で全問に印が付かない。
 */
export function awsOnlyBadge(problemId: string, t: TFn): React.ReactElement | null {
  if (findProblemMetadata(problemId)?.localPlayable !== false) return null;
  return <Badge color="severity-medium">{t("quests.aws_only_badge")}</Badge>;
}
