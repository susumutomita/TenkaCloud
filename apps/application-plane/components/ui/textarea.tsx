/**
 * Textarea Component
 *
 * フォームテキストエリア用コンポーネント
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
  size?: TextareaSize;
  resize?: TextareaResize;
  label?: string;
  error?: string;
}

const variantClasses: Record<TextareaVariant, string> = {
  default: 'border-gray-300 focus:border-blue-500 focus:ring-blue-500',
  error: 'border-red-500 focus:border-red-500 focus:ring-red-500',
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
      size = 'md',
      resize = 'vertical',
      label,
      error,
      className = '',
      id,
      required,
      disabled,
      rows = 3,
      ...props
    },
    ref
  ) => {
    const generatedId = useId();
    const textareaId = id || generatedId;

    // error があれば error variant を適用
    const effectiveVariant = error ? 'error' : variant;

    const baseClasses =
      'block w-full rounded-lg border bg-white focus:outline-none focus:ring-2 focus:ring-offset-0 disabled:opacity-50 disabled:cursor-not-allowed transition-colors';

    return (
      <div className="w-full">
        {label && (
          <label
            htmlFor={textareaId}
            className="block text-sm font-medium text-gray-700 mb-1"
          >
            {label}
            {required && <span className="text-red-500 ml-1">*</span>}
          </label>
        )}
        <textarea
          ref={ref}
          id={textareaId}
          className={`${baseClasses} ${variantClasses[effectiveVariant]} ${sizeClasses[size]} ${resizeClasses[resize]} ${className}`}
          required={required}
          disabled={disabled}
          rows={rows}
          {...props}
        />
        {error && <p className="mt-1 text-sm text-red-500">{error}</p>}
      </div>
    );
  }
);

Textarea.displayName = 'Textarea';
