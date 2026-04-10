/**
 * Tutorial / Rules Page (ルール & チュートリアル)
 *
 * Cloudscape Design System — GameDay のルール、スコアリング、遊び方を解説する静的ページ
 */

'use client';

import Alert from '@cloudscape-design/components/alert';
import Box from '@cloudscape-design/components/box';
import ColumnLayout from '@cloudscape-design/components/column-layout';
import Container from '@cloudscape-design/components/container';
import Header from '@cloudscape-design/components/header';
import Icon from '@cloudscape-design/components/icon';
import SpaceBetween from '@cloudscape-design/components/space-between';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import Table from '@cloudscape-design/components/table';
import '@cloudscape-design/global-styles/index.css';
import { useEffect, useState } from 'react';

interface ScoreRow {
  action: string;
  points: string;
  description: string;
  type: 'positive' | 'negative' | 'neutral';
}

const SCORING_TABLE: ScoreRow[] = [
  {
    action: '初期ポイント',
    points: '10,000',
    description: 'ゲーム開始時にすべてのチームに付与されます',
    type: 'neutral',
  },
  {
    action: '攻撃成功',
    points: '+1,000',
    description: '他チームへの攻撃が成功した時の報酬（同盟チームと分配）',
    type: 'positive',
  },
  {
    action: '攻撃被弾',
    points: '-1,000',
    description: '他チームから攻撃を受けた時のダメージ',
    type: 'negative',
  },
  {
    action: '防御修正',
    points: '+1,500',
    description: '脆弱性を修正して防御に成功した時の報酬',
    type: 'positive',
  },
  {
    action: '攻撃購入',
    points: '-3,000',
    description: '攻撃カタログからアイテムを購入するコスト',
    type: 'negative',
  },
  {
    action: 'ヘルスチェック通過',
    points: '+200',
    description: 'サービスが稼働している場合、定期チェックごとに加算',
    type: 'positive',
  },
  {
    action: 'ヘルスチェック失敗（通常）',
    points: '-100',
    description: 'サービスがダウンしている場合のペナルティ',
    type: 'negative',
  },
  {
    action: 'ヘルスチェック失敗（2x モード）',
    points: '-1,000',
    description: '管理者が 2x ペナルティモードを有効にしている場合',
    type: 'negative',
  },
];

interface Step {
  number: string;
  title: string;
  description: string;
}

const STEPS: Step[] = [
  {
    number: 'Step 1',
    title: 'URL を設定する',
    description:
      'チームの Website URL と API URL を司令部ページで登録してください。ヘルスチェックの対象になります。',
  },
  {
    number: 'Step 2',
    title: '攻撃カタログを見る',
    description:
      '攻撃ページで利用可能な攻撃アイテムを確認し、ポイントを使って購入してください。',
  },
  {
    number: 'Step 3',
    title: '攻撃を実行する',
    description:
      '購入した攻撃を選び、ターゲットチームを指定して実行します。成功すればポイント獲得。',
  },
  {
    number: 'Step 4',
    title: '防御と修正',
    description:
      '防衛ページで受けている攻撃を確認し、ヒントを活用して脆弱性を修正しましょう。',
  },
  {
    number: 'Step 5',
    title: '同盟を結ぶ',
    description:
      '他チームと同盟を組むと、攻撃成功時の報酬を共有できます。戦略的に活用しましょう。',
  },
  {
    number: 'Step 6',
    title: '投票する',
    description: 'イベント終了前に、最も優れたチームに投票してください。',
  },
];

interface Concept {
  name: string;
  description: string;
}

const KEY_CONCEPTS: Concept[] = [
  {
    name: 'Cooldown',
    description:
      '攻撃にはクールダウン期間があります。同じ攻撃を連続して実行することはできません。',
  },
  {
    name: 'Blackout',
    description:
      '管理者がスコアボードを非表示にする期間です。順位が見えない中で戦略を立てる必要があります。',
  },
  {
    name: 'Score Weight',
    description:
      '管理者が 2x ペナルティモードを有効にすると、ヘルスチェック失敗時のペナルティが 10 倍に増加します。',
  },
  {
    name: 'Alliance',
    description:
      '同盟チームがいると、攻撃成功報酬が分配されます。強力なチームと同盟を結ぶことで安定した収入を得られます。',
  },
];

export default function TutorialPage() {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  return (
    <SpaceBetween size="l">
      <Header
        variant="h1"
        description="GameDay の遊び方とルールを確認しましょう"
      >
        ルール &amp; チュートリアル
      </Header>

      {/* Game Overview */}
      <Container header={<Header variant="h2">GameDay とは？</Header>}>
        <SpaceBetween size="s">
          <Box variant="p">
            GameDay
            はチーム対抗のセキュリティ競技です。各チームは自分たちのインフラを守りながら、
            他チームのインフラに攻撃を仕掛けます。攻撃と防御のバランスを取りながら、
            最も高いスコアを獲得したチームが勝利します。
          </Box>
          <Alert type="info">
            攻撃の購入にはポイントが必要です。むやみに攻撃を購入するとポイントが不足するので、
            戦略的に行動しましょう。
          </Alert>
        </SpaceBetween>
      </Container>

      {/* Scoring System */}
      <Container header={<Header variant="h2">スコアリングシステム</Header>}>
        {mounted ? (
          <Table
            columnDefinitions={[
              {
                id: 'action',
                header: 'アクション',
                cell: (item: ScoreRow) => item.action,
                width: 200,
              },
              {
                id: 'points',
                header: 'ポイント',
                cell: (item: ScoreRow) => (
                  <StatusIndicator
                    type={
                      item.type === 'positive'
                        ? 'success'
                        : item.type === 'negative'
                          ? 'error'
                          : 'info'
                    }
                  >
                    {item.points}
                  </StatusIndicator>
                ),
                width: 150,
              },
              {
                id: 'description',
                header: '説明',
                cell: (item: ScoreRow) => item.description,
              },
            ]}
            items={SCORING_TABLE}
            variant="embedded"
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left text-sm">
              <thead>
                <tr className="border-b border-border">
                  <th className="px-4 py-3 font-semibold">アクション</th>
                  <th className="px-4 py-3 font-semibold">ポイント</th>
                  <th className="px-4 py-3 font-semibold">説明</th>
                </tr>
              </thead>
              <tbody>
                {SCORING_TABLE.map((item) => (
                  <tr key={item.action} className="border-b border-border/60">
                    <td className="px-4 py-3">{item.action}</td>
                    <td className="px-4 py-3">{item.points}</td>
                    <td className="px-4 py-3 text-text-secondary">
                      {item.description}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Container>

      {/* How to Play */}
      <Container header={<Header variant="h2">遊び方</Header>}>
        <SpaceBetween size="m">
          {STEPS.map((step) => (
            <ColumnLayout key={step.number} columns={2} variant="text-grid">
              <Box>
                <SpaceBetween direction="horizontal" size="xs">
                  <Icon name="status-positive" />
                  <Box variant="h3">{step.number}</Box>
                </SpaceBetween>
                <Box fontWeight="bold">{step.title}</Box>
              </Box>
              <Box variant="p">{step.description}</Box>
            </ColumnLayout>
          ))}
        </SpaceBetween>
      </Container>

      {/* Key Concepts */}
      <Container header={<Header variant="h2">キーコンセプト</Header>}>
        <ColumnLayout columns={2} variant="text-grid">
          {KEY_CONCEPTS.map((concept) => (
            <SpaceBetween key={concept.name} size="xxs">
              <Box fontWeight="bold">{concept.name}</Box>
              <Box variant="p" color="text-body-secondary">
                {concept.description}
              </Box>
            </SpaceBetween>
          ))}
        </ColumnLayout>
      </Container>
    </SpaceBetween>
  );
}
