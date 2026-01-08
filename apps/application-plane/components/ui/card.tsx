/**
 * Card Component
 *
 * HybridNext Design System - Terminal Command Center style
 * Neo-brutalist cards with dark surfaces
 */

import type { ReactNode } from 'react';

type CardVariant = 'default' | 'brutal' | 'glass' | 'elevated';

interface CardProps {
  children: ReactNode;
  className?: string;
  onClick?: () => void;
  hoverable?: boolean;
  variant?: CardVariant;
}

const variantClasses: Record<CardVariant, string> = {
  default: [
    'bg-surface-1',
    'border border-border',
    'rounded-[var(--radius)]',
  ].join(' '),
  brutal: [
    'bg-surface-1',
    'border-2 border-border',
    'rounded-[var(--radius)]',
    'shadow-[3px_3px_0_var(--color-surface-0)]',
  ].join(' '),
  glass: [
    'bg-surface-1/70',
    'backdrop-blur-xl',
    'border border-border/50',
    'rounded-[var(--radius-lg)]',
  ].join(' '),
  elevated: [
    'bg-surface-elevated',
    'border border-border',
    'rounded-[var(--radius)]',
    'shadow-soft',
  ].join(' '),
};

const hoverVariantClasses: Record<CardVariant, string> = {
  default: 'hover:border-border-light hover:bg-surface-2',
  brutal:
    'hover:shadow-[2px_2px_0_var(--color-surface-0)] hover:translate-x-[1px] hover:translate-y-[1px]',
  glass: 'hover:bg-surface-1/80 hover:border-border/70',
  elevated: 'hover:shadow-md',
};

export function Card({
  children,
  className = '',
  onClick,
  hoverable = false,
  variant = 'default',
}: CardProps) {
  const baseClasses =
    'transition-all duration-[var(--animation-duration-fast)]';
  const hoverClasses = hoverable
    ? `${hoverVariantClasses[variant]} cursor-pointer`
    : '';
  const combinedClasses = `${baseClasses} ${variantClasses[variant]} ${hoverClasses} ${className}`;

  if (onClick) {
    return (
      <button
        type="button"
        className={combinedClasses}
        onClick={onClick}
        style={{ textAlign: 'inherit', display: 'block', width: '100%' }}
      >
        {children}
      </button>
    );
  }

  return <div className={combinedClasses}>{children}</div>;
}

interface CardHeaderProps {
  children: ReactNode;
  className?: string;
}

export function CardHeader({ children, className = '' }: CardHeaderProps) {
  return (
    <div className={`px-6 py-4 border-b border-border ${className}`}>
      {children}
    </div>
  );
}

interface CardTitleProps {
  children: ReactNode;
  className?: string;
}

export function CardTitle({ children, className = '' }: CardTitleProps) {
  return (
    <h3 className={`text-lg font-semibold text-text-primary ${className}`}>
      {children}
    </h3>
  );
}

interface CardDescriptionProps {
  children: ReactNode;
  className?: string;
}

export function CardDescription({
  children,
  className = '',
}: CardDescriptionProps) {
  return (
    <p className={`text-sm text-text-muted mt-1 ${className}`}>{children}</p>
  );
}

interface CardContentProps {
  children: ReactNode;
  className?: string;
}

export function CardContent({ children, className = '' }: CardContentProps) {
  return <div className={`px-6 py-4 ${className}`}>{children}</div>;
}

interface CardFooterProps {
  children: ReactNode;
  className?: string;
}

export function CardFooter({ children, className = '' }: CardFooterProps) {
  return (
    <div
      className={`px-6 py-4 border-t border-border bg-surface-0/50 rounded-b-[var(--radius)] ${className}`}
    >
      {children}
    </div>
  );
}
