/**
 * SearchInput Component
 *
 * HybridNext Design System - Terminal Command Center style
 * Admin ページの検索入力
 */

import { useId } from 'react';
import { Card, CardContent } from '@/components/ui/card';

export interface SearchInputProps {
  /** 検索クエリ */
  value: string;
  /** 値変更時のコールバック */
  onChange: (value: string) => void;
  /** プレースホルダー */
  placeholder?: string;
}

export function SearchInput({
  value,
  onChange,
  placeholder = '検索...',
}: SearchInputProps) {
  const inputId = useId();

  return (
    <Card>
      <CardContent className="p-4">
        <div className="max-w-md">
          <label htmlFor={inputId} className="sr-only">
            検索
          </label>
          <div className="relative">
            <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
              <svg
                className="h-5 w-5 text-text-muted"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                aria-hidden="true"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
                />
              </svg>
            </div>
            <input
              id={inputId}
              type="text"
              placeholder={placeholder}
              className="block w-full pl-10 pr-3 py-2 bg-surface-1 border border-border rounded-[var(--radius)] text-text-primary placeholder:text-text-muted focus:ring-hn-accent focus:border-hn-accent focus:outline-none"
              value={value}
              onChange={(e) => onChange(e.target.value)}
            />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
