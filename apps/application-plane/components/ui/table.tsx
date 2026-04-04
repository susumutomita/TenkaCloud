/**
 * Table Component
 *
 * HybridNext Design System - Terminal Command Center style
 * Dark-themed data tables with subtle hover effects
 */

import type { HTMLAttributes, TdHTMLAttributes, ThHTMLAttributes } from 'react';
import { forwardRef } from 'react';

// ============================================================================
// Table
// ============================================================================

const Table = forwardRef<HTMLTableElement, HTMLAttributes<HTMLTableElement>>(
  ({ className = '', ...props }, ref) => (
    <div className="relative w-full overflow-auto rounded-[var(--radius)] border border-border">
      <table
        ref={ref}
        className={`w-full caption-bottom text-sm ${className}`}
        {...props}
      />
    </div>
  )
);
Table.displayName = 'Table';

// ============================================================================
// TableHeader
// ============================================================================

const TableHeader = forwardRef<
  HTMLTableSectionElement,
  HTMLAttributes<HTMLTableSectionElement>
>(({ className = '', ...props }, ref) => (
  <thead
    ref={ref}
    className={`bg-surface-2 [&_tr]:border-b [&_tr]:border-border ${className}`}
    {...props}
  />
));
TableHeader.displayName = 'TableHeader';

// ============================================================================
// TableBody
// ============================================================================

const TableBody = forwardRef<
  HTMLTableSectionElement,
  HTMLAttributes<HTMLTableSectionElement>
>(({ className = '', ...props }, ref) => (
  <tbody
    ref={ref}
    className={`bg-surface-1 [&_tr:last-child]:border-0 ${className}`}
    {...props}
  />
));
TableBody.displayName = 'TableBody';

// ============================================================================
// TableFooter
// ============================================================================

const TableFooter = forwardRef<
  HTMLTableSectionElement,
  HTMLAttributes<HTMLTableSectionElement>
>(({ className = '', ...props }, ref) => (
  <tfoot
    ref={ref}
    className={`border-t border-border bg-surface-2 font-medium text-text-secondary [&>tr]:last:border-b-0 ${className}`}
    {...props}
  />
));
TableFooter.displayName = 'TableFooter';

// ============================================================================
// TableRow
// ============================================================================

const TableRow = forwardRef<
  HTMLTableRowElement,
  HTMLAttributes<HTMLTableRowElement>
>(({ className = '', ...props }, ref) => (
  <tr
    ref={ref}
    className={`border-b border-border transition-colors duration-[var(--animation-duration-fast)] hover:bg-surface-2/50 data-[state=selected]:bg-hn-accent/10 ${className}`}
    {...props}
  />
));
TableRow.displayName = 'TableRow';

// ============================================================================
// TableHead
// ============================================================================

type SortDirection = 'asc' | 'desc' | undefined;

interface TableHeadProps extends ThHTMLAttributes<HTMLTableCellElement> {
  sortable?: boolean;
  sortDirection?: SortDirection;
  onSort?: () => void;
}

const TableHead = forwardRef<HTMLTableCellElement, TableHeadProps>(
  (
    {
      className = '',
      sortable = false,
      sortDirection,
      onSort,
      children,
      ...props
    },
    ref
  ) => {
    const sortableClasses = sortable
      ? 'cursor-pointer select-none hover:bg-surface-3 hover:text-text-primary'
      : '';

    const ariaSort =
      sortDirection === 'asc'
        ? 'ascending'
        : sortDirection === 'desc'
          ? 'descending'
          : undefined;

    return (
      <th
        ref={ref}
        className={`h-11 px-4 text-left align-middle font-semibold text-text-muted text-xs uppercase tracking-wider [&:has([role=checkbox])]:pr-0 transition-colors duration-[var(--animation-duration-fast)] ${sortableClasses} ${className}`}
        aria-sort={ariaSort}
        onClick={sortable ? onSort : undefined}
        {...props}
      >
        <span className="flex items-center gap-1.5">
          {children}
          {sortable && (
            <svg
              className={`w-4 h-4 transition-transform ${
                sortDirection === 'asc'
                  ? 'rotate-180 text-hn-accent'
                  : sortDirection === 'desc'
                    ? 'text-hn-accent'
                    : 'text-text-muted/50'
              }`}
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M19 9l-7 7-7-7"
              />
            </svg>
          )}
        </span>
      </th>
    );
  }
);
TableHead.displayName = 'TableHead';

// ============================================================================
// TableCell
// ============================================================================

const TableCell = forwardRef<
  HTMLTableCellElement,
  TdHTMLAttributes<HTMLTableCellElement>
>(({ className = '', ...props }, ref) => (
  <td
    ref={ref}
    className={`p-4 align-middle text-text-primary [&:has([role=checkbox])]:pr-0 ${className}`}
    {...props}
  />
));
TableCell.displayName = 'TableCell';

// ============================================================================
// TableCaption
// ============================================================================

const TableCaption = forwardRef<
  HTMLTableCaptionElement,
  HTMLAttributes<HTMLTableCaptionElement>
>(({ className = '', ...props }, ref) => (
  <caption
    ref={ref}
    className={`mt-4 text-sm text-text-muted ${className}`}
    {...props}
  />
));
TableCaption.displayName = 'TableCaption';

// ============================================================================
// TableEmpty - 空のテーブル表示
// ============================================================================

interface TableEmptyProps extends HTMLAttributes<HTMLTableRowElement> {
  colSpan: number;
  message?: string;
}

const TableEmpty = forwardRef<HTMLTableRowElement, TableEmptyProps>(
  (
    { colSpan, message = 'データがありません', className = '', ...props },
    ref
  ) => (
    <tr ref={ref} className={className} {...props}>
      <td colSpan={colSpan} className="h-32 text-center text-text-muted">
        <div className="flex flex-col items-center justify-center gap-2">
          <svg
            className="w-8 h-8 text-text-muted/50"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            aria-hidden="true"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4"
            />
          </svg>
          <span>{message}</span>
        </div>
      </td>
    </tr>
  )
);
TableEmpty.displayName = 'TableEmpty';

// ============================================================================
// Exports
// ============================================================================

export {
  Table,
  TableHeader,
  TableBody,
  TableFooter,
  TableHead,
  TableRow,
  TableCell,
  TableCaption,
  TableEmpty,
};
