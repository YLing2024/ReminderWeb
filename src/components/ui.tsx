import { useEffect, type ReactNode } from 'react';
import styles from './ui.module.css';

export function IconButton({
  label,
  onClick,
  children,
  pressed = false,
  disabled = false,
  className,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
  pressed?: boolean;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      className={[styles.iconButton, className].filter(Boolean).join(' ')}
      aria-label={label}
      aria-pressed={pressed}
      title={label}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={`${styles.toggle} ${checked ? styles.toggleOn : ''}`}
      onClick={() => onChange(!checked)}
    >
      <span className={styles.toggleThumb} />
    </button>
  );
}

export interface MenuItem {
  key: string;
  label: string;
  danger?: boolean;
  icon?: ReactNode;
  onSelect: () => void;
}

export function MenuOverlay({
  open,
  items,
  onClose,
  anchor,
}: {
  open: boolean;
  items: MenuItem[];
  onClose: () => void;
  anchor?: { x: number; y: number } | null;
}) {
  useEffect(() => {
    if (!open) return;
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className={styles.menuBackdrop} onClick={onClose} role="presentation">
      <div
        className={styles.menu}
        style={anchor ? { left: anchor.x, top: anchor.y, position: 'fixed', transform: 'none' } : undefined}
        onClick={(event) => event.stopPropagation()}
        role="menu"
      >
        {items.map((item) => (
          <button
            key={item.key}
            type="button"
            role="menuitem"
            className={`${styles.menuItem} ${item.danger ? styles.menuItemDanger : ''}`}
            onClick={() => {
              item.onSelect();
              onClose();
            }}
          >
            {item.icon}
            <span>{item.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmText = '确定',
  cancelText = '取消',
  danger = false,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  if (!open) return null;
  return (
    <div className={styles.dialogBackdrop} role="presentation" onClick={onCancel}>
      <div
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(event) => event.stopPropagation()}
      >
        <h2 className={styles.dialogTitle}>{title}</h2>
        <p className={styles.dialogMessage}>{message}</p>
        <div className={styles.dialogActions}>
          <button type="button" className={styles.textButton} onClick={onCancel}>
            {cancelText}
          </button>
          <button
            type="button"
            className={`${styles.textButton} ${danger ? styles.textButtonDanger : styles.textButtonPrimary}`}
            onClick={onConfirm}
          >
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  );
}

/** 设置项行：标题 + 副标题 + 右侧值/箭头。 */
export function SettingRow({
  title,
  subtitle,
  value,
  onClick,
  right,
}: {
  title: string;
  subtitle?: string;
  value?: string;
  onClick?: () => void;
  right?: ReactNode;
}) {
  const interactive = onClick !== undefined;
  return (
    <div
      className={`${styles.settingRow} ${interactive ? styles.settingRowInteractive : ''}`}
      onClick={onClick}
      role={interactive ? 'button' : undefined}
      tabIndex={interactive ? 0 : undefined}
      onKeyDown={
        interactive
          ? (event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                onClick();
              }
            }
          : undefined
      }
    >
      <div className={styles.settingText}>
        <span className={styles.settingTitle}>{title}</span>
        {subtitle !== undefined && <span className={styles.settingSubtitle}>{subtitle}</span>}
      </div>
      {value !== undefined && <span className={styles.settingValue}>{value}</span>}
      {right}
    </div>
  );
}
