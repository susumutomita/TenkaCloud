/**
 * Input Component
 *
 * HybridNext Design System - Terminal Command Center style
 * Dark-themed form inputs with accent focus states
 */

import { forwardRef, useId, type InputHTMLAttributes } from 'react';

type InputVariant = 'default' | 'error';
type InputSize = 'sm' | 'md' | 'lg';

interface InputProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  'size'
> {
  variant?: InputVariant;
  inputSize?: InputSize;
  label?: string;
  error?: string;
  hint?: string;
}

const variantClasses: Record<InputVariant, string> = {
  default: [
    'border-border',
    'focus:border-hn-accent',
    'focus:ring-hn-accent/20',
  ].join(' '),
  error: [
    'border-hn-error',
    'focus:border-hn-error',
    'focus:ring-hn-error/20',
  ].join(' '),
};

const sizeClasses: Record<InputSize, string> = {
  sm: 'px-3 py-1.5 text-sm',
  md: 'px-4 py-2 text-base',
  lg: 'px-4 py-3 text-lg',
};

export const Input = forwardRef<HTMLInputElement, InputProps>(
  (
    {
      variant = 'default',
      inputSize = 'md',
      label,
      error,
      hint,
      className = '',
      id,
      required,
      disabled,
      ...props
    },
    ref
  ) => {
    const generatedId = useId();
    const inputId = id || generatedId;

    // error があれば error variant を適用
    const effectiveVariant = error ? 'error' : variant;

    const baseClasses = [
      'block w-full',
      'rounded-[var(--radius)]',
      'border',
      'bg-surface-1',
      'text-text-primary',
      'placeholder:text-text-muted',
      'focus:outline-none focus:ring-2 focus:ring-offset-0 focus:ring-offset-surface-0',
      'disabled:opacity-50 disabled:cursor-not-allowed disabled:bg-surface-2',
      'transition-all duration-[var(--animation-duration-fast)]',
    ].join(' ');

    return (
      <div className="w-full">
        {label && (
          <label
            htmlFor={inputId}
            className="block text-sm font-medium text-text-secondary mb-1.5"
          >
            {label}
            {required && <span className="text-hn-error ml-1">*</span>}
          </label>
        )}
        <input
          ref={ref}
          id={inputId}
          className={`${baseClasses} ${variantClasses[effectiveVariant]} ${sizeClasses[inputSize]} ${className}`}
          required={required}
          disabled={disabled}
          {...props}
        />
        {hint && !error && (
          <p className="mt-1.5 text-sm text-text-muted">{hint}</p>
        )}
        {error && (
          <p className="mt-1.5 text-sm text-hn-error flex items-center gap-1">
            <svg
              className="w-4 h-4 shrink-0"
              viewBox="0 0 20 20"
              fill="currentColor"
              aria-hidden="true"
            >
              <path
                fillRule="evenodd"
                d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z"
                clipRule="evenodd"
              />
            </svg>
            {error}
          </p>
        )}
      </div>
    );
  }
);

Input.displayName = 'Input';
