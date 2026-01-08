/**
 * Button Component
 *
 * HybridNext Design System - Terminal Command Center style
 * Neo-brutalist buttons with muted accent colors
 */

import {
  Children,
  cloneElement,
  forwardRef,
  isValidElement,
  type ButtonHTMLAttributes,
  type ReactNode,
} from 'react';

type ButtonVariant =
  | 'primary'
  | 'secondary'
  | 'outline'
  | 'ghost'
  | 'danger'
  | 'success';
type ButtonSize = 'sm' | 'md' | 'lg';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  children: ReactNode;
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  fullWidth?: boolean;
  asChild?: boolean;
}

const variantClasses: Record<ButtonVariant, string> = {
  primary: [
    'bg-hn-accent text-surface-0',
    'hover:bg-hn-accent-bright',
    'active:translate-x-[1px] active:translate-y-[1px]',
    'shadow-[2px_2px_0_var(--color-hn-accent-dim)]',
    'hover:shadow-[1px_1px_0_var(--color-hn-accent-dim)]',
  ].join(' '),
  secondary: [
    'bg-surface-2 text-text-primary',
    'border-2 border-border',
    'hover:bg-surface-3 hover:border-border-light',
    'active:translate-x-[1px] active:translate-y-[1px]',
    'shadow-[2px_2px_0_var(--color-surface-0)]',
    'hover:shadow-[1px_1px_0_var(--color-surface-0)]',
  ].join(' '),
  outline: [
    'bg-transparent text-hn-accent',
    'border-2 border-hn-accent',
    'hover:bg-hn-accent/10',
    'active:bg-hn-accent/20',
  ].join(' '),
  ghost: [
    'bg-transparent text-text-secondary',
    'hover:bg-surface-2 hover:text-text-primary',
    'active:bg-surface-3',
  ].join(' '),
  danger: [
    'bg-hn-error text-surface-0',
    'hover:bg-hn-error/90',
    'active:translate-x-[1px] active:translate-y-[1px]',
    'shadow-[2px_2px_0_#8a4444]',
    'hover:shadow-[1px_1px_0_#8a4444]',
  ].join(' '),
  success: [
    'bg-hn-success text-surface-0',
    'hover:bg-hn-success/90',
    'active:translate-x-[1px] active:translate-y-[1px]',
    'shadow-[2px_2px_0_#7a8048]',
    'hover:shadow-[1px_1px_0_#7a8048]',
  ].join(' '),
};

const sizeClasses: Record<ButtonSize, string> = {
  sm: 'px-3 py-1.5 text-sm gap-1.5',
  md: 'px-4 py-2 text-base gap-2',
  lg: 'px-6 py-3 text-lg gap-2.5',
};

const baseClasses = [
  'inline-flex items-center justify-center',
  'font-semibold',
  'rounded-[var(--radius)]',
  'transition-all duration-[var(--animation-duration-fast)]',
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-hn-accent focus-visible:ring-offset-2 focus-visible:ring-offset-surface-0',
  'disabled:opacity-50 disabled:cursor-not-allowed disabled:shadow-none disabled:translate-x-0 disabled:translate-y-0',
].join(' ');

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      children,
      variant = 'primary',
      size = 'md',
      loading = false,
      fullWidth = false,
      asChild = false,
      className = '',
      disabled,
      ...props
    },
    ref
  ) => {
    const combinedClassName = `${baseClasses} ${variantClasses[variant]} ${sizeClasses[size]} ${fullWidth ? 'w-full' : ''} ${className}`;

    // asChild mode: render child with merged props
    if (asChild && isValidElement(children)) {
      const child = Children.only(children) as React.ReactElement<{
        className?: string;
        children?: ReactNode;
      }>;
      return cloneElement(child, {
        ...props,
        className: `${combinedClassName} ${child.props.className || ''}`.trim(),
        children: (
          <>
            {loading && <LoadingSpinner />}
            {child.props.children}
          </>
        ),
      });
    }

    return (
      <button
        ref={ref}
        className={combinedClassName}
        disabled={disabled || loading}
        {...props}
      >
        {loading && <LoadingSpinner />}
        {children}
      </button>
    );
  }
);

Button.displayName = 'Button';

function LoadingSpinner() {
  return (
    <svg
      className="animate-spin h-4 w-4"
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <circle
        className="opacity-25"
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="4"
      />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
      />
    </svg>
  );
}
