/**
 * Badge Component
 *
 * ステータス表示用バッジコンポーネント
 */

import type { ReactNode } from "react";

type BadgeVariant =
  | "default"
  | "primary"
  | "success"
  | "warning"
  | "danger"
  | "info";
type BadgeSize = "sm" | "md" | "lg";

interface BadgeProps {
  children: ReactNode;
  variant?: BadgeVariant;
  size?: BadgeSize;
  className?: string;
}

const variantClasses: Record<BadgeVariant, string> = {
  default: "bg-gray-100 text-gray-800",
  primary: "bg-blue-100 text-blue-800",
  success: "bg-green-100 text-green-800",
  warning: "bg-yellow-100 text-yellow-800",
  danger: "bg-red-100 text-red-800",
  info: "bg-cyan-100 text-cyan-800",
};

const sizeClasses: Record<BadgeSize, string> = {
  sm: "px-2 py-0.5 text-xs",
  md: "px-2.5 py-1 text-sm",
  lg: "px-3 py-1.5 text-base",
};

export function Badge({
  children,
  variant = "default",
  size = "md",
  className = "",
}: BadgeProps) {
  return (
    <span
      className={`inline-flex items-center font-medium rounded-full ${variantClasses[variant]} ${sizeClasses[size]} ${className}`}
    >
      {children}
    </span>
  );
}

// Event Status Badge
export function EventStatusBadge({ status }: { status: string }) {
  const statusConfig: Record<string, { variant: BadgeVariant; label: string }> =
    {
      draft: { variant: "default", label: "下書き" },
      scheduled: { variant: "info", label: "予定" },
      active: { variant: "success", label: "開催中" },
      paused: { variant: "warning", label: "一時停止" },
      completed: { variant: "default", label: "終了" },
      cancelled: { variant: "danger", label: "キャンセル" },
    };

  const config = statusConfig[status] || {
    variant: "default" as BadgeVariant,
    label: status,
  };

  return <Badge variant={config.variant}>{config.label}</Badge>;
}

// Difficulty Badge
export function DifficultyBadge({ difficulty }: { difficulty: string }) {
  const difficultyConfig: Record<
    string,
    { variant: BadgeVariant; label: string }
  > = {
    easy: { variant: "success", label: "初級" },
    medium: { variant: "warning", label: "中級" },
    hard: { variant: "danger", label: "上級" },
    expert: { variant: "primary", label: "エキスパート" },
  };

  const config = difficultyConfig[difficulty] || {
    variant: "default" as BadgeVariant,
    label: difficulty,
  };

  return <Badge variant={config.variant}>{config.label}</Badge>;
}

// Problem Type Badge
export function ProblemTypeBadge({ type }: { type: string }) {
  const typeConfig: Record<string, { variant: BadgeVariant; label: string }> = {
    gameday: { variant: "primary", label: "GameDay" },
    jam: { variant: "info", label: "JAM" },
  };

  const config = typeConfig[type] || {
    variant: "default" as BadgeVariant,
    label: type,
  };

  return <Badge variant={config.variant}>{config.label}</Badge>;
}
