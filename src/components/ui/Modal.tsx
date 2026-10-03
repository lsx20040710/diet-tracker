import { X } from 'lucide-react';
import { useEffect, useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

interface ModalProps {
  title: string;
  description?: string;
  open: boolean;
  onClose: () => void;
  /** 保存等不可中断操作执行时，同时锁定 Esc、遮罩和关闭按钮。 */
  closeDisabled?: boolean;
  children: ReactNode;
  widthClassName?: string;
}

/** 提供统一的桌面弹窗焦点区域，并允许使用 Esc 快速关闭。 */
export function Modal({
  title,
  description,
  open,
  onClose,
  closeDisabled = false,
  children,
  widthClassName = 'max-w-2xl',
}: ModalProps) {
  const dialogRef = useRef<HTMLElement>(null);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    if (!open) return;
    const dialog = dialogRef.current;
    const previousFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusableSelector = [
      'button:not([disabled])',
      'input:not([disabled])',
      'select:not([disabled])',
      'textarea:not([disabled])',
      'a[href]',
      '[tabindex]:not([tabindex="-1"])',
    ].join(',');

    const getFocusableElements = () =>
      dialog
        ? Array.from(dialog.querySelectorAll<HTMLElement>(focusableSelector)).filter(
            (element) => element.offsetParent !== null,
          )
        : [];

    // React 的 autoFocus 会先执行；没有自动焦点时再落到第一个可操作控件。
    const focusFrame = window.requestAnimationFrame(() => {
      if (!dialog || dialog.contains(document.activeElement)) return;
      (getFocusableElements()[0] ?? dialog).focus();
    });

    const handleKeyDown = (event: KeyboardEvent) => {
      if (!dialog) return;
      const dialogs = document.querySelectorAll<HTMLElement>('[role="dialog"]');
      if (dialogs.item(dialogs.length - 1) !== dialog) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        if (!closeDisabled) onClose();
        return;
      }
      if (event.key !== 'Tab') return;

      const focusableElements = getFocusableElements();
      if (focusableElements.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusableElements[0];
      const last = focusableElements[focusableElements.length - 1];
      const activeElement = document.activeElement;
      if (event.shiftKey && (activeElement === first || !dialog.contains(activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (activeElement === last || !dialog.contains(activeElement))) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      window.removeEventListener('keydown', handleKeyDown);
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, [closeDisabled, onClose, open]);

  if (!open) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/45 p-6 backdrop-blur-[2px]"
      role="presentation"
      onMouseDown={(event) => {
        if (!closeDisabled && event.currentTarget === event.target) onClose();
      }}
    >
      <section
        aria-describedby={description ? descriptionId : undefined}
        aria-labelledby={titleId}
        aria-modal="true"
        className={`max-h-[calc(100vh-3rem)] w-full overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl ${widthClassName}`}
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        <header className="flex items-start justify-between border-b border-slate-200 px-6 py-4">
          <div>
            <h2 className="text-lg font-semibold text-slate-900" id={titleId}>
              {title}
            </h2>
            {description ? (
              <p className="mt-1 text-sm text-slate-500" id={descriptionId}>
                {description}
              </p>
            ) : null}
          </div>
          <button
            aria-label="关闭弹窗"
            className="rounded-lg p-2 text-slate-500 transition hover:bg-slate-100 hover:text-slate-800 focus-visible:outline-2 focus-visible:outline-emerald-600 disabled:cursor-not-allowed disabled:opacity-40"
            disabled={closeDisabled}
            onClick={onClose}
            type="button"
          >
            <X className="size-5" />
          </button>
        </header>
        <div className="max-h-[calc(100vh-9rem)] overflow-y-auto p-6">{children}</div>
      </section>
    </div>,
    document.body,
  );
}
