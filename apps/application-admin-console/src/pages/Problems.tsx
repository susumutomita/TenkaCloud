import Badge from "@cloudscape-design/components/badge";
import Box from "@cloudscape-design/components/box";
import Cards from "@cloudscape-design/components/cards";
import Header from "@cloudscape-design/components/header";
import Link from "@cloudscape-design/components/link";
import SpaceBetween from "@cloudscape-design/components/space-between";
import { useNavigate } from "react-router";
import { listProblemSummaries, type ProblemSummary } from "../data/problems";

const DIFFICULTY_LABEL: Record<ProblemSummary["difficulty"], string> = {
  1: "入門",
  2: "初級",
  3: "中級",
  4: "上級",
  5: "エキスパート",
};

const STATUS_BADGE_COLOR: Record<ProblemSummary["status"], "green" | "blue" | "grey"> = {
  ready: "green",
  draft: "blue",
  deprecated: "grey",
};

const STATUS_LABEL: Record<ProblemSummary["status"], string> = {
  ready: "公開中",
  draft: "下書き",
  deprecated: "停止予定",
};

/**
 * 問題一覧ページ。Cloudscape Cards で 1 件ずつカード表示する。
 * クリックすると /problems/:id へ遷移して詳細 + Deploy ボタン。
 */
export function ProblemsPage() {
  const navigate = useNavigate();
  const problems = listProblemSummaries();

  return (
    <SpaceBetween size="l">
      <Header
        variant="h1"
        description="競技アカウントへデプロイ可能な問題の一覧。デプロイすると参加者にプレイ環境が払い出されます。"
      >
        問題カタログ
      </Header>

      <Cards
        items={[...problems]}
        cardDefinition={{
          header: (item) => (
            <Link
              fontSize="heading-m"
              onFollow={(e) => {
                e.preventDefault();
                navigate(`/problems/${encodeURIComponent(item.id)}`);
              }}
              href={`/problems/${encodeURIComponent(item.id)}`}
            >
              {item.name}
            </Link>
          ),
          sections: [
            {
              id: "badges",
              content: (item) => (
                <SpaceBetween direction="horizontal" size="xs">
                  <Badge color={item.category === "Battle" ? "red" : "blue"}>{item.category}</Badge>
                  <Badge color={STATUS_BADGE_COLOR[item.status]}>{STATUS_LABEL[item.status]}</Badge>
                  <Badge color="grey">難易度: {DIFFICULTY_LABEL[item.difficulty]}</Badge>
                  <Badge color="grey">想定時間: {item.estimatedDuration}</Badge>
                </SpaceBetween>
              ),
            },
            {
              id: "description",
              content: (item) => <Box variant="p">{item.shortDescription}</Box>,
            },
            {
              id: "tags",
              header: "タグ",
              content: (item) => (
                <SpaceBetween direction="horizontal" size="xxs">
                  {item.tags.map((t) => (
                    <Badge key={t}>{t}</Badge>
                  ))}
                </SpaceBetween>
              ),
            },
          ],
        }}
        cardsPerRow={[{ cards: 1 }, { minWidth: 700, cards: 2 }]}
        empty={
          <Box textAlign="center" color="inherit" padding="xxl">
            問題がまだ登録されていません。
          </Box>
        }
      />
    </SpaceBetween>
  );
}
