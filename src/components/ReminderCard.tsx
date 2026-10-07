import { useRef } from 'react';
import type { ReminderItem, ReminderType } from '../types/reminder';
import { reminderDisplayInfo } from '../lib/display';
import type { LocalDate } from '../lib/local-date';
import styles from './ReminderCard.module.css';

const TYPE_COLOR: Record<ReminderType, string> = {
  ANNUAL: 'var(--type-annual)',
  COUNT_UP: 'var(--type-count-up)',
  BIRTHDAY: 'var(--type-birthday)',
};

function resolveBandColor(item: ReminderItem, tagColor: string | null): string {
  if (item.isCustomized && item.customHeaderColor.trim() !== '') {
    return item.customHeaderColor;
  }
  if (tagColor !== null) return tagColor;
  return TYPE_COLOR[item.type];
}

export function ReminderCard({
  item,
  today,
  tagColor = null,
  large = false,
  onOpen,
  onRequestMenu,
}: {
  item: ReminderItem;
  today: LocalDate;
  tagColor?: string | null;
  large?: boolean;
  onOpen: () => void;
  onRequestMenu?: (point: { x: number; y: number } | null) => void;
}) {
  const info = reminderDisplayInfo(item, today);
  const pressTimer = useRef<number | null>(null);
  const longPressed = useRef(false);
  const startPoint = useRef<{ x: number; y: number } | null>(null);

  const clearTimer = () => {
    if (pressTimer.current !== null) {
      window.clearTimeout(pressTimer.current);
      pressTimer.current = null;
    }
  };

  const handlePointerDown = (event: React.PointerEvent) => {
    if (onRequestMenu === undefined) return;
    longPressed.current = false;
    startPoint.current = { x: event.clientX, y: event.clientY };
    clearTimer();
    pressTimer.current = window.setTimeout(() => {
      longPressed.current = true;
      onRequestMenu(startPoint.current);
    }, 500);
  };

  const handlePointerMove = (event: React.PointerEvent) => {
    if (startPoint.current === null) return;
    const dx = event.clientX - startPoint.current.x;
    const dy = event.clientY - startPoint.current.y;
    if (Math.hypot(dx, dy) > 10) clearTimer();
  };

  return (
    <button
      type="button"
      className={`${styles.card} ${large ? styles.large : ''}`}
      onClick={() => {
        if (longPressed.current) {
          longPressed.current = false;
          return;
        }
        onOpen();
      }}
      onContextMenu={(event) => {
        if (onRequestMenu === undefined) return;
        event.preventDefault();
        onRequestMenu({ x: event.clientX, y: event.clientY });
      }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={clearTimer}
      onPointerCancel={clearTimer}
      onPointerLeave={clearTimer}
    >
      <div className={styles.band} style={{ background: resolveBandColor(item, tagColor) }}>
        <span className={styles.bandText}>{info.headerTitle}</span>
      </div>
      <div className={styles.body}>
        <span className={styles.number}>{info.isToday ? '今' : info.dayCount}</span>
        <span className={styles.unit}>天</span>
      </div>
      <div className={styles.footer}>
        <span className={styles.footerText}>{info.referenceText}</span>
      </div>
    </button>
  );
}
