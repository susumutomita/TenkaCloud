/**
 * Card Component
 *
 * 汎用カードコンポーネント
 */

import type { ReactNode } from 'react';

interface CardProps {
  children: ReactNode;
  className?: string;
  onClick?: () => void;
  hoverable?: boolean;
}

export function Card({
  children,
  className = '',
  onClick,
  hoverable = false,
}: CardProps) {
  const baseClasses = 'bg-white rounded-lg border border-gray-200 shadow-sm';
  const hoverClasses = hoverable
    ? 'hover:shadow-md hover:border-gray-300 transition-all cursor-pointer'
    : '';
  const combinedClasses = `${baseClasses} ${hoverClasses} ${className}`;

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
    <div className={`px-6 py-4 border-b border-gray-200 ${className}`}>
      {children}
    </div>
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
      className={`px-6 py-4 border-t border-gray-200 bg-gray-50 rounded-b-lg ${className}`}
    >
      {children}
    </div>
  );
}
