'use client';

import { Badge } from '@/components/ui/badge';

interface MarketplaceHeaderProps {
  totalProblems: number;
  featuredCount: number;
}

export function MarketplaceHeader({ totalProblems, featuredCount }: MarketplaceHeaderProps) {
  return (
    <div className="bg-gradient-to-r from-blue-600 to-purple-600 text-white rounded-lg p-6 mb-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold mb-2">問題マーケットプレイス</h1>
          <p className="text-blue-100">
            GameDay や JAM で使用できる問題を検索・インストール
          </p>
          <div className="flex items-center gap-4 mt-4">
            <div className="flex items-center gap-2">
              <svg className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
                <path d="M9 4.804A7.968 7.968 0 005.5 4c-1.255 0-2.443.29-3.5.804v10A7.969 7.969 0 015.5 14c1.669 0 3.218.51 4.5 1.385A7.962 7.962 0 0114.5 14c1.255 0 2.443.29 3.5.804v-10A7.968 7.968 0 0014.5 4c-1.255 0-2.443.29-3.5.804V12a1 1 0 11-2 0V4.804z" />
              </svg>
              <span className="font-medium">{totalProblems} 問題</span>
            </div>
            <div className="flex items-center gap-2">
              <svg className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
                <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
              </svg>
              <span className="font-medium">{featuredCount} おすすめ</span>
            </div>
          </div>
        </div>
        <div className="hidden md:flex flex-col items-end gap-2">
          <Badge className="bg-white/20 text-white hover:bg-white/30">
            AWS 対応
          </Badge>
          <Badge className="bg-white/20 text-white hover:bg-white/30">
            GCP 対応
          </Badge>
          <Badge className="bg-white/20 text-white hover:bg-white/30">
            Azure 対応
          </Badge>
        </div>
      </div>
    </div>
  );
}
