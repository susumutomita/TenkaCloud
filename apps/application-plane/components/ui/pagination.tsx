/**
 * Pagination Component
 *
 * HybridNext Design System - Terminal Command Center style
 * Dark-themed pagination with neo-brutalist active states
 */

import type { HTMLAttributes } from 'react';
import { forwardRef, useMemo } from 'react';

// ============================================================================
// Types
// ============================================================================

type PaginationSize = 'sm' | 'md' | 'lg';

interface PaginationProps extends Omit<
  HTMLAttributes<HTMLElement>,
  'onChange'
> {
  currentPage: number;
  totalPages: number;
  onPageChange: (page: number) => void;
  size?: PaginationSize;
  showPageInfo?: boolean;
  disabled?: boolean;
}

// ============================================================================
// Constants
// ============================================================================

const sizeClasses: Record<PaginationSize, string> = {
  sm: 'text-sm',
  md: 'text-base',
  lg: 'text-lg',
};

const buttonSizeClasses: Record<PaginationSize, string> = {
  sm: 'h-8 min-w-8 px-2',
  md: 'h-10 min-w-10 px-3',
  lg: 'h-12 min-w-12 px-4',
};

// ============================================================================
// Helper Functions
// ============================================================================

function getPageNumbers(
  currentPage: number,
  totalPages: number
): (number | 'ellipsis')[] {
  const pages: (number | 'ellipsis')[] = [];

  // 5ページ以下は全て表示
  if (totalPages <= 5) {
    for (let i = 1; i <= totalPages; i++) {
      pages.push(i);
    }
    return pages;
  }

  // 常に最初のページを表示
  pages.push(1);

  // 中間のページを計算
  const showLeftEllipsis = currentPage > 3;
  const showRightEllipsis = currentPage < totalPages - 2;

  if (showLeftEllipsis) {
    pages.push('ellipsis');
  }

  // 現在のページの前後を表示
  const start = Math.max(2, currentPage - 1);
  const end = Math.min(totalPages - 1, currentPage + 1);

  for (let i = start; i <= end; i++) {
    if (!pages.includes(i)) {
      pages.push(i);
    }
  }

  if (showRightEllipsis) {
    pages.push('ellipsis');
  }

  // 常に最後のページを表示
  if (!pages.includes(totalPages)) {
    pages.push(totalPages);
  }

  return pages;
}

// ============================================================================
// Pagination
// ============================================================================

const Pagination = forwardRef<HTMLElement, PaginationProps>(
  (
    {
      currentPage,
      totalPages,
      onPageChange,
      size = 'md',
      showPageInfo = false,
      disabled = false,
      className = '',
      ...props
    },
    ref
  ) => {
    // 正規化されたページ番号
    const normalizedCurrentPage = Math.max(
      1,
      Math.min(currentPage, totalPages)
    );
    const normalizedTotalPages = Math.max(0, totalPages);

    // ページ番号の配列を計算
    const pageNumbers = useMemo(
      () => getPageNumbers(normalizedCurrentPage, normalizedTotalPages),
      [normalizedCurrentPage, normalizedTotalPages]
    );

    // 1ページ以下の場合は表示しない
    if (normalizedTotalPages <= 1) {
      return null;
    }

    const isFirstPage = normalizedCurrentPage <= 1;
    const isLastPage = normalizedCurrentPage >= normalizedTotalPages;

    const baseButtonClasses = [
      'inline-flex items-center justify-center',
      'rounded-[var(--radius)]',
      'font-medium',
      'transition-all duration-[var(--animation-duration-fast)]',
      'focus:outline-none focus-visible:ring-2 focus-visible:ring-hn-accent',
      'focus-visible:ring-offset-2 focus-visible:ring-offset-surface-0',
      'disabled:pointer-events-none disabled:opacity-50',
      buttonSizeClasses[size],
    ].join(' ');

    const navButtonClasses = [
      baseButtonClasses,
      'border border-border bg-surface-1 text-text-secondary hover:bg-surface-2 hover:text-text-primary',
    ].join(' ');

    return (
      <nav
        ref={ref}
        role="navigation"
        aria-label="ページナビゲーション"
        className={`flex items-center gap-1 ${sizeClasses[size]} ${className}`}
        {...props}
      >
        {/* 前へボタン */}
        <button
          type="button"
          aria-label="前のページ"
          disabled={disabled || isFirstPage}
          onClick={() => onPageChange(normalizedCurrentPage - 1)}
          className={navButtonClasses}
        >
          <ChevronLeftIcon />
        </button>

        {/* ページ番号 */}
        {pageNumbers.map((page, index) => {
          if (page === 'ellipsis') {
            const ellipsisClasses = [
              buttonSizeClasses[size],
              'inline-flex items-center justify-center text-text-muted',
            ].join(' ');
            return (
              <span key={`ellipsis-${index}`} className={ellipsisClasses}>
                ...
              </span>
            );
          }

          const isCurrentPage = page === normalizedCurrentPage;
          const activeStyle = [
            'bg-hn-accent text-surface-0',
            'shadow-[2px_2px_0_var(--color-hn-accent-dim)]',
            'hover:bg-hn-accent-bright',
          ].join(' ');
          const inactiveStyle = [
            'border border-border bg-surface-1 text-text-secondary',
            'hover:bg-surface-2 hover:text-text-primary',
          ].join(' ');
          const pageButtonStyle = isCurrentPage ? activeStyle : inactiveStyle;

          return (
            <button
              key={page}
              type="button"
              aria-current={isCurrentPage ? 'page' : undefined}
              disabled={disabled}
              onClick={() => onPageChange(page)}
              className={`${baseButtonClasses} ${pageButtonStyle}`}
            >
              {page}
            </button>
          );
        })}

        {/* 次へボタン */}
        <button
          type="button"
          aria-label="次のページ"
          disabled={disabled || isLastPage}
          onClick={() => onPageChange(normalizedCurrentPage + 1)}
          className={navButtonClasses}
        >
          <ChevronRightIcon />
        </button>

        {/* ページ情報 */}
        {showPageInfo && (
          <span className="ml-2 text-text-muted font-mono text-sm">
            {normalizedCurrentPage} / {normalizedTotalPages}
          </span>
        )}
      </nav>
    );
  }
);
Pagination.displayName = 'Pagination';

// ============================================================================
// Icons
// ============================================================================

function ChevronLeftIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m15 18-6-6 6-6" />
    </svg>
  );
}

function ChevronRightIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m9 18 6-6-6-6" />
    </svg>
  );
}

// ============================================================================
// Exports
// ============================================================================

export { Pagination };
