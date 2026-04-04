/**
 * Textarea Component
 *
 * HybridNext Design System - Terminal Command Center style
 * Dark-themed multiline text inputs
 */

import { forwardRef, useId, type TextareaHTMLAttributes } from 'react';

type TextareaVariant = 'default' | 'error';
type TextareaSize = 'sm' | 'md' | 'lg';
type TextareaResize = 'none' | 'vertical' | 'horizontal' | 'both';

interface TextareaProps extends Omit<
  TextareaHTMLAttributes<HTMLTextAreaElement>,
  'size'
> {
  variant?: TextareaVariant;
  textareaSize?: TextareaSize;
  resize?: TextareaResize;
  label?: string;
  error?: string;
  hint?: string;
  charCount?: boolean;
  maxLength?: number;
}

const variantClasses: Record<TextareaVariant, string> = {
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

const sizeClasses: Record<TextareaSize, string> = {
  sm: 'px-3 py-1.5 text-sm',
  md: 'px-4 py-2 text-base',
  lg: 'px-4 py-3 text-lg',
};

const resizeClasses: Record<TextareaResize, string> = {
  none: 'resize-none',
  vertical: 'resize-y',
  horizontal: 'resize-x',
  both: 'resize',
};

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(
  (
    {
      variant = 'default',
      textareaSize = 'md',
      resize = 'vertical',
      label,
      error,
      hint,
      charCount = false,
      maxLength,
      className = '',
      id,
      required,
      disabled,
      rows = 3,
      value,
      defaultValue,
      ...props
    },
    ref
  ) => {
    const generatedId = useId();
    const textareaId = id || generatedId;

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

    // 文字数カウント用
    const currentLength = String(value ?? defaultValue ?? '').length;

    return (
      <div className="w-full">
        {label && (
          <label
            htmlFor={textareaId}
            className="block text-sm font-medium text-text-secondary mb-1.5"
          >
            {label}
            {required && <span className="text-hn-error ml-1">*</span>}
          </label>
        )}
        <textarea
          ref={ref}
          id={textareaId}
          className={`${baseClasses} ${variantClasses[effectiveVariant]} ${sizeClasses[textareaSize]} ${resizeClasses[resize]} ${className}`}
          required={required}
          disabled={disabled}
          rows={rows}
          maxLength={maxLength}
          value={value}
          defaultValue={defaultValue}
          {...props}
        />
        <div className="flex justify-between items-center mt-1.5">
          <div>
            {hint && !error && (
              <p className="text-sm text-text-muted">{hint}</p>
            )}
            {error && (
              <p className="text-sm text-hn-error flex items-center gap-1">
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
          {charCount && maxLength && (
            <span
              className={`text-sm font-mono ${
                currentLength >= maxLength
                  ? 'text-hn-error'
                  : currentLength >= maxLength * 0.9
                    ? 'text-hn-warning'
                    : 'text-text-muted'
              }`}
            >
              {currentLength}/{maxLength}
            </span>
          )}
        </div>
      </div>
    );
  }
);

Textarea.displayName = 'Textarea';
