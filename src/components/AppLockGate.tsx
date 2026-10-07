import { useEffect, useRef, useState } from 'react';
import { LockIcon } from './icons';
import { verifyPin } from '../lib/pin';
import { useReminderStore } from '../store/useReminderStore';
import styles from './AppLockGate.module.css';

/**
 * 应用锁：开启后，应用启动或从后台切回（页面重新可见）时需输入 PIN 解锁。
 * 未设置 PIN 或功能关闭时不拦截。
 */
export function AppLockGate({ children }: { children: React.ReactNode }) {
  const loaded = useReminderStore((state) => state.loaded);
  const settings = useReminderStore((state) => state.settings);
  const [locked, setLocked] = useState(true);
  const wasHidden = useRef(false);

  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        wasHidden.current = true;
      } else if (wasHidden.current) {
        wasHidden.current = false;
        setLocked(true);
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  const active = loaded && settings.appLockEnabled && settings.appLockPinHash !== null;
  const pinHash = settings.appLockPinHash;
  if (!active || pinHash === null || !locked) return <>{children}</>;

  return (
    <div className={styles.page}>
      <div className={styles.card}>
        <span className={styles.icon}>
          <LockIcon width={40} height={40} />
        </span>
        <h1 className={styles.title}>输入 PIN 解锁</h1>
        <p className={styles.hint}>已开启应用锁</p>
        <UnlockForm hash={pinHash} onUnlock={() => setLocked(false)} />
      </div>
    </div>
  );
}

function UnlockForm({ hash, onUnlock }: { hash: string; onUnlock: () => void }) {
  const [pin, setPin] = useState('');
  const [error, setError] = useState(false);
  const [checking, setChecking] = useState(false);

  const submit = async () => {
    if (checking) return;
    setChecking(true);
    const ok = await verifyPin(pin, hash);
    setChecking(false);
    if (ok) {
      setPin('');
      onUnlock();
    } else {
      setError(true);
      setPin('');
    }
  };

  return (
    <form
      className={styles.form}
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <input
        className={styles.input}
        type="password"
        inputMode="numeric"
        autoComplete="off"
        autoFocus
        maxLength={6}
        placeholder="····"
        aria-label="PIN 码"
        value={pin}
        onChange={(event) => {
          setError(false);
          setPin(event.target.value.replace(/\D/g, '').slice(0, 6));
        }}
      />
      {error && <p className={styles.error}>PIN 码不正确</p>}
      <button type="submit" className={styles.submit} disabled={pin.length < 4 || checking}>
        解锁
      </button>
    </form>
  );
}
