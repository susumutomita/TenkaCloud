/**
 * Admin Marketplace Page
 *
 * Cloudscape Design System - 問題マーケットプレイス
 * 問題の検索と選択
 */

'use client';

import { useCallback, useEffect, useState } from 'react';
import Badge from '@cloudscape-design/components/badge';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import Cards from '@cloudscape-design/components/cards';
import ColumnLayout from '@cloudscape-design/components/column-layout';
import Container from '@cloudscape-design/components/container';
import Header from '@cloudscape-design/components/header';
import Input from '@cloudscape-design/components/input';
import Select from '@cloudscape-design/components/select';
import type { SelectProps } from '@cloudscape-design/components/select';
import SpaceBetween from '@cloudscape-design/components/space-between';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import '@cloudscape-design/global-styles/index.css';
import { getProblems } from '@/lib/api/admin-problems';
import type { AdminProblem } from '@/lib/api/admin-types';
import type { DifficultyLevel, ProblemCategory } from '@/lib/api/types';

interface MarketplaceProblem {
  id: string;
  title: string;
  description: string;
  type: AdminProblem['type'];
  category: ProblemCategory;
  difficulty: DifficultyLevel;
  cloudProvider: string;
  estimatedTimeMinutes: number;
  authorName: string;
  rating: number;
  usageCount: number;
  tags: string[];
  createdAt: string;
}

function toMarketplaceProblem(p: AdminProblem): MarketplaceProblem {
  return {
    id: p.id,
    title: p.title,
    description: p.description.overview,
    type: p.type,
    category: p.category,
    difficulty: p.difficulty,
    cloudProvider: p.deployment.providers[0] ?? 'aws',
    estimatedTimeMinutes: p.description.estimatedTime ?? 0,
    authorName: p.metadata.author,
    rating: 0,
    usageCount: 0,
    tags: p.metadata.tags,
    createdAt: p.metadata.createdAt ?? p.createdAt ?? '',
  };
}

const categoryOptions: SelectProps.Option[] = [
  { value: '', label: 'すべて' },
  { value: 'architecture', label: 'アーキテクチャ' },
  { value: 'security', label: 'セキュリティ' },
  { value: 'cost', label: 'コスト最適化' },
  { value: 'performance', label: 'パフォーマンス' },
  { value: 'reliability', label: '信頼性' },
  { value: 'operations', label: '運用' },
];

const difficultyOptions: SelectProps.Option[] = [
  { value: '', label: 'すべて' },
  { value: 'easy', label: '初級' },
  { value: 'medium', label: '中級' },
  { value: 'hard', label: '上級' },
  { value: 'expert', label: 'エキスパート' },
];

const cloudProviderOptions: SelectProps.Option[] = [
  { value: '', label: 'すべて' },
  { value: 'aws', label: 'AWS' },
  { value: 'gcp', label: 'Google Cloud' },
  { value: 'azure', label: 'Azure' },
  { value: 'local', label: 'LocalStack' },
];

function getDifficultyBadgeColor(
  difficulty: DifficultyLevel
): 'green' | 'blue' | 'red' {
  switch (difficulty) {
    case 'easy':
      return 'green';
    case 'medium':
      return 'blue';
    case 'hard':
      return 'red';
    case 'expert':
      return 'red';
    default:
      return 'blue';
  }
}

function getDifficultyLabel(difficulty: DifficultyLevel): string {
  switch (difficulty) {
    case 'easy':
      return '初級';
    case 'medium':
      return '中級';
    case 'hard':
      return '上級';
    case 'expert':
      return 'エキスパート';
    default:
      return difficulty;
  }
}

function getCategoryLabel(category: ProblemCategory): string {
  switch (category) {
    case 'architecture':
      return 'アーキテクチャ';
    case 'security':
      return 'セキュリティ';
    case 'cost':
      return 'コスト最適化';
    case 'performance':
      return 'パフォーマンス';
    case 'reliability':
      return '信頼性';
    case 'operations':
      return '運用';
    default:
      return category;
  }
}

function getCategoryIcon(category: ProblemCategory): string {
  switch (category) {
    case 'architecture':
      return '\u{1F3D7}\u{FE0F}';
    case 'security':
      return '\u{1F512}';
    case 'cost':
      return '\u{1F4B0}';
    case 'performance':
      return '\u26A1';
    case 'reliability':
      return '\u{1F6E1}\u{FE0F}';
    case 'operations':
      return '\u{1F527}';
    default:
      return '\u{1F4E6}';
  }
}

export default function AdminMarketplacePage() {
  const [problems, setProblems] = useState<MarketplaceProblem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] =
    useState<SelectProps.Option | null>(categoryOptions[0]);
  const [selectedDifficulty, setSelectedDifficulty] =
    useState<SelectProps.Option | null>(difficultyOptions[0]);
  const [selectedCloudProvider, setSelectedCloudProvider] =
    useState<SelectProps.Option | null>(cloudProviderOptions[0]);

  const fetchProblems = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await getProblems();
      setProblems(data.problems.map(toMarketplaceProblem));
    } catch (err) {
      setError(
        err instanceof Error ? err : new Error('問題の取得に失敗しました')
      );
      setProblems([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchProblems();
  }, [fetchProblems]);

  const filteredProblems = problems.filter((p) => {
    const matchesSearch =
      searchQuery === '' ||
      p.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
      p.description.toLowerCase().includes(searchQuery.toLowerCase()) ||
      p.tags.some((tag) =>
        tag.toLowerCase().includes(searchQuery.toLowerCase())
      );
    const matchesCategory =
      !selectedCategory?.value || p.category === selectedCategory.value;
    const matchesDifficulty =
      !selectedDifficulty?.value || p.difficulty === selectedDifficulty.value;
    const matchesCloudProvider =
      !selectedCloudProvider?.value ||
      p.cloudProvider === selectedCloudProvider.value;

    return (
      matchesSearch &&
      matchesCategory &&
      matchesDifficulty &&
      matchesCloudProvider
    );
  });

  const totalProblems = problems.length;
  const avgRating =
    problems.length > 0
      ? (
          problems.reduce((acc, p) => acc + p.rating, 0) / problems.length
        ).toFixed(1)
      : '0.0';

  return (
    <SpaceBetween size="l">
      <Header
        variant="h1"
        counter={
          !loading && !error ? `(${filteredProblems.length})` : undefined
        }
      >
        問題マーケットプレイス
      </Header>

      {/* Filters */}
      <Container>
        <SpaceBetween direction="horizontal" size="l">
          <div style={{ minWidth: 280 }}>
            <Input
              type="search"
              placeholder="タイトル、説明、タグで検索..."
              value={searchQuery}
              onChange={({ detail }) => setSearchQuery(detail.value)}
            />
          </div>
          <Select
            selectedOption={selectedCategory}
            onChange={({ detail }) =>
              setSelectedCategory(detail.selectedOption)
            }
            options={categoryOptions}
            placeholder="カテゴリ"
          />
          <Select
            selectedOption={selectedDifficulty}
            onChange={({ detail }) =>
              setSelectedDifficulty(detail.selectedOption)
            }
            options={difficultyOptions}
            placeholder="難易度"
          />
          <Select
            selectedOption={selectedCloudProvider}
            onChange={({ detail }) =>
              setSelectedCloudProvider(detail.selectedOption)
            }
            options={cloudProviderOptions}
            placeholder="クラウド"
          />
        </SpaceBetween>
      </Container>

      {/* Error State */}
      {error && (
        <Container>
          <Box textAlign="center" padding="l">
            <SpaceBetween size="m">
              <StatusIndicator type="error">{error.message}</StatusIndicator>
              <Button onClick={fetchProblems}>再試行</Button>
            </SpaceBetween>
          </Box>
        </Container>
      )}

      {/* Stats */}
      {!error && (
        <ColumnLayout columns={3}>
          <Container>
            <Box variant="awsui-key-label">公開問題数</Box>
            <Box variant="awsui-value-large">
              {loading ? '-' : totalProblems}
            </Box>
          </Container>
          <Container>
            <Box variant="awsui-key-label">平均評価</Box>
            <Box variant="awsui-value-large">
              {loading ? '-' : `★ ${avgRating}`}
            </Box>
          </Container>
          <Container>
            <Box variant="awsui-key-label">検索結果</Box>
            <Box variant="awsui-value-large">
              {loading ? '-' : filteredProblems.length}
            </Box>
          </Container>
        </ColumnLayout>
      )}

      {/* Problems Grid */}
      {!error && (
        <Cards
          cardDefinition={{
            header: (problem) => (
              <SpaceBetween direction="horizontal" size="xs">
                <span>{getCategoryIcon(problem.category)}</span>
                <Box fontSize="heading-m" fontWeight="bold">
                  {problem.title}
                </Box>
              </SpaceBetween>
            ),
            sections: [
              {
                id: 'author',
                header: '作成者',
                content: (problem) => problem.authorName,
              },
              {
                id: 'description',
                header: '説明',
                content: (problem) => (
                  <Box variant="small" color="text-body-secondary">
                    {problem.description}
                  </Box>
                ),
              },
              {
                id: 'badges',
                header: '分類',
                content: (problem) => (
                  <SpaceBetween direction="horizontal" size="xs">
                    <Badge color={getDifficultyBadgeColor(problem.difficulty)}>
                      {getDifficultyLabel(problem.difficulty)}
                    </Badge>
                    <Badge color="blue">
                      {getCategoryLabel(problem.category)}
                    </Badge>
                    <Badge color="grey">
                      {problem.cloudProvider.toUpperCase()}
                    </Badge>
                    {problem.type === 'gameday' ? (
                      <Badge color="blue">GameDay</Badge>
                    ) : (
                      <Badge color="green">JAM</Badge>
                    )}
                  </SpaceBetween>
                ),
              },
              {
                id: 'meta',
                header: '詳細情報',
                content: (problem) => (
                  <SpaceBetween direction="horizontal" size="l">
                    <Box variant="small">
                      推定時間: {problem.estimatedTimeMinutes}分
                    </Box>
                    <Box variant="small">
                      評価: ★ {problem.rating.toFixed(1)}
                    </Box>
                    <Box variant="small">{problem.usageCount}回使用</Box>
                  </SpaceBetween>
                ),
              },
              {
                id: 'tags',
                header: 'タグ',
                content: (problem) =>
                  problem.tags.length > 0 ? (
                    <SpaceBetween direction="horizontal" size="xs">
                      {problem.tags.slice(0, 3).map((tag) => (
                        <Badge key={tag} color="grey">
                          {tag}
                        </Badge>
                      ))}
                      {problem.tags.length > 3 && (
                        <Box variant="small" color="text-body-secondary">
                          +{problem.tags.length - 3}
                        </Box>
                      )}
                    </SpaceBetween>
                  ) : null,
              },
              {
                id: 'actions',
                content: (problem) => (
                  <SpaceBetween direction="horizontal" size="xs">
                    <Button disabled variant="normal">
                      プレビュー
                    </Button>
                    <Button disabled variant="primary">
                      イベントに追加
                    </Button>
                  </SpaceBetween>
                ),
              },
            ],
          }}
          cardsPerRow={[{ cards: 1 }, { minWidth: 600, cards: 2 }]}
          items={filteredProblems}
          loading={loading}
          loadingText="問題を読み込み中..."
          empty={
            <Box textAlign="center" color="inherit" padding="l">
              <SpaceBetween size="m">
                <b>問題が見つかりません</b>
                <Box variant="p" color="inherit">
                  検索条件を変更してください。
                </Box>
              </SpaceBetween>
            </Box>
          }
        />
      )}
    </SpaceBetween>
  );
}
