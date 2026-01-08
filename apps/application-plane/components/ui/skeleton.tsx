/**
 * Skeleton Component
 *
 * HybridNext Design System - Terminal Command Center style
 * Dark-themed loading skeletons with shimmer effect
 */

import type { CSSProperties, HTMLAttributes } from 'react';
import { forwardRef } from 'react';

// ============================================================================
// Types
// ============================================================================

type SkeletonVariant = 'default' | 'circle' | 'rectangular';
type SkeletonSize = 'sm' | 'md' | 'lg';

// ============================================================================
// Skeleton
// ============================================================================

interface SkeletonProps extends HTMLAttributes<HTMLDivElement> {
  width?: number | string;
  height?: number | string;
  variant?: SkeletonVariant;
  animate?: boolean;
}

const variantClasses: Record<SkeletonVariant, string> = {
  default: 'rounded-[var(--radius)]',
  circle: 'rounded-full',
  rectangular: 'rounded-none',
};

const Skeleton = forwardRef<HTMLDivElement, SkeletonProps>(
  (
    {
      className = '',
      width,
      height,
      variant = 'default',
      animate = true,
      style,
      ...props
    },
    ref
  ) => {
    const computedStyle: CSSProperties = {
      ...style,
      ...(width !== undefined && {
        width: typeof width === 'number' ? `${width}px` : width,
      }),
      ...(height !== undefined && {
        height: typeof height === 'number' ? `${height}px` : height,
      }),
    };

    return (
      <div
        ref={ref}
        className={`bg-surface-2 ${animate ? 'animate-pulse' : ''} ${variantClasses[variant]} ${className}`}
        style={computedStyle}
        {...props}
      />
    );
  }
);
Skeleton.displayName = 'Skeleton';

// ============================================================================
// SkeletonText
// ============================================================================

interface SkeletonTextProps extends HTMLAttributes<HTMLDivElement> {
  lines?: number;
  size?: SkeletonSize;
}

const sizeClasses: Record<SkeletonSize, string> = {
  sm: 'h-3',
  md: 'h-4',
  lg: 'h-5',
};

const SkeletonText = forwardRef<HTMLDivElement, SkeletonTextProps>(
  ({ className = '', lines = 1, size = 'md', ...props }, ref) => {
    return (
      <div ref={ref} className={`space-y-2 ${className}`} {...props}>
        {Array.from({ length: lines }).map((_, index) => {
          const isLastLine = index === lines - 1 && lines > 1;
          const lineWidth = isLastLine ? '60%' : '100%';

          return (
            <div
              key={index}
              data-skeleton-line=""
              className={`animate-pulse bg-surface-2 rounded-[var(--radius-sm)] ${sizeClasses[size]}`}
              style={{ width: lineWidth }}
            />
          );
        })}
      </div>
    );
  }
);
SkeletonText.displayName = 'SkeletonText';

// ============================================================================
// SkeletonButton
// ============================================================================

interface SkeletonButtonProps extends HTMLAttributes<HTMLDivElement> {
  size?: SkeletonSize;
  fullWidth?: boolean;
}

const buttonSizeClasses: Record<
  SkeletonSize,
  { height: string; width: string }
> = {
  sm: { height: 'h-8', width: 'w-16' },
  md: { height: 'h-10', width: 'w-20' },
  lg: { height: 'h-12', width: 'w-24' },
};

const SkeletonButton = forwardRef<HTMLDivElement, SkeletonButtonProps>(
  ({ className = '', size = 'md', fullWidth = false, ...props }, ref) => {
    const { height, width } = buttonSizeClasses[size];
    const widthClass = fullWidth ? 'w-full' : width;

    return (
      <div
        ref={ref}
        className={`animate-pulse bg-surface-2 rounded-[var(--radius)] ${height} ${widthClass} ${className}`}
        {...props}
      />
    );
  }
);
SkeletonButton.displayName = 'SkeletonButton';

// ============================================================================
// SkeletonCard
// ============================================================================

interface SkeletonCardProps extends HTMLAttributes<HTMLDivElement> {
  hasImage?: boolean;
  hasAction?: boolean;
}

const SkeletonCard = forwardRef<HTMLDivElement, SkeletonCardProps>(
  ({ className = '', hasImage = false, hasAction = false, ...props }, ref) => {
    return (
      <div
        ref={ref}
        className={`bg-surface-1 border border-border rounded-[var(--radius)] p-4 ${className}`}
        {...props}
      >
        {hasImage && (
          <Skeleton className="w-full h-40 mb-4" variant="rectangular" />
        )}
        <div className="space-y-3">
          <Skeleton className="h-5 w-3/4" />
          <SkeletonText lines={2} size="sm" />
          {hasAction && (
            <div className="flex gap-2 pt-2">
              <SkeletonButton size="sm" />
              <SkeletonButton size="sm" />
            </div>
          )}
        </div>
      </div>
    );
  }
);
SkeletonCard.displayName = 'SkeletonCard';

// ============================================================================
// SkeletonTable
// ============================================================================

interface SkeletonTableProps extends HTMLAttributes<HTMLDivElement> {
  rows?: number;
  columns?: number;
}

const SkeletonTable = forwardRef<HTMLDivElement, SkeletonTableProps>(
  ({ className = '', rows = 5, columns = 4, ...props }, ref) => {
    return (
      <div
        ref={ref}
        className={`rounded-[var(--radius)] border border-border overflow-hidden ${className}`}
        {...props}
      >
        {/* Header */}
        <div className="bg-surface-2 border-b border-border p-4">
          <div className="flex gap-4">
            {Array.from({ length: columns }).map((_, i) => (
              <Skeleton key={i} className="h-4 flex-1" />
            ))}
          </div>
        </div>
        {/* Rows */}
        <div className="bg-surface-1">
          {Array.from({ length: rows }).map((_, rowIndex) => (
            <div
              key={rowIndex}
              className="flex gap-4 p-4 border-b border-border last:border-b-0"
            >
              {Array.from({ length: columns }).map((_, colIndex) => (
                <Skeleton key={colIndex} className="h-4 flex-1" />
              ))}
            </div>
          ))}
        </div>
      </div>
    );
  }
);
SkeletonTable.displayName = 'SkeletonTable';

// ============================================================================
// Exports
// ============================================================================

export { Skeleton, SkeletonText, SkeletonButton, SkeletonCard, SkeletonTable };
