/**
 * Badge Component
 *
 * HybridNext Design System - Terminal Command Center style
 * Neo-brutalist badges for status and category display
 */

import type { ReactNode } from 'react';

type BadgeVariant =
  | 'default'
  | 'primary'
  | 'success'
  | 'warning'
  | 'danger'
  | 'info'
  | 'purple';
type BadgeStyle = 'solid' | 'outline' | 'subtle';
type BadgeSize = 'sm' | 'md' | 'lg';

interface BadgeProps {
  children: ReactNode;
  variant?: BadgeVariant;
  badgeStyle?: BadgeStyle;
  size?: BadgeSize;
  className?: string;
  dot?: boolean;
}

const variantColors: Record<
  BadgeVariant,
  { solid: string; outline: string; subtle: string; dot: string }
> = {
  default: {
    solid: 'bg-surface-3 text-text-primary border-transparent',
    outline: 'bg-transparent text-text-secondary border-border',
    subtle: 'bg-surface-2/50 text-text-secondary border-transparent',
    dot: 'bg-text-muted',
  },
  primary: {
    solid: 'bg-hn-accent text-surface-0 border-transparent',
    outline: 'bg-transparent text-hn-accent border-hn-accent',
    subtle: 'bg-hn-accent/10 text-hn-accent border-transparent',
    dot: 'bg-hn-accent',
  },
  success: {
    solid: 'bg-hn-success text-surface-0 border-transparent',
    outline: 'bg-transparent text-hn-success border-hn-success',
    subtle: 'bg-hn-success/10 text-hn-success border-transparent',
    dot: 'bg-hn-success',
  },
  warning: {
    solid: 'bg-hn-warning text-surface-0 border-transparent',
    outline: 'bg-transparent text-hn-warning border-hn-warning',
    subtle: 'bg-hn-warning/10 text-hn-warning border-transparent',
    dot: 'bg-hn-warning',
  },
  danger: {
    solid: 'bg-hn-error text-surface-0 border-transparent',
    outline: 'bg-transparent text-hn-error border-hn-error',
    subtle: 'bg-hn-error/10 text-hn-error border-transparent',
    dot: 'bg-hn-error',
  },
  info: {
    solid: 'bg-hn-info text-surface-0 border-transparent',
    outline: 'bg-transparent text-hn-info border-hn-info',
    subtle: 'bg-hn-info/10 text-hn-info border-transparent',
    dot: 'bg-hn-info',
  },
  purple: {
    solid: 'bg-hn-purple text-surface-0 border-transparent',
    outline: 'bg-transparent text-hn-purple border-hn-purple',
    subtle: 'bg-hn-purple/10 text-hn-purple border-transparent',
    dot: 'bg-hn-purple',
  },
};

const sizeClasses: Record<BadgeSize, string> = {
  sm: 'px-2 py-0.5 text-xs gap-1',
  md: 'px-2.5 py-1 text-sm gap-1.5',
  lg: 'px-3 py-1.5 text-base gap-2',
};

const dotSizeClasses: Record<BadgeSize, string> = {
  sm: 'w-1.5 h-1.5',
  md: 'w-2 h-2',
  lg: 'w-2.5 h-2.5',
};

export function Badge({
  children,
  variant = 'default',
  badgeStyle = 'subtle',
  size = 'md',
  className = '',
  dot = false,
}: BadgeProps) {
  const baseClasses = [
    'inline-flex items-center',
    'font-medium',
    'rounded-[var(--radius-sm)]',
    'border',
    'transition-colors duration-[var(--animation-duration-fast)]',
  ].join(' ');

  return (
    <span
      className={`${baseClasses} ${variantColors[variant][badgeStyle]} ${sizeClasses[size]} ${className}`}
    >
      {dot && (
        <span
          className={`${dotSizeClasses[size]} ${variantColors[variant].dot} rounded-full shrink-0`}
        />
      )}
      {children}
    </span>
  );
}

// Event Status Badge
export function EventStatusBadge({ status }: { status: string }) {
  const statusConfig: Record<
    string,
    { variant: BadgeVariant; badgeStyle: BadgeStyle; label: string }
  > = {
    draft: { variant: 'default', badgeStyle: 'subtle', label: '下書き' },
    scheduled: { variant: 'info', badgeStyle: 'subtle', label: '予定' },
    active: { variant: 'success', badgeStyle: 'solid', label: '開催中' },
    paused: { variant: 'warning', badgeStyle: 'outline', label: '一時停止' },
    completed: { variant: 'default', badgeStyle: 'subtle', label: '終了' },
    cancelled: {
      variant: 'danger',
      badgeStyle: 'outline',
      label: 'キャンセル',
    },
  };

  const config = statusConfig[status] || {
    variant: 'default' as BadgeVariant,
    badgeStyle: 'subtle' as BadgeStyle,
    label: status,
  };

  return (
    <Badge variant={config.variant} badgeStyle={config.badgeStyle} dot>
      {config.label}
    </Badge>
  );
}

// Difficulty Badge
export function DifficultyBadge({ difficulty }: { difficulty: string }) {
  const difficultyConfig: Record<
    string,
    { variant: BadgeVariant; badgeStyle: BadgeStyle; label: string }
  > = {
    easy: { variant: 'success', badgeStyle: 'subtle', label: '初級' },
    medium: { variant: 'warning', badgeStyle: 'subtle', label: '中級' },
    hard: { variant: 'danger', badgeStyle: 'subtle', label: '上級' },
    expert: { variant: 'purple', badgeStyle: 'solid', label: 'エキスパート' },
  };

  const config = difficultyConfig[difficulty] || {
    variant: 'default' as BadgeVariant,
    badgeStyle: 'subtle' as BadgeStyle,
    label: difficulty,
  };

  return (
    <Badge variant={config.variant} badgeStyle={config.badgeStyle}>
      {config.label}
    </Badge>
  );
}

// Problem Type Badge
export function ProblemTypeBadge({ type }: { type: string }) {
  const typeConfig: Record<
    string,
    { variant: BadgeVariant; badgeStyle: BadgeStyle; label: string }
  > = {
    gameday: { variant: 'primary', badgeStyle: 'solid', label: 'GameDay' },
    jam: { variant: 'info', badgeStyle: 'solid', label: 'JAM' },
  };

  const config = typeConfig[type] || {
    variant: 'default' as BadgeVariant,
    badgeStyle: 'subtle' as BadgeStyle,
    label: type,
  };

  return (
    <Badge variant={config.variant} badgeStyle={config.badgeStyle}>
      {config.label}
    </Badge>
  );
}

// Problem Category Badge
export function CategoryBadge({ category }: { category: string }) {
  const categoryConfig: Record<string, { label: string; icon: string }> = {
    architecture: { label: 'アーキテクチャ', icon: '🏗️' },
    security: { label: 'セキュリティ', icon: '🔒' },
    cost: { label: 'コスト最適化', icon: '💰' },
    performance: { label: 'パフォーマンス', icon: '⚡' },
    reliability: { label: '信頼性', icon: '🛡️' },
    operations: { label: '運用', icon: '🔧' },
  };

  const config = categoryConfig[category] || { label: category, icon: '📦' };

  return (
    <Badge variant="default" badgeStyle="subtle">
      {config.label}
    </Badge>
  );
}

// Category Icon (for standalone use)
export function getCategoryIcon(category: string): string {
  const icons: Record<string, string> = {
    architecture: '🏗️',
    security: '🔒',
    cost: '💰',
    performance: '⚡',
    reliability: '🛡️',
    operations: '🔧',
  };
  return icons[category] || '📦';
}

// Category Label (for standalone use)
export function getCategoryLabel(category: string): string {
  const labels: Record<string, string> = {
    architecture: 'アーキテクチャ',
    security: 'セキュリティ',
    cost: 'コスト最適化',
    performance: 'パフォーマンス',
    reliability: '信頼性',
    operations: '運用',
  };
  return labels[category] || category;
}

// Cloud Provider Badge
export function ProviderBadge({ provider }: { provider: string }) {
  const providerConfig: Record<string, string> = {
    aws: 'AWS',
    gcp: 'Google Cloud',
    azure: 'Azure',
    local: 'LocalStack',
  };

  const label = providerConfig[provider] || provider;

  return (
    <Badge
      variant="default"
      badgeStyle="subtle"
      className="font-mono uppercase"
    >
      {label}
    </Badge>
  );
}

// Provider Label (for standalone use)
export function getProviderLabel(provider: string): string {
  const labels: Record<string, string> = {
    aws: 'AWS',
    gcp: 'Google Cloud',
    azure: 'Azure',
    local: 'LocalStack',
  };
  return labels[provider] || provider;
}
