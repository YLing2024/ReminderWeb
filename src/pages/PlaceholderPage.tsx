import { useNavigate } from 'react-router-dom';
import { ArrowBackIcon } from '../components/icons';
import { IconButton } from '../components/ui';
import styles from './PlaceholderPage.module.css';

/**
 * 搜索 / 设置入口的占位页：这两项属于 M2，此处仅保证顶栏入口可达、不出现死链。
 */
export default function PlaceholderPage({ title }: { title: string }) {
  const navigate = useNavigate();
  return (
    <div className={styles.page}>
      <header className={styles.topBar}>
        <IconButton label="返回" onClick={() => navigate(-1)}>
          <ArrowBackIcon />
        </IconButton>
        <h1 className={styles.title}>{title}</h1>
      </header>
      <div className={styles.body}>
        <p className={styles.message}>该功能将在后续版本提供。</p>
      </div>
    </div>
  );
}
