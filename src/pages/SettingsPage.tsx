import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { argbFromHex, hexFromArgb } from '@material/material-color-utilities';
import {
  ArrowBackIcon,
  BellIcon,
  CalculatorIcon,
  CheckIcon,
  ChevronRightIcon,
  HomeIcon,
  LockIcon,
  PaletteIcon,
  StorageIcon,
  TagIcon,
} from '../components/icons';
import { ConfirmDialog, IconButton, Toggle } from '../components/ui';
import { SEED_PALETTES } from '../lib/theme';
import { hashPin, isValidPin, verifyPin } from '../lib/pin';
import { buildIcs } from '../lib/ics';
import { ensureLunar } from '../lib/lunar';
import { todayLocalDate } from '../lib/local-date';
import { useReminderStore } from '../store/useReminderStore';
import styles from './SettingsPage.module.css';

type ThemeOption = 'SYSTEM' | 'LIGHT' | 'DARK';
type DefaultPage = 'COUNTDOWN' | 'COUNTUP' | 'BIRTHDAY';

const THEME_OPTIONS: Array<{ value: ThemeOption; label: string }> = [
  { value: 'SYSTEM', label: '自动' },
  { value: 'LIGHT', label: '浅色' },
  { value: 'DARK', label: '深色' },
];

const DEFAULT_PAGE_OPTIONS: Array<{ value: DefaultPage; label: string }> = [
  { value: 'COUNTDOWN', label: '倒数日' },
  { value: 'COUNTUP', label: '正数日' },
  { value: 'BIRTHDAY', label: '生日' },
];

const SCROLL_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'NONE', label: '不隐藏' },
  { value: 'HIDE_TOP_BAR', label: '隐藏标题栏' },
  { value: 'HIDE_BOTTOM_BAR', label: '隐藏底栏' },
  { value: 'HIDE_BOTH', label: '隐藏标题和底栏' },
];

const CONFIRM_WORD = '清空';

function daysSince(timestamp: number | null): number | null {
  if (timestamp === null) return null;
  return Math.max(0, Math.floor((Date.now() - timestamp) / 86_400_000));
}

export default function SettingsPage() {
  const navigate = useNavigate();
  const settings = useReminderStore((state) => state.settings);
  const updateSettings = useReminderStore((state) => state.updateSettings);
  const resetAll = useReminderStore((state) => state.resetAll);
  const reminders = useReminderStore((state) => state.reminders);

  const [showScrollDialog, setShowScrollDialog] = useState(false);
  const [showClearDialog, setShowClearDialog] = useState(false);
  const [showPinDialog, setShowPinDialog] = useState(false);
  const [showDisablePin, setShowDisablePin] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const customSeedHex = useMemo(
    () => hexFromArgb(settings.customColorSeed ?? argbFromHex('#6750A4')),
    [settings.customColorSeed],
  );

  const backupDays = daysSince(settings.lastBackupAt);

  const onToggleNotification = async (next: boolean) => {
    if (!next) {
      await updateSettings({ notificationEnabled: false });
      return;
    }
    if (typeof Notification === 'undefined') {
      setNotice('当前浏览器不支持系统通知，将仅在应用内提示。');
      await updateSettings({ notificationEnabled: true });
      return;
    }
    if (Notification.permission === 'granted') {
      await updateSettings({ notificationEnabled: true });
      return;
    }
    const permission = await Notification.requestPermission();
    if (permission === 'granted') {
      await updateSettings({ notificationEnabled: true });
    } else {
      setNotice('未获得通知权限，可在浏览器地址栏的站点设置里重新开启。');
    }
  };

  const exportIcs = async () => {
    await ensureLunar();
    const content = buildIcs(reminders, todayLocalDate());
    const blob = new Blob([content], { type: 'text/calendar;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'reminder.ics';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    setNotice(`已导出 reminder.ics（${reminders.length} 条提醒）`);
  };

  const scrollLabel = SCROLL_OPTIONS.find((option) => option.value === settings.scrollBehavior)?.label ?? '隐藏底栏';

  return (
    <div className={styles.page}>
      <header className={styles.topBar}>
        <IconButton label="返回" onClick={() => navigate(-1)}>
          <ArrowBackIcon />
        </IconButton>
        <h1 className={styles.title}>设置</h1>
      </header>

      <div className={styles.content}>
        {notice !== null && (
          <div className={styles.notice} role="status">
            <span>{notice}</span>
            <button type="button" className={styles.noticeClose} onClick={() => setNotice(null)}>
              知道了
            </button>
          </div>
        )}

        <Group title="外观" icon={<PaletteIcon width={18} height={18} />}>
          <div className={styles.card}>
            <p className={styles.cardTitle}>主题</p>
            <Segmented
              options={THEME_OPTIONS}
              value={settings.themeOption}
              onChange={(value) => void updateSettings({ themeOption: value })}
            />
            <SwitchRow
              title="纯黑模式"
              description="深色模式下对 AMOLED 屏幕更省电"
              checked={settings.pureBlackEnabled}
              onChange={(value) => void updateSettings({ pureBlackEnabled: value })}
            />
            <SwitchRow
              title="卡片着色"
              description="基于主题色对卡片进行着色"
              checked={settings.cardColoringEnabled}
              onChange={(value) => void updateSettings({ cardColoringEnabled: value })}
            />
            <SwitchRow
              title="跟随种子色"
              description="浏览器无法读取系统壁纸，改为跟随下方种子色生成主题色"
              checked={settings.dynamicColorEnabled}
              onChange={(value) => void updateSettings({ dynamicColorEnabled: value })}
            />

            <p className={styles.subLabel}>种子色</p>
            <div className={styles.seedRow}>
              {SEED_PALETTES.map((palette) => {
                const selected = settings.dynamicColorEnabled && settings.themeColorPalette === palette.key;
                return (
                  <button
                    key={palette.key}
                    type="button"
                    className={styles.seedItem}
                    onClick={() =>
                      void updateSettings({ themeColorPalette: palette.key, dynamicColorEnabled: true })
                    }
                  >
                    <span
                      className={`${styles.seedDot} ${selected ? styles.seedDotActive : ''}`}
                      style={{ background: palette.seed }}
                    >
                      {selected && <CheckIcon width={20} height={20} style={{ color: '#fff' }} />}
                    </span>
                    <span className={selected ? styles.seedLabelActive : styles.seedLabel}>{palette.label}</span>
                  </button>
                );
              })}
              <label className={styles.seedItem}>
                <span
                  className={`${styles.seedDot} ${styles.seedCustom} ${
                    settings.dynamicColorEnabled && settings.themeColorPalette === 'CUSTOM' ? styles.seedDotActive : ''
                  }`}
                  style={{ background: customSeedHex }}
                >
                  {(settings.dynamicColorEnabled && settings.themeColorPalette === 'CUSTOM') && (
                    <CheckIcon width={20} height={20} style={{ color: '#fff' }} />
                  )}
                  <input
                    type="color"
                    className={styles.seedColorInput}
                    value={customSeedHex}
                    aria-label="自定义种子色"
                    onChange={(event) =>
                      void updateSettings({
                        themeColorPalette: 'CUSTOM',
                        customColorSeed: argbFromHex(event.target.value),
                        dynamicColorEnabled: true,
                      })
                    }
                  />
                </span>
                <span
                  className={
                    settings.dynamicColorEnabled && settings.themeColorPalette === 'CUSTOM'
                      ? styles.seedLabelActive
                      : styles.seedLabel
                  }
                >
                  自定义
                </span>
              </label>
            </div>
          </div>
        </Group>

        <Group title="首页" icon={<HomeIcon width={18} height={18} />}>
          <div className={styles.card}>
            <SwitchRow
              title="首页分类显示"
              description="开启后首页按倒数、正数、生日分类显示；关闭后所有事件统一显示"
              checked={settings.homeCategoryEnabled}
              onChange={(value) => void updateSettings({ homeCategoryEnabled: value })}
            />
            <div className={styles.subBlock}>
              <p className={styles.rowTitle}>默认起始页面</p>
              <p className={styles.rowDesc}>选择启动应用后默认显示的页面</p>
              <Segmented
                options={DEFAULT_PAGE_OPTIONS}
                value={settings.defaultPage}
                onChange={(value) => void updateSettings({ defaultPage: value })}
              />
            </div>
            <div className={styles.subBlock}>
              <p className={styles.rowTitle}>视图模式</p>
              <p className={styles.rowDesc}>首页卡片的默认排布方式</p>
              <Segmented
                options={[
                  { value: 'CARD', label: '卡片' },
                  { value: 'LIST', label: '列表' },
                ]}
                value={settings.viewMode === 'LIST' ? 'LIST' : 'CARD'}
                onChange={(value) => void updateSettings({ viewMode: value })}
              />
            </div>
            <ActionRow
              title="滚动收起策略"
              description="控制滑动时标题栏与底栏的显示行为"
              value={scrollLabel}
              onClick={() => setShowScrollDialog(true)}
            />
          </div>
        </Group>

        <Group title="提醒" icon={<BellIcon width={18} height={18} />}>
          <div className={styles.card}>
            <SwitchRow
              title="应用内通知"
              description="开启后需要浏览器通知权限，页面打开时才可送达"
              checked={settings.notificationEnabled}
              onChange={(value) => void onToggleNotification(value)}
            />
            <div className={styles.subBlock}>
              <p className={styles.rowTitle}>默认提前天数</p>
              <p className={styles.rowDesc}>新建提醒时提醒时刻的默认提前量</p>
              <div className={styles.numberRow}>
                <input
                  className={styles.numberInput}
                  type="number"
                  min={0}
                  max={365}
                  value={settings.defaultAdvanceDays}
                  onChange={(event) =>
                    void updateSettings({ defaultAdvanceDays: Math.max(0, Number(event.target.value) || 0) })
                  }
                />
                <span className={styles.numberUnit}>天</span>
              </div>
            </div>
            <div className={styles.subBlock}>
              <p className={styles.rowTitle}>提醒方式</p>
              <p className={styles.rowDesc}>
                「系统日历」在 Web 端改为导出 .ics 文件，可在系统日历中订阅或导入。
              </p>
              <Segmented
                options={[
                  { value: 'APP_NOTIFICATION', label: '应用内通知' },
                  { value: 'ICS', label: '导出 .ics' },
                ]}
                value={settings.reminderMethod}
                onChange={(value) => void updateSettings({ reminderMethod: value })}
              />
              {settings.reminderMethod === 'ICS' && (
                <ActionRow
                  title="导出 .ics 文件"
                  description="为所有提醒生成全天事件日历，可导入系统日历"
                  onClick={() => void exportIcs()}
                />
              )}
            </div>
          </div>
        </Group>

        <Group title="数据" icon={<StorageIcon width={18} height={18} />}>
          <div className={styles.card}>
            <ActionRow
              title="标签管理"
              description="管理、自定义颜色与排序分类标签"
              icon={<TagIcon width={20} height={20} />}
              onClick={() => navigate('/tags')}
            />
            <ActionRow
              title="日期计算"
              description="两个日期相差天数、目标日推算与农历换算"
              icon={<CalculatorIcon width={20} height={20} />}
              onClick={() => navigate('/calculator')}
            />
            <ActionRow
              title="备份与恢复"
              description="导入或导出与安卓互通的备份包"
              icon={<StorageIcon width={20} height={20} />}
              onClick={() => navigate('/backup')}
            />
            <div className={styles.subBlock}>
              <p className={styles.rowTitle}>备份提醒</p>
              <p className={styles.rowDesc}>
                {settings.lastBackupAt === null
                  ? '尚未备份'
                  : `上次备份：${new Date(settings.lastBackupAt).toLocaleString('zh-CN', { hour12: false })}`}
                {settings.backupReminderEnabled && backupDays !== null && ` · 已 ${backupDays} 天未备份`}
              </p>
              <SwitchRow
                title="定期提醒备份"
                description="开启后依据上次备份时间提示备份"
                checked={settings.backupReminderEnabled}
                onChange={(value) => void updateSettings({ backupReminderEnabled: value })}
              />
            </div>
            <ActionRow
              title="清空数据"
              description="删除全部提醒、标签与设置，不可撤销"
              danger
              onClick={() => setShowClearDialog(true)}
            />
          </div>
        </Group>

        <Group title="安全" icon={<LockIcon width={18} height={18} />}>
          <div className={styles.card}>
            <SwitchRow
              title="应用锁"
              description="开启后离开页面再回来需输入 PIN 解锁"
              checked={settings.appLockEnabled}
              onChange={(value) => {
                if (value) setShowPinDialog(true);
                else setShowDisablePin(true);
              }}
            />
            {settings.appLockEnabled && (
              <ActionRow title="修改 PIN 码" description="重新设置 4–6 位数字密码" onClick={() => setShowPinDialog(true)} />
            )}
          </div>
        </Group>

        <Group title="关于" icon={<ChevronRightIcon width={18} height={18} />}>
          <div className={styles.card}>
            <ActionRow title="关于 ReminderWeb" description="版本与开源许可" onClick={() => navigate('/about')} />
          </div>
        </Group>
      </div>

      {showScrollDialog && (
        <ChoiceDialog
          title="首页滑动模式"
          options={SCROLL_OPTIONS}
          value={settings.scrollBehavior}
          onSelect={(value) => void updateSettings({ scrollBehavior: value })}
          onClose={() => setShowScrollDialog(false)}
        />
      )}

      {showPinDialog && (
        <PinSetupDialog
          onClose={() => setShowPinDialog(false)}
          onSave={async (pin) => {
            await updateSettings({ appLockPinHash: await hashPin(pin), appLockEnabled: true });
            setShowPinDialog(false);
          }}
        />
      )}

      {showDisablePin && settings.appLockPinHash !== null && (
        <PinVerifyDialog
          onClose={() => setShowDisablePin(false)}
          onVerify={async (pin) => {
            const ok = await verifyPin(pin, settings.appLockPinHash!);
            if (ok) {
              await updateSettings({ appLockEnabled: false });
              setShowDisablePin(false);
            }
            return ok;
          }}
        />
      )}

      <ConfirmDialog
        open={showClearDialog}
        title="清空全部数据"
        message={`将删除全部提醒、标签与设置，此操作不可撤销。请输入「${CONFIRM_WORD}」以确认。`}
        confirmText="确认清空"
        danger
        requireText={CONFIRM_WORD}
        onCancel={() => setShowClearDialog(false)}
        onConfirm={() => {
          void resetAll();
          setShowClearDialog(false);
        }}
      />
    </div>
  );
}

function Group({ title, icon, children }: { title: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className={styles.group}>
      <h2 className={styles.groupTitle}>
        {icon}
        {title}
      </h2>
      <div className={styles.groupDivider} />
      {children}
    </section>
  );
}

function Segmented<T extends string>({
  options,
  value,
  onChange,
}: {
  options: Array<{ value: T; label: string }>;
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div className={styles.segmented} role="group">
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            className={active ? styles.segmentActive : styles.segment}
            aria-pressed={active}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

function SwitchRow({
  title,
  description,
  checked,
  onChange,
}: {
  title: string;
  description?: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <div className={styles.switchRow}>
      <div className={styles.rowText}>
        <p className={styles.rowTitle}>{title}</p>
        {description !== undefined && <p className={styles.rowDesc}>{description}</p>}
      </div>
      <Toggle checked={checked} onChange={onChange} label={title} />
    </div>
  );
}

function ActionRow({
  title,
  description,
  value,
  icon,
  danger = false,
  onClick,
}: {
  title: string;
  description?: string;
  value?: string;
  icon?: React.ReactNode;
  danger?: boolean;
  onClick: () => void;
}) {
  return (
    <button type="button" className={styles.actionRow} onClick={onClick}>
      {icon !== undefined && <span className={styles.actionIcon}>{icon}</span>}
      <span className={styles.rowText}>
        <span className={danger ? styles.rowTitleDanger : styles.rowTitle}>{title}</span>
        {description !== undefined && <span className={styles.rowDesc}>{description}</span>}
      </span>
      {value !== undefined && <span className={styles.actionValue}>{value}</span>}
      <ChevronRightIcon width={20} height={20} className={styles.chevron} />
    </button>
  );
}

function ChoiceDialog({
  title,
  options,
  value,
  onSelect,
  onClose,
}: {
  title: string;
  options: Array<{ value: string; label: string }>;
  value: string;
  onSelect: (value: string) => void;
  onClose: () => void;
}) {
  return (
    <div className={styles.dialogBackdrop} role="presentation" onClick={onClose}>
      <div className={styles.dialog} role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <h2 className={styles.dialogTitle}>{title}</h2>
        <div className={styles.choiceList}>
          {options.map((option) => (
            <button
              key={option.value}
              type="button"
              className={styles.choice}
              onClick={() => {
                onSelect(option.value);
                onClose();
              }}
            >
              <span className={option.value === value ? styles.radioOn : styles.radioOff} />
              {option.label}
            </button>
          ))}
        </div>
        <div className={styles.dialogActions}>
          <button type="button" className={styles.textButton} onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}

function PinSetupDialog({
  onClose,
  onSave,
}: {
  onClose: () => void;
  onSave: (pin: string) => Promise<void>;
}) {
  const [pin, setPin] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const valid = isValidPin(pin) && pin === confirm;

  return (
    <div className={styles.dialogBackdrop} role="presentation" onClick={onClose}>
      <div className={styles.dialog} role="dialog" aria-modal="true" aria-label="设置 PIN 码" onClick={(e) => e.stopPropagation()}>
        <h2 className={styles.dialogTitle}>设置 PIN 码</h2>
        <label className={styles.inputField}>
          <span className={styles.rowDesc}>4–6 位数字</span>
          <input
            className={styles.pinInput}
            type="password"
            inputMode="numeric"
            autoFocus
            maxLength={6}
            value={pin}
            onChange={(event) => {
              setError(null);
              setPin(event.target.value.replace(/\D/g, '').slice(0, 6));
            }}
          />
        </label>
        <label className={styles.inputField}>
          <span className={styles.rowDesc}>再次输入</span>
          <input
            className={styles.pinInput}
            type="password"
            inputMode="numeric"
            maxLength={6}
            value={confirm}
            onChange={(event) => {
              setError(null);
              setConfirm(event.target.value.replace(/\D/g, '').slice(0, 6));
            }}
          />
        </label>
        {error !== null && <p className={styles.dialogError}>{error}</p>}
        <div className={styles.dialogActions}>
          <button type="button" className={styles.textButton} onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className={`${styles.textButton} ${styles.textButtonPrimary}`}
            disabled={!valid}
            onClick={() => {
              if (!isValidPin(pin)) {
                setError('PIN 需为 4–6 位数字');
                return;
              }
              if (pin !== confirm) {
                setError('两次输入不一致');
                return;
              }
              void onSave(pin);
            }}
          >
            保存
          </button>
        </div>
      </div>
    </div>
  );
}

function PinVerifyDialog({
  onClose,
  onVerify,
}: {
  onClose: () => void;
  onVerify: (pin: string) => Promise<boolean>;
}) {
  const [pin, setPin] = useState('');
  const [error, setError] = useState(false);
  return (
    <div className={styles.dialogBackdrop} role="presentation" onClick={onClose}>
      <div className={styles.dialog} role="dialog" aria-modal="true" aria-label="验证 PIN 码" onClick={(e) => e.stopPropagation()}>
        <h2 className={styles.dialogTitle}>验证 PIN 码</h2>
        <p className={styles.rowDesc}>关闭应用锁前需验证当前 PIN。</p>
        <input
          className={styles.pinInput}
          type="password"
          inputMode="numeric"
          autoFocus
          maxLength={6}
          value={pin}
          onChange={(event) => {
            setError(false);
            setPin(event.target.value.replace(/\D/g, '').slice(0, 6));
          }}
        />
        {error && <p className={styles.dialogError}>PIN 码不正确</p>}
        <div className={styles.dialogActions}>
          <button type="button" className={styles.textButton} onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className={`${styles.textButton} ${styles.textButtonPrimary}`}
            disabled={pin.length < 4}
            onClick={() => {
              void onVerify(pin).then((ok) => {
                if (!ok) setError(true);
              });
            }}
          >
            确认
          </button>
        </div>
      </div>
    </div>
  );
}
