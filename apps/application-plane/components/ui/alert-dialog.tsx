/**
 * AlertDialog Component
 *
 * HybridNext Design System - Terminal Command Center style
 * Dark-themed modal dialogs with smooth animations
 */

'use client';

import type { HTMLAttributes, MouseEvent, ReactNode } from 'react';
import {
  createContext,
  forwardRef,
  useCallback,
  useContext,
  useEffect,
  useId,
  useState,
} from 'react';
import { createPortal } from 'react-dom';

// ============================================================================
// Context
// ============================================================================

interface AlertDialogContextValue {
  open: boolean;
  setOpen: (open: boolean) => void;
  titleId: string;
  descriptionId: string;
}

const AlertDialogContext = createContext<AlertDialogContextValue | null>(null);

function useAlertDialog() {
  const context = useContext(AlertDialogContext);
  if (!context) {
    throw new Error(
      'AlertDialog コンポーネントは AlertDialog 内で使用する必要があります'
    );
  }
  return context;
}

// ============================================================================
// AlertDialog
// ============================================================================

interface AlertDialogProps {
  children: ReactNode;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
}

function AlertDialog({
  children,
  open: controlledOpen,
  defaultOpen = false,
  onOpenChange,
}: AlertDialogProps) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);
  const titleId = useId();
  const descriptionId = useId();

  const isControlled = controlledOpen !== undefined;
  const open = isControlled ? controlledOpen : uncontrolledOpen;

  const setOpen = useCallback(
    (newOpen: boolean) => {
      if (!isControlled) {
        setUncontrolledOpen(newOpen);
      }
      onOpenChange?.(newOpen);
    },
    [isControlled, onOpenChange]
  );

  return (
    <AlertDialogContext.Provider
      value={{ open, setOpen, titleId, descriptionId }}
    >
      {children}
    </AlertDialogContext.Provider>
  );
}

// ============================================================================
// AlertDialogTrigger
// ============================================================================

interface AlertDialogTriggerProps extends HTMLAttributes<HTMLButtonElement> {
  children: ReactNode;
  asChild?: boolean;
}

const AlertDialogTrigger = forwardRef<
  HTMLButtonElement,
  AlertDialogTriggerProps
>(({ children, asChild = false, className = '', onClick, ...props }, ref) => {
  const { setOpen } = useAlertDialog();

  const handleClick = (e: MouseEvent<HTMLButtonElement>) => {
    onClick?.(e);
    setOpen(true);
  };

  if (asChild) {
    // asChild の場合、children を直接使用
    // children が button の場合、onClick を追加
    const child = children as React.ReactElement<{
      onClick?: (e: MouseEvent<HTMLButtonElement>) => void;
    }>;
    return (
      <>
        {/* biome-ignore lint/a11y/useKeyWithClickEvents: AlertDialogTrigger child handles its own keyboard events */}
        <span onClick={handleClick}>{child}</span>
      </>
    );
  }

  return (
    <button
      ref={ref}
      type="button"
      className={className}
      onClick={handleClick}
      {...props}
    >
      {children}
    </button>
  );
});
AlertDialogTrigger.displayName = 'AlertDialogTrigger';

// ============================================================================
// AlertDialogPortal
// ============================================================================

interface AlertDialogPortalProps {
  children: ReactNode;
}

function AlertDialogPortal({ children }: AlertDialogPortalProps) {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    return () => setMounted(false);
  }, []);

  if (!mounted) return null;

  return createPortal(children, document.body);
}

// ============================================================================
// AlertDialogOverlay
// ============================================================================

const AlertDialogOverlay = forwardRef<
  HTMLDivElement,
  HTMLAttributes<HTMLDivElement>
>(({ className = '', ...props }, ref) => (
  <div
    ref={ref}
    className={`fixed inset-0 z-[var(--z-overlay)] bg-surface-0/80 backdrop-blur-sm animate-in fade-in-0 duration-[var(--animation-duration-fast)] ${className}`}
    {...props}
  />
));
AlertDialogOverlay.displayName = 'AlertDialogOverlay';

// ============================================================================
// AlertDialogContent
// ============================================================================

interface AlertDialogContentProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
}

const AlertDialogContent = forwardRef<HTMLDivElement, AlertDialogContentProps>(
  ({ children, className = '', ...props }, ref) => {
    const { open, setOpen, titleId, descriptionId } = useAlertDialog();

    // Escape キーでダイアログを閉じる
    useEffect(() => {
      const handleKeyDown = (e: KeyboardEvent) => {
        if (e.key === 'Escape') {
          setOpen(false);
        }
      };

      if (open) {
        document.addEventListener('keydown', handleKeyDown);
        // body のスクロールを無効化
        document.body.style.overflow = 'hidden';
      }

      return () => {
        document.removeEventListener('keydown', handleKeyDown);
        document.body.style.overflow = '';
      };
    }, [open, setOpen]);

    if (!open) return null;

    return (
      <AlertDialogPortal>
        <AlertDialogOverlay onClick={() => setOpen(false)} />
        <div
          ref={ref}
          role="alertdialog"
          aria-modal="true"
          aria-labelledby={titleId}
          aria-describedby={descriptionId}
          className={`fixed left-1/2 top-1/2 z-[var(--z-modal)] grid w-full max-w-lg -translate-x-1/2 -translate-y-1/2 gap-4 border border-border bg-surface-1 p-6 shadow-lg rounded-[var(--radius-lg)] animate-in fade-in-0 zoom-in-95 slide-in-from-left-1/2 slide-in-from-top-[48%] duration-[var(--animation-duration-normal)] ${className}`}
          {...props}
        >
          {children}
        </div>
      </AlertDialogPortal>
    );
  }
);
AlertDialogContent.displayName = 'AlertDialogContent';

// ============================================================================
// AlertDialogHeader
// ============================================================================

const AlertDialogHeader = forwardRef<
  HTMLDivElement,
  HTMLAttributes<HTMLDivElement>
>(({ className = '', ...props }, ref) => (
  <div
    ref={ref}
    className={`flex flex-col space-y-2 text-center sm:text-left ${className}`}
    {...props}
  />
));
AlertDialogHeader.displayName = 'AlertDialogHeader';

// ============================================================================
// AlertDialogTitle
// ============================================================================

const AlertDialogTitle = forwardRef<
  HTMLHeadingElement,
  HTMLAttributes<HTMLHeadingElement>
>(({ className = '', ...props }, ref) => {
  const { titleId } = useAlertDialog();
  return (
    <h2
      ref={ref}
      id={titleId}
      className={`text-lg font-semibold text-text-primary ${className}`}
      {...props}
    />
  );
});
AlertDialogTitle.displayName = 'AlertDialogTitle';

// ============================================================================
// AlertDialogDescription
// ============================================================================

const AlertDialogDescription = forwardRef<
  HTMLParagraphElement,
  HTMLAttributes<HTMLParagraphElement>
>(({ className = '', ...props }, ref) => {
  const { descriptionId } = useAlertDialog();
  return (
    <p
      ref={ref}
      id={descriptionId}
      className={`text-sm text-text-muted ${className}`}
      {...props}
    />
  );
});
AlertDialogDescription.displayName = 'AlertDialogDescription';

// ============================================================================
// AlertDialogFooter
// ============================================================================

const AlertDialogFooter = forwardRef<
  HTMLDivElement,
  HTMLAttributes<HTMLDivElement>
>(({ className = '', ...props }, ref) => (
  <div
    ref={ref}
    className={`flex flex-col-reverse sm:flex-row sm:justify-end gap-2 ${className}`}
    {...props}
  />
));
AlertDialogFooter.displayName = 'AlertDialogFooter';

// ============================================================================
// AlertDialogCancel
// ============================================================================

const AlertDialogCancel = forwardRef<
  HTMLButtonElement,
  HTMLAttributes<HTMLButtonElement>
>(({ className = '', onClick, ...props }, ref) => {
  const { setOpen } = useAlertDialog();

  const handleClick = (e: MouseEvent<HTMLButtonElement>) => {
    onClick?.(e as unknown as MouseEvent<HTMLButtonElement>);
    setOpen(false);
  };

  return (
    <button
      ref={ref}
      type="button"
      className={`inline-flex h-10 items-center justify-center rounded-[var(--radius)] border border-border bg-surface-2 px-4 py-2 text-sm font-medium text-text-primary hover:bg-surface-3 focus:outline-none focus-visible:ring-2 focus-visible:ring-hn-accent focus-visible:ring-offset-2 focus-visible:ring-offset-surface-1 transition-colors duration-[var(--animation-duration-fast)] ${className}`}
      onClick={handleClick}
      {...props}
    />
  );
});
AlertDialogCancel.displayName = 'AlertDialogCancel';

// ============================================================================
// AlertDialogAction
// ============================================================================

type AlertDialogActionVariant = 'danger' | 'primary';

interface AlertDialogActionProps extends HTMLAttributes<HTMLButtonElement> {
  variant?: AlertDialogActionVariant;
}

const variantClasses: Record<AlertDialogActionVariant, string> = {
  danger: [
    'bg-hn-error text-surface-0',
    'hover:bg-hn-error/90',
    'focus-visible:ring-hn-error',
    'shadow-[2px_2px_0_#8a4444]',
    'hover:shadow-[1px_1px_0_#8a4444]',
    'active:translate-x-[1px] active:translate-y-[1px] active:shadow-none',
  ].join(' '),
  primary: [
    'bg-hn-accent text-surface-0',
    'hover:bg-hn-accent-bright',
    'focus-visible:ring-hn-accent',
    'shadow-[2px_2px_0_var(--color-hn-accent-dim)]',
    'hover:shadow-[1px_1px_0_var(--color-hn-accent-dim)]',
    'active:translate-x-[1px] active:translate-y-[1px] active:shadow-none',
  ].join(' '),
};

const AlertDialogAction = forwardRef<HTMLButtonElement, AlertDialogActionProps>(
  ({ className = '', variant = 'danger', onClick, ...props }, ref) => {
    const { setOpen } = useAlertDialog();

    const handleClick = (e: MouseEvent<HTMLButtonElement>) => {
      onClick?.(e as unknown as MouseEvent<HTMLButtonElement>);
      setOpen(false);
    };

    return (
      <button
        ref={ref}
        type="button"
        className={`inline-flex h-10 items-center justify-center rounded-[var(--radius)] px-4 py-2 text-sm font-semibold focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-surface-1 transition-all duration-[var(--animation-duration-fast)] ${variantClasses[variant]} ${className}`}
        onClick={handleClick}
        {...props}
      />
    );
  }
);
AlertDialogAction.displayName = 'AlertDialogAction';

// ============================================================================
// Exports
// ============================================================================

export {
  AlertDialog,
  AlertDialogTrigger,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
};
