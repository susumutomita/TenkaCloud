'use client';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import type {
  CloudProvider,
  DifficultyLevel,
  MarketplaceSearchParams,
  ProblemCategory,
  ProblemType,
} from '@/lib/api/problems';

interface ProblemFiltersProps {
  filters: MarketplaceSearchParams;
  onFiltersChange: (filters: MarketplaceSearchParams) => void;
  onReset: () => void;
}

export function ProblemFilters({
  filters,
  onFiltersChange,
  onReset,
}: ProblemFiltersProps) {
  const handleChange = <K extends keyof MarketplaceSearchParams>(
    key: K,
    value: MarketplaceSearchParams[K]
  ) => {
    onFiltersChange({ ...filters, [key]: value || undefined, page: 1 });
  };

  return (
    <div className="bg-card border rounded-lg p-4 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="font-medium">フィルター</h3>
        <Button variant="ghost" size="sm" onClick={onReset}>
          リセット
        </Button>
      </div>

      <div className="space-y-4">
        {/* 検索 */}
        <div>
          <label className="text-sm font-medium mb-1 block">
            キーワード検索
          </label>
          <Input
            placeholder="問題名、タグ..."
            value={filters.query ?? ''}
            onChange={(e) => handleChange('query', e.target.value)}
          />
        </div>

        {/* タイプ */}
        <div>
          <label className="text-sm font-medium mb-1 block">問題タイプ</label>
          <Select
            value={filters.type ?? ''}
            onChange={(e) =>
              handleChange('type', e.target.value as ProblemType)
            }
          >
            <option value="">すべて</option>
            <option value="gameday">GameDay</option>
            <option value="jam">JAM</option>
          </Select>
        </div>

        {/* カテゴリ */}
        <div>
          <label className="text-sm font-medium mb-1 block">カテゴリ</label>
          <Select
            value={filters.category ?? ''}
            onChange={(e) =>
              handleChange('category', e.target.value as ProblemCategory)
            }
          >
            <option value="">すべて</option>
            <option value="architecture">アーキテクチャ</option>
            <option value="security">セキュリティ</option>
            <option value="cost">コスト</option>
            <option value="performance">パフォーマンス</option>
            <option value="reliability">信頼性</option>
            <option value="operations">運用</option>
          </Select>
        </div>

        {/* 難易度 */}
        <div>
          <label className="text-sm font-medium mb-1 block">難易度</label>
          <Select
            value={filters.difficulty ?? ''}
            onChange={(e) =>
              handleChange('difficulty', e.target.value as DifficultyLevel)
            }
          >
            <option value="">すべて</option>
            <option value="easy">初級</option>
            <option value="medium">中級</option>
            <option value="hard">上級</option>
            <option value="expert">エキスパート</option>
          </Select>
        </div>

        {/* クラウドプロバイダー */}
        <div>
          <label className="text-sm font-medium mb-1 block">クラウド</label>
          <Select
            value={filters.provider ?? ''}
            onChange={(e) =>
              handleChange('provider', e.target.value as CloudProvider)
            }
          >
            <option value="">すべて</option>
            <option value="aws">AWS</option>
            <option value="gcp">Google Cloud</option>
            <option value="azure">Azure</option>
            <option value="local">Local</option>
          </Select>
        </div>

        {/* 最低評価 */}
        <div>
          <label className="text-sm font-medium mb-1 block">最低評価</label>
          <Select
            value={filters.minRating?.toString() ?? ''}
            onChange={(e) =>
              handleChange(
                'minRating',
                e.target.value ? Number(e.target.value) : undefined
              )
            }
          >
            <option value="">すべて</option>
            <option value="4">4.0 以上</option>
            <option value="4.5">4.5 以上</option>
          </Select>
        </div>

        {/* ソート */}
        <div>
          <label className="text-sm font-medium mb-1 block">並び順</label>
          <Select
            value={filters.sortBy ?? 'relevance'}
            onChange={(e) =>
              handleChange(
                'sortBy',
                e.target.value as MarketplaceSearchParams['sortBy']
              )
            }
          >
            <option value="relevance">おすすめ順</option>
            <option value="rating">評価順</option>
            <option value="downloads">ダウンロード順</option>
            <option value="newest">新着順</option>
          </Select>
        </div>
      </div>
    </div>
  );
}
