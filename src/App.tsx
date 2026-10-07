import { lazy, Suspense, useEffect } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import HomePage from './pages/HomePage';
import { useReminderStore } from './store/useReminderStore';

const EditPage = lazy(() => import('./pages/EditPage'));
const DetailPage = lazy(() => import('./pages/DetailPage'));
const PlaceholderPage = lazy(() => import('./pages/PlaceholderPage'));

export default function App() {
  const loaded = useReminderStore((state) => state.loaded);
  const hydrate = useReminderStore((state) => state.hydrate);

  useEffect(() => {
    if (!loaded) void hydrate();
  }, [loaded, hydrate]);

  return (
    <Suspense fallback={<div style={{ padding: 24, textAlign: 'center' }}>正在载入…</div>}>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/reminder/new" element={<EditPage />} />
        <Route path="/reminder/:id/edit" element={<EditPage />} />
        <Route path="/reminder/:id" element={<DetailPage />} />
        <Route path="/search" element={<PlaceholderPage title="搜索" />} />
        <Route path="/settings" element={<PlaceholderPage title="设置" />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Suspense>
  );
}
