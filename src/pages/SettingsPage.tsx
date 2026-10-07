import { useNavigate } from 'react-router-dom';
import { ArrowBackIcon, ChevronRightIcon } from '../components/icons';
import { IconButton } from '../components/ui';
import styles from './SettingsPage.module.css';

/**
 * 设置占位页：完整设置属于 M2，此处先提供「关于」入口（含开源许可列表）。
 */
export default function SettingsPage() {
  const navigate = useNavigate();
  return (
    <div className={styles.page}>
      <header className={styles.topBar}>
        <IconButton label="返回" onClick={() => navigate(-1)}>
          <ArrowBackIcon />
        </IconButton>
        <h1 className={styles.title}>设置</h1>
      </header>
      <div className={styles.content}>
        <button type="button" className={styles.row} onClick={() => navigate('/about')}>
          <span className={styles.rowLabel}>关于</span>
          <span className={styles.rowValue}>版本、开源许可</span>
          <ChevronRightIcon width={20} height={20} className={styles.chevron} />
        </button>
        <p className={styles.message}>该功能将在后续版本提供。</p>
      </div>
    </div>
  );
}
