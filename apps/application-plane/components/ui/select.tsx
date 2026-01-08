/**
 * Select Component
 *
 * HybridNext Design System - Terminal Command Center style
 * Dark-themed select dropdowns with custom arrow styling
 */

import { forwardRef, useId, type SelectHTMLAttributes } from 'react';

type SelectVariant = 'default' | 'error';
type SelectSize = 'sm' | 'md' | 'lg';

interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

interface SelectProps extends Omit<
  SelectHTMLAttributes<HTMLSelectElement>,
  'size'
> {
  options: SelectOption[];
  variant?: SelectVariant;
  selectSize?: SelectSize;
  label?: string;
  error?: string;
  hint?: string;
  placeholder?: string;
}

const variantClasses: Record<SelectVariant, string> = {
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

const sizeClasses: Record<SelectSize, string> = {
  sm: 'px-3 py-1.5 text-sm pr-9',
  md: 'px-4 py-2 text-base pr-10',
  lg: 'px-4 py-3 text-lg pr-11',
};

export const Select = forwardRef<HTMLSelectElement, SelectProps>(
  (
    {
      options,
      variant = 'default',
      selectSize = 'md',
      label,
      error,
      hint,
      placeholder,
      className = '',
      id,
      required,
      disabled,
      ...props
    },
    ref
  ) => {
    const generatedId = useId();
    const selectId = id || generatedId;

    // error があれば error variant を適用
    const effectiveVariant = error ? 'error' : variant;

    const baseClasses = [
      'block w-full',
      'rounded-[var(--radius)]',
      'border',
      'bg-surface-1',
      'text-text-primary',
      'focus:outline-none focus:ring-2 focus:ring-offset-0 focus:ring-offset-surface-0',
      'disabled:opacity-50 disabled:cursor-not-allowed disabled:bg-surface-2',
      'transition-all duration-[var(--animation-duration-fast)]',
      'appearance-none bg-no-repeat',
    ].join(' ');

    // Custom dropdown arrow using CSS with HybridNext color
    const arrowStyle = {
      backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' fill='none' viewBox='0 0 24 24' stroke='%236c7a80'%3E%3Cpath stroke-linecap='round' stroke-linejoin='round' stroke-width='2' d='M19 9l-7 7-7-7'%3E%3C/path%3E%3C/svg%3E")`,
      backgroundSize: '1.25rem',
      backgroundPosition: 'right 0.5rem center',
    };

    return (
      <div className="w-full">
        {label && (
          <label
            htmlFor={selectId}
            className="block text-sm font-medium text-text-secondary mb-1.5"
          >
            {label}
            {required && <span className="text-hn-error ml-1">*</span>}
          </label>
        )}
        <select
          ref={ref}
          id={selectId}
          className={`${baseClasses} ${variantClasses[effectiveVariant]} ${sizeClasses[selectSize]} ${className}`}
          style={arrowStyle}
          required={required}
          disabled={disabled}
          {...props}
        >
          {placeholder && (
            <option value="" disabled={required} className="text-text-muted">
              {placeholder}
            </option>
          )}
          {options.map((option) => (
            <option
              key={option.value}
              value={option.value}
              disabled={option.disabled}
            >
              {option.label}
            </option>
          ))}
        </select>
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

Select.displayName = 'Select';
