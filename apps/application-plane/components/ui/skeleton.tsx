/**
 * Skeleton Component
 *
 * ローディング状態を表示するスケルトンコンポーネント
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
}

const variantClasses: Record<SkeletonVariant, string> = {
  default: 'rounded-md',
  circle: 'rounded-full',
  rectangular: 'rounded-none',
};

const Skeleton = forwardRef<HTMLDivElement, SkeletonProps>(
  (
    { className = '', width, height, variant = 'default', style, ...props },
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
        className={`animate-pulse bg-gray-200 ${variantClasses[variant]} ${className}`}
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
              className={`animate-pulse bg-gray-200 rounded-md ${sizeClasses[size]}`}
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
        className={`animate-pulse bg-gray-200 rounded-lg ${height} ${widthClass} ${className}`}
        {...props}
      />
    );
  }
);
SkeletonButton.displayName = 'SkeletonButton';

// ============================================================================
// Exports
// ============================================================================

export { Skeleton, SkeletonText, SkeletonButton };
