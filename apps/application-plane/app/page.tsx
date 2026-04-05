'use client';

import Badge from '@cloudscape-design/components/badge';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import ColumnLayout from '@cloudscape-design/components/column-layout';
import Container from '@cloudscape-design/components/container';
import ContentLayout from '@cloudscape-design/components/content-layout';
import Header from '@cloudscape-design/components/header';
import SpaceBetween from '@cloudscape-design/components/space-between';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import '@cloudscape-design/global-styles/index.css';
import { Header as AppHeader } from '@/components/layout';

const stats = [
  { value: '3+', label: 'Cloud Providers' },
  { value: '100+', label: 'Problems' },
  { value: '24/7', label: 'Auto Grading' },
  { value: '1000+', label: 'Engineers' },
];

const features = [
  {
    title: 'マルチクラウド対応',
    description: 'AWS / GCP / Azure の実環境で腕試し',
    status: 'info' as const,
  },
  {
    title: '実践的な課題',
    description: 'インフラ構築・セキュリティ・コスト最適化',
    status: 'success' as const,
  },
  {
    title: 'チーム or 個人',
    description: '仲間と協力、またはソロで挑戦',
    status: 'pending' as const,
  },
  {
    title: 'リアルタイム採点',
    description: '自動採点で即座にフィードバック',
    status: 'success' as const,
  },
];

const eventTypes = [
  {
    name: 'GameDay',
    description:
      '障害対応シミュレーション。本番さながらのインシデント対応を体験',
    tags: ['Incident Response', 'Troubleshooting'],
    color: 'blue' as const,
  },
  {
    name: 'Jam',
    description:
      'セキュリティ・最適化課題。制限時間内に課題を解いてスコアを競う',
    tags: ['Security', 'Optimization'],
    color: 'green' as const,
  },
];

export default function Home(): React.JSX.Element {
  return (
    <div className="min-h-screen bg-surface-0">
      <AppHeader />
      <div className="awsui-dark-mode">
        <ContentLayout
          header={
            <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
              <SpaceBetween size="l">
                <Box variant="small" color="text-status-info">
                  Cloud Competition Platform
                </Box>
                <SpaceBetween size="xs">
                  <Box variant="h1" fontSize="display-l" fontWeight="bold">
                    クラウドスキルを競い
                  </Box>
                  <Box
                    variant="h1"
                    fontSize="display-l"
                    fontWeight="bold"
                    color="text-status-info"
                  >
                    高め合う場所
                  </Box>
                </SpaceBetween>
                <Box
                  variant="p"
                  color="text-body-secondary"
                  fontSize="heading-s"
                >
                  AWS・GCP・Azure
                  の実環境で、インフラ構築・障害対応・セキュリティの腕を競う。
                  最強のクラウドエンジニアを目指せ。
                </Box>
                <SpaceBetween direction="horizontal" size="s">
                  <Button
                    variant="primary"
                    iconName="angle-right-double"
                    iconAlign="right"
                    href="/events"
                  >
                    イベントを探す
                  </Button>
                  <Button href="/rankings">ランキングを見る</Button>
                </SpaceBetween>
              </SpaceBetween>
            </div>
          }
        >
          <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 pb-12">
            <SpaceBetween size="xxl">
              {/* Stats */}
              <Container
                header={<Header variant="h2">プラットフォーム実績</Header>}
              >
                <ColumnLayout columns={4} variant="text-grid">
                  {stats.map((stat) => (
                    <div key={stat.label}>
                      <Box
                        fontSize="display-l"
                        fontWeight="bold"
                        textAlign="center"
                        color="text-status-info"
                      >
                        {stat.value}
                      </Box>
                      <Box
                        color="text-body-secondary"
                        textAlign="center"
                        variant="small"
                      >
                        {stat.label}
                      </Box>
                    </div>
                  ))}
                </ColumnLayout>
              </Container>

              {/* Features */}
              <Container
                header={
                  <Header
                    variant="h2"
                    description="クラウドエンジニアのための競技プラットフォーム"
                  >
                    TenkaCloud とは
                  </Header>
                }
              >
                <ColumnLayout columns={4} variant="text-grid">
                  {features.map((feature) => (
                    <SpaceBetween key={feature.title} size="xs">
                      <StatusIndicator type={feature.status}>
                        {feature.title}
                      </StatusIndicator>
                      <Box color="text-body-secondary" variant="small">
                        {feature.description}
                      </Box>
                    </SpaceBetween>
                  ))}
                </ColumnLayout>
              </Container>

              {/* Event Types */}
              <Container
                header={
                  <Header
                    variant="h2"
                    description="目的に合わせて、2種類のイベント形式から選択"
                    actions={
                      <Button variant="link" href="/events">
                        すべてのイベント →
                      </Button>
                    }
                  >
                    イベントタイプ
                  </Header>
                }
              >
                <ColumnLayout columns={2}>
                  {eventTypes.map((type) => (
                    <Container key={type.name}>
                      <SpaceBetween size="s">
                        <SpaceBetween direction="horizontal" size="xs">
                          {type.tags.map((tag) => (
                            <Badge key={tag} color={type.color}>
                              {tag}
                            </Badge>
                          ))}
                        </SpaceBetween>
                        <Box
                          variant="h3"
                          fontSize="heading-l"
                          fontWeight="bold"
                        >
                          {type.name}
                        </Box>
                        <Box color="text-body-secondary" variant="small">
                          {type.description}
                        </Box>
                        <Button variant="link" href="/events">
                          イベントを見る →
                        </Button>
                      </SpaceBetween>
                    </Container>
                  ))}
                </ColumnLayout>
              </Container>

              {/* CTA */}
              <Container>
                <Box textAlign="center" padding="l">
                  <SpaceBetween size="m">
                    <Box variant="h2" fontSize="heading-xl" fontWeight="bold">
                      まずは観戦してみよう
                    </Box>
                    <Box color="text-body-secondary" variant="p">
                      アカウント不要で、開催中のイベントやランキングを閲覧できます。
                      どんな課題があるのか、どんな人が参加しているのか、まずはチェック。
                    </Box>
                    <SpaceBetween direction="horizontal" size="s">
                      <Button variant="primary" href="/events">
                        イベント一覧を見る
                      </Button>
                      <Button href="/rankings">ランキングを見る</Button>
                    </SpaceBetween>
                  </SpaceBetween>
                </Box>
              </Container>
            </SpaceBetween>
          </div>
        </ContentLayout>

        <footer className="py-8 border-t border-border">
          <Box textAlign="center" color="text-body-secondary" variant="small">
            TenkaCloud - The Open Cloud Battle Arena
          </Box>
        </footer>
      </div>
    </div>
  );
}
