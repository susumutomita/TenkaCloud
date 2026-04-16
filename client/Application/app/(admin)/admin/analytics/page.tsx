/**
 * Admin Analytics Page
 *
 * Cloudscape Design System — 分析ダッシュボード
 */

'use client';

import BarChart from '@cloudscape-design/components/bar-chart';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import ColumnLayout from '@cloudscape-design/components/column-layout';
import Container from '@cloudscape-design/components/container';
import Header from '@cloudscape-design/components/header';
import LineChart from '@cloudscape-design/components/line-chart';
import PieChart from '@cloudscape-design/components/pie-chart';
import Select from '@cloudscape-design/components/select';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Spinner from '@cloudscape-design/components/spinner';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import Table from '@cloudscape-design/components/table';
import Tabs from '@cloudscape-design/components/tabs';
import type { SelectProps } from '@cloudscape-design/components/select';
import { useCallback, useEffect, useState } from 'react';
import { getAnalyticsData } from '@/lib/api/admin-analytics';
import type { AnalyticsData } from '@/lib/api/admin-analytics';

/**
 * 期間フィルタオプション
 */
const periodOptions: SelectProps.Option[] = [
  { label: '全期間', value: 'all' },
  { label: '過去30日', value: '30d' },
  { label: '過去90日', value: '90d' },
  { label: '過去1年', value: '1y' },
];

/**
 * CSV エクスポート関数
 */
function exportAnalyticsCsv(data: AnalyticsData): void {
  const lines: string[] = [];

  // 概要セクション
  lines.push('セクション,項目,値');
  lines.push(`概要,総イベント数,${data.overview.totalEvents}`);
  lines.push(`概要,総参加者数,${data.overview.totalParticipants}`);
  lines.push(`概要,平均スコア,${data.overview.avgScore}`);
  lines.push(`概要,完了率,${data.overview.completionRate}%`);
  lines.push('');

  // イベントタイムライン
  lines.push('月,イベント数,参加者数');
  for (const entry of data.eventTimeline) {
    lines.push(`${entry.month},${entry.eventCount},${entry.participantCount}`);
  }
  lines.push('');

  // スコア分布
  lines.push('カテゴリ,チーム数');
  for (const entry of data.scoreDistribution) {
    lines.push(`${entry.category},${entry.value}`);
  }
  lines.push('');

  // チーム比較
  lines.push('チーム名,スコア,メンバー数,完了率');
  for (const team of data.teamComparison) {
    lines.push(
      `${team.teamName},${team.score},${team.memberCount},${team.completionRate}%`,
    );
  }

  const csvContent = lines.join('\n');
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'analytics.csv';
  link.click();
  URL.revokeObjectURL(url);
}

export default function AdminAnalyticsPage() {
  const [data, setData] = useState<AnalyticsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [selectedPeriod, setSelectedPeriod] =
    useState<SelectProps.Option | null>(periodOptions[0]);

  const fetchData = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const analyticsData = await getAnalyticsData();
      setData(analyticsData);
    } catch (err) {
      setError(
        err instanceof Error
          ? err
          : new Error('分析データの読み込みに失敗しました'),
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  if (loading) {
    return (
      <Container>
        <Box textAlign="center" padding="l">
          <Spinner size="large" />
        </Box>
      </Container>
    );
  }

  if (error) {
    return (
      <Container>
        <SpaceBetween size="s" direction="vertical" alignItems="center">
          <StatusIndicator type="error">{error.message}</StatusIndicator>
          <Button onClick={fetchData}>再試行</Button>
        </SpaceBetween>
      </Container>
    );
  }

  if (!data) {
    return null;
  }

  return (
    <SpaceBetween size="l">
      <Header
        variant="h1"
        actions={
          <SpaceBetween size="s" direction="horizontal">
            <Select
              selectedOption={selectedPeriod}
              onChange={({ detail }) =>
                setSelectedPeriod(detail.selectedOption)
              }
              options={periodOptions}
              placeholder="期間を選択"
            />
            <Button
              iconName="download"
              onClick={() => exportAnalyticsCsv(data)}
            >
              CSV エクスポート
            </Button>
          </SpaceBetween>
        }
      >
        分析ダッシュボード
      </Header>

      <Tabs
        tabs={[
          {
            label: '概要',
            id: 'overview',
            content: (
              <SpaceBetween size="l">
                <ColumnLayout columns={4} variant="text-grid">
                  <Container>
                    <SpaceBetween size="xs">
                      <Box variant="awsui-key-label">総イベント数</Box>
                      <Box variant="awsui-value-large">
                        {data.overview.totalEvents.toLocaleString()}
                      </Box>
                    </SpaceBetween>
                  </Container>
                  <Container>
                    <SpaceBetween size="xs">
                      <Box variant="awsui-key-label">総参加者数</Box>
                      <Box variant="awsui-value-large">
                        {data.overview.totalParticipants.toLocaleString()}
                      </Box>
                    </SpaceBetween>
                  </Container>
                  <Container>
                    <SpaceBetween size="xs">
                      <Box variant="awsui-key-label">平均スコア</Box>
                      <Box variant="awsui-value-large">
                        {data.overview.avgScore}
                      </Box>
                    </SpaceBetween>
                  </Container>
                  <Container>
                    <SpaceBetween size="xs">
                      <Box variant="awsui-key-label">完了率</Box>
                      <Box variant="awsui-value-large">
                        {data.overview.completionRate}%
                      </Box>
                    </SpaceBetween>
                  </Container>
                </ColumnLayout>
              </SpaceBetween>
            ),
          },
          {
            label: 'イベント分析',
            id: 'events',
            content: (
              <SpaceBetween size="l">
                <Container
                  header={<Header variant="h2">月別イベント数</Header>}
                >
                  <BarChart
                    series={[
                      {
                        title: 'イベント数',
                        type: 'bar',
                        data: data.eventTimeline.map((entry) => ({
                          x: entry.month,
                          y: entry.eventCount,
                        })),
                      },
                    ]}
                    xDomain={data.eventTimeline.map((e) => e.month)}
                    yDomain={[
                      0,
                      Math.max(
                        ...data.eventTimeline.map((e) => e.eventCount),
                        1,
                      ),
                    ]}
                    xTitle="月"
                    yTitle="イベント数"
                    xScaleType="categorical"
                    empty={<Box textAlign="center">データがありません</Box>}
                    noMatch={
                      <Box textAlign="center">一致するデータがありません</Box>
                    }
                  />
                </Container>
                <Container
                  header={<Header variant="h2">月別参加者数推移</Header>}
                >
                  <LineChart
                    series={[
                      {
                        title: '参加者数',
                        type: 'line',
                        data: data.eventTimeline.map((entry) => ({
                          x: entry.month,
                          y: entry.participantCount,
                        })),
                      },
                    ]}
                    xDomain={data.eventTimeline.map((e) => e.month)}
                    yDomain={[
                      0,
                      Math.max(
                        ...data.eventTimeline.map((e) => e.participantCount),
                        1,
                      ),
                    ]}
                    xTitle="月"
                    yTitle="参加者数"
                    xScaleType="categorical"
                    empty={<Box textAlign="center">データがありません</Box>}
                    noMatch={
                      <Box textAlign="center">一致するデータがありません</Box>
                    }
                  />
                </Container>
              </SpaceBetween>
            ),
          },
          {
            label: 'スコア分布',
            id: 'scores',
            content: (
              <Container header={<Header variant="h2">スコア分布</Header>}>
                <PieChart
                  data={data.scoreDistribution.map((entry) => ({
                    title: entry.category,
                    value: entry.value,
                  }))}
                  detailPopoverContent={(datum) => [
                    { key: 'チーム数', value: datum.value },
                  ]}
                  segmentDescription={(datum) => `${datum.value} チーム`}
                  empty={<Box textAlign="center">データがありません</Box>}
                  noMatch={
                    <Box textAlign="center">一致するデータがありません</Box>
                  }
                />
              </Container>
            ),
          },
          {
            label: 'チーム比較',
            id: 'teams',
            content: (
              <Container
                header={<Header variant="h2">チームパフォーマンス</Header>}
              >
                <Table
                  columnDefinitions={[
                    {
                      id: 'teamName',
                      header: 'チーム名',
                      cell: (item) => item.teamName,
                      sortingField: 'teamName',
                    },
                    {
                      id: 'score',
                      header: 'スコア',
                      cell: (item) => item.score,
                      sortingField: 'score',
                    },
                    {
                      id: 'memberCount',
                      header: 'メンバー数',
                      cell: (item) => item.memberCount,
                      sortingField: 'memberCount',
                    },
                    {
                      id: 'completionRate',
                      header: '完了率',
                      cell: (item) => `${item.completionRate}%`,
                      sortingField: 'completionRate',
                    },
                  ]}
                  items={data.teamComparison}
                  sortingDisabled
                  variant="embedded"
                  empty={<Box textAlign="center">チームデータがありません</Box>}
                />
              </Container>
            ),
          },
        ]}
      />
    </SpaceBetween>
  );
}
