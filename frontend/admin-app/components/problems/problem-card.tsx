'use client';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
} from '@/components/ui/card';
import type { MarketplaceProblem } from '@/lib/api/problems';

interface ProblemCardProps {
  problem: MarketplaceProblem;
  onInstall?: (problemId: string) => void;
  onViewDetails?: (problemId: string) => void;
}

const difficultyColors: Record<string, string> = {
  easy: 'bg-green-100 text-green-800',
  medium: 'bg-yellow-100 text-yellow-800',
  hard: 'bg-orange-100 text-orange-800',
  expert: 'bg-red-100 text-red-800',
};

const difficultyLabels: Record<string, string> = {
  easy: '初級',
  medium: '中級',
  hard: '上級',
  expert: 'エキスパート',
};

const typeLabels: Record<string, string> = {
  gameday: 'GameDay',
  jam: 'JAM',
};

const categoryLabels: Record<string, string> = {
  architecture: 'アーキテクチャ',
  security: 'セキュリティ',
  cost: 'コスト',
  performance: 'パフォーマンス',
  reliability: '信頼性',
  operations: '運用',
};

function StarRating({ rating }: { rating: number }) {
  return (
    <div className="flex items-center gap-1">
      {[1, 2, 3, 4, 5].map((star) => (
        <svg
          key={star}
          className={`h-4 w-4 ${star <= Math.round(rating) ? 'text-yellow-400 fill-current' : 'text-gray-300'}`}
          viewBox="0 0 20 20"
        >
          <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
        </svg>
      ))}
      <span className="ml-1 text-sm text-muted-foreground">
        {rating.toFixed(1)}
      </span>
    </div>
  );
}

export function ProblemCard({
  problem,
  onInstall,
  onViewDetails,
}: ProblemCardProps) {
  return (
    <Card className="flex flex-col h-full hover:shadow-lg transition-shadow">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-2">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <Badge variant="outline">{typeLabels[problem.type]}</Badge>
              {problem.isFeatured && (
                <Badge className="bg-purple-100 text-purple-800">
                  おすすめ
                </Badge>
              )}
              {problem.isVerified && (
                <svg
                  className="h-4 w-4 text-blue-500"
                  viewBox="0 0 20 20"
                  fill="currentColor"
                >
                  <path
                    fillRule="evenodd"
                    d="M6.267 3.455a3.066 3.066 0 001.745-.723 3.066 3.066 0 013.976 0 3.066 3.066 0 001.745.723 3.066 3.066 0 012.812 2.812c.051.643.304 1.254.723 1.745a3.066 3.066 0 010 3.976 3.066 3.066 0 00-.723 1.745 3.066 3.066 0 01-2.812 2.812 3.066 3.066 0 00-1.745.723 3.066 3.066 0 01-3.976 0 3.066 3.066 0 00-1.745-.723 3.066 3.066 0 01-2.812-2.812 3.066 3.066 0 00-.723-1.745 3.066 3.066 0 010-3.976 3.066 3.066 0 00.723-1.745 3.066 3.066 0 012.812-2.812zm7.44 5.252a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"
                    clipRule="evenodd"
                  />
                </svg>
              )}
            </div>
            <h3
              className="font-semibold text-lg truncate"
              title={problem.title}
            >
              {problem.title}
            </h3>
          </div>
        </div>
        <div className="flex items-center gap-2 mt-2">
          <Badge className={difficultyColors[problem.difficulty]}>
            {difficultyLabels[problem.difficulty]}
          </Badge>
          <Badge variant="secondary">{categoryLabels[problem.category]}</Badge>
        </div>
      </CardHeader>

      <CardContent className="flex-1 pb-3">
        <p className="text-sm text-muted-foreground line-clamp-3 mb-3">
          {problem.overview}
        </p>

        <div className="flex flex-wrap gap-1 mb-3">
          {problem.tags.slice(0, 4).map((tag) => (
            <span
              key={tag}
              className="text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded"
            >
              {tag}
            </span>
          ))}
          {problem.tags.length > 4 && (
            <span className="text-xs text-muted-foreground">
              +{problem.tags.length - 4}
            </span>
          )}
        </div>

        <div className="flex items-center justify-between text-sm">
          <StarRating rating={problem.averageRating} />
          <span className="text-muted-foreground">
            {problem.reviewCount} レビュー
          </span>
        </div>

        <div className="flex items-center gap-4 mt-2 text-sm text-muted-foreground">
          <span className="flex items-center gap-1">
            <svg className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
              <path
                fillRule="evenodd"
                d="M3 17a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm3.293-7.707a1 1 0 011.414 0L9 10.586V3a1 1 0 112 0v7.586l1.293-1.293a1 1 0 111.414 1.414l-3 3a1 1 0 01-1.414 0l-3-3a1 1 0 010-1.414z"
                clipRule="evenodd"
              />
            </svg>
            {problem.downloadCount.toLocaleString()}
          </span>
          {problem.estimatedTimeMinutes && (
            <span className="flex items-center gap-1">
              <svg className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
                <path
                  fillRule="evenodd"
                  d="M10 18a8 8 0 100-16 8 8 0 000 16zm1-12a1 1 0 10-2 0v4a1 1 0 00.293.707l2.828 2.829a1 1 0 101.415-1.415L11 9.586V6z"
                  clipRule="evenodd"
                />
              </svg>
              {problem.estimatedTimeMinutes}分
            </span>
          )}
        </div>

        <div className="flex items-center gap-2 mt-2">
          {problem.providers.map((provider) => (
            <span
              key={provider}
              className="text-xs font-medium uppercase text-muted-foreground"
            >
              {provider}
            </span>
          ))}
        </div>
      </CardContent>

      <CardFooter className="pt-0 gap-2">
        <Button
          variant="outline"
          size="sm"
          className="flex-1"
          onClick={() => onViewDetails?.(problem.id)}
        >
          詳細
        </Button>
        <Button
          size="sm"
          className="flex-1"
          onClick={() => onInstall?.(problem.id)}
        >
          インストール
        </Button>
      </CardFooter>
    </Card>
  );
}
